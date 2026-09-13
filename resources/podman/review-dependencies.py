"""Trusted offline dependency snapshot helper. Never imports project Python code.

Source and destination are container paths. Preserve Linux links/modes, enforce
bounded inventories, and never dereference a link while copying source bytes.
"""
import hashlib
import json
import os
import stat
import sys
import time

ROOTS = ("node_modules", ".venv", "venv", "dist", "build")
source, destination, max_files, max_bytes, timeout = sys.argv[1:]
max_files, max_bytes = int(max_files), int(max_bytes)
deadline = time.monotonic() + float(timeout)
digest = hashlib.sha256()
files = total = 0
present = []

def within(root, target):
    return os.path.commonpath((root, target)) == root

def visit(relative):
    global files, total
    if time.monotonic() > deadline:
        raise RuntimeError("Review dependency preparation timed out")
    origin = os.path.join(source, relative)
    info = os.lstat(origin)
    files += 1
    if files > max_files:
        raise RuntimeError("Review dependencies exceed file budget")
    kind = "link" if stat.S_ISLNK(info.st_mode) else "dir" if stat.S_ISDIR(info.st_mode) else "file"
    digest.update(json.dumps([relative, kind, info.st_mode & 0o777], separators=(",", ":")).encode())
    target = os.path.join(destination, relative) if destination else None
    if kind == "link":
        link = os.readlink(origin)
        resolved = os.path.realpath(origin)
        # Internal dependency links and container system runtime links are safe.
        # Do not copy source, credentials, or another checkout through a link.
        allowed = any(within(os.path.join(source, name), resolved) for name in ROOTS)
        allowed = allowed or any(within(p, resolved) for p in ("/usr", "/lib", "/lib64", "/bin", "/opt"))
        if not allowed or not os.path.exists(resolved):
            raise RuntimeError("Dependency link escapes its container snapshot: " + relative)
        digest.update(link.encode())
        if target:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.symlink(link, target)
    elif kind == "dir":
        if target:
            os.makedirs(target, exist_ok=True)
            os.chmod(target, 0o700)
        for name in sorted(os.listdir(origin)):
            if name not in (".git", ".easycode", ".easy_code"):
                visit(os.path.join(relative, name))
        if target:
            os.chmod(target, info.st_mode & 0o777)
    else:
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("Unsupported dependency entry: " + relative)
        total += info.st_size
        if total > max_bytes:
            raise RuntimeError("Review dependencies exceed byte budget")
        fd = os.open(origin, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if (before.st_dev, before.st_ino, before.st_size) != (info.st_dev, info.st_ino, info.st_size):
                raise RuntimeError("Dependency changed during snapshot")
            content_hash = hashlib.sha256()
            copied = 0
            output = open(target, "xb") if target else None
            try:
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > info.st_size or time.monotonic() > deadline:
                        raise RuntimeError("Dependency changed or exceeded time budget")
                    content_hash.update(chunk)
                    if output:
                        output.write(chunk)
            finally:
                if output:
                    output.close()
            after = os.fstat(stream.fileno())
            if copied != info.st_size or after.st_mtime_ns != before.st_mtime_ns:
                raise RuntimeError("Dependency changed during snapshot")
            digest.update(content_hash.digest())
        if target:
            os.chmod(target, info.st_mode & 0o777)

for name in ROOTS:
    if os.path.lexists(os.path.join(source, name)):
        # A dependency root cannot itself point at some other checkout.
        if not stat.S_ISDIR(os.lstat(os.path.join(source, name)).st_mode):
            raise RuntimeError("Dependency root must be a directory: " + name)
        present.append(name)
        visit(name)
print(json.dumps({"digest": digest.hexdigest(), "names": present}))
