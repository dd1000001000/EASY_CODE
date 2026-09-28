"""Bounded, binary Docker workspace transfers; never replay a partial import."""
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading


MAX_ARCHIVE_BYTES = 768 * 1024 * 1024
TRANSFER_TIMEOUT_SECONDS = 300
CHUNK_BYTES = 1024 * 1024


class WorkspaceArchiveError(RuntimeError):
    pass


def validate_archive(source, *, max_bytes=MAX_ARCHIVE_BYTES):
    """Check the entire uncompressed tar, including payloads and EOF padding.

    Do not extract on the host: task archives contain Linux paths and symlinks.
    Copy/export policies remain the caller's responsibility.
    """
    source = Path(source)
    size = source.stat().st_size
    if size > max_bytes or size < 1024 or size % 512:
        raise WorkspaceArchiveError(f"Invalid workspace archive size: {size} bytes (limit {max_bytes})")
    try:
        with tarfile.open(source, "r:") as archive:
            for member in archive:
                if member.isfile():
                    with archive.extractfile(member) as content:
                        while content.read(CHUNK_BYTES):
                            pass
            end = archive.offset
        # tarfile alone accepts missing EOF blocks and ignores trailing garbage.
        with source.open("rb") as stream:
            stream.seek(end)
            if size - end < 1024:
                raise ValueError("missing two tar EOF blocks")
            for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
                if block.strip(b"\0"):
                    raise ValueError("nonzero data after tar end")
    except (tarfile.TarError, ValueError, EOFError) as error:
        raise WorkspaceArchiveError(f"Invalid workspace archive ({size} bytes): {error}") from error


def _stderr_tail(stream):
    stream.seek(0, 2)
    stream.seek(max(0, stream.tell() - 4096))
    return stream.read().decode("utf-8", "replace").strip()


def copy_archive_out(container, target, root="/testbed", *,
                     max_bytes=MAX_ARCHIVE_BYTES, timeout=TRANSFER_TIMEOUT_SECONDS):
    target = Path(target)
    # Only the parent writes this file. Docker writes a binary pipe, avoiding
    # shared file-position operations on an inherited Windows output handle.
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".", suffix=".pending", delete=False) as output:
        pending = Path(output.name)
    try:
        with pending.open("wb") as output, tempfile.TemporaryFile() as errors:
            proc = subprocess.Popen(["docker", "cp", f"{container}:{root}/.", "-"],
                                    stdout=subprocess.PIPE, stderr=errors)
            timed_out = threading.Event()

            def expire():
                if proc.poll() is None:
                    timed_out.set()
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass

            timer = threading.Timer(timeout, expire)
            timer.daemon = True
            timer.start()
            try:
                count = 0
                while True:
                    chunk = proc.stdout.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > max_bytes:
                        raise WorkspaceArchiveError(f"Workspace archive export exceeded {max_bytes} bytes")
                    output.write(chunk)
                proc.wait()
                if timed_out.is_set() or proc.returncode:
                    status = f"timed out after {timeout}s" if timed_out.is_set() else f"exit {proc.returncode}"
                    raise WorkspaceArchiveError(f"Workspace archive export from {container} failed ({status}): {_stderr_tail(errors)}")
            finally:
                timer.cancel()
                timer.join()
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
                proc.stdout.close()
        validate_archive(pending, max_bytes=max_bytes)
        pending.replace(target)
    finally:
        pending.unlink(missing_ok=True)


def copy_archive_in(container, source, root="/testbed", *, timeout=TRANSFER_TIMEOUT_SECONDS):
    source = Path(source)
    # Validate before dispatch: malformed/truncated archives must not partially
    # modify a live worker or the verifier. Import errors are never retried.
    validate_archive(source)
    with source.open("rb") as stream, tempfile.TemporaryFile() as errors:
        try:
            result = subprocess.run(["docker", "cp", "-", f"{container}:{root}"],
                                    stdin=stream, stdout=subprocess.DEVNULL, stderr=errors, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise WorkspaceArchiveError(
                f"Workspace archive import to {container}:{root} timed out after {timeout}s; "
                f"destination may be partially written; no automatic replay. {_stderr_tail(errors)}") from error
        if result.returncode:
            raise WorkspaceArchiveError(
                f"Workspace archive import to {container}:{root} failed (exit {result.returncode}, "
                f"{source.stat().st_size} bytes); destination may be partially written; "
                f"no automatic replay. {_stderr_tail(errors)}")
