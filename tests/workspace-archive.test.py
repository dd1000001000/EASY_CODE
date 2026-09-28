"""Archive transport regression tests: real pipes/processes, no Docker required."""
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmarks.swebench_verified import workspace_archive as transport


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.tar"
        self.target = self.root / "target.tar"
        with tarfile.open(self.source, "w", format=tarfile.PAX_FORMAT) as archive:
            for name in ("file.bin", "路径/" + "long-name-" * 30):
                member = tarfile.TarInfo(name)
                data = bytes(range(256)) * 20
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            link = tarfile.TarInfo("link")
            link.type = tarfile.SYMTYPE
            link.linkname = "file.bin"
            archive.addfile(link)

    def export_with(self, code, **options):
        original = subprocess.Popen
        def launch(command, **kwargs):
            self.assertEqual(command[:2], ["docker", "cp"])
            self.assertEqual(kwargs["stdout"], subprocess.PIPE)
            return original([sys.executable, "-c", code], **kwargs)
        with patch.object(transport.subprocess, "Popen", side_effect=launch):
            transport.copy_archive_out("source-container", self.target, **options)

    def test_binary_roundtrip_atomic_publish_and_unix_links(self):
        self.target.write_bytes(b"old snapshot")
        self.export_with(f"import sys; sys.stdout.buffer.write(open({str(self.source)!r},'rb').read())")
        self.assertEqual(self.source.read_bytes(), self.target.read_bytes())
        self.assertEqual(list(self.root.glob("*.pending")), [])

    def test_export_failure_preserves_snapshot_and_stderr(self):
        self.target.write_bytes(b"old snapshot")
        with self.assertRaisesRegex(transport.WorkspaceArchiveError, "export.*exit 7.*specific failure"):
            self.export_with("import sys; sys.stderr.write('specific failure'); sys.exit(7)")
        self.assertEqual(self.target.read_bytes(), b"old snapshot")
        self.assertEqual(list(self.root.glob("*.pending")), [])

    def test_fast_oversize_export_is_rejected(self):
        with self.assertRaisesRegex(transport.WorkspaceArchiveError, "exceeded 1024 bytes"):
            self.export_with("import sys; sys.stdout.buffer.write(b'x'*4096)", max_bytes=1024)
        self.assertFalse(self.target.exists())

    def test_silent_export_times_out_and_reaps_child(self):
        with self.assertRaisesRegex(transport.WorkspaceArchiveError, "timed out"):
            self.export_with("import time; time.sleep(30)", timeout=0.2)
        self.assertEqual(list(self.root.glob("*.pending")), [])

    def test_success_exit_with_bad_archive_is_not_published(self):
        with self.assertRaises(transport.WorkspaceArchiveError):
            self.export_with("import sys; sys.stdout.buffer.write(b'x'*2048)")
        self.assertFalse(self.target.exists())

    def test_corrupt_or_truncated_archives_never_dispatch_import(self):
        data = self.source.read_bytes()
        with tarfile.open(self.source) as archive:
            list(archive)
            end = archive.offset
        variants = [b"", data[:700], data[:1024], b"x" + data[1:],
                    data[:end], data[:end + 512], data + b"x" * 512]
        for value in variants:
            with self.subTest(size=len(value)), patch.object(transport.subprocess, "run") as run:
                self.target.write_bytes(value)
                with self.assertRaises(transport.WorkspaceArchiveError):
                    transport.copy_archive_in("target-container", self.target)
                run.assert_not_called()

    def test_empty_tar_is_valid(self):
        with tarfile.open(self.target, "w"):
            pass
        transport.validate_archive(self.target)

    def test_validation_size_limit(self):
        with self.assertRaisesRegex(transport.WorkspaceArchiveError, "size"):
            transport.validate_archive(self.source, max_bytes=1024)

    def test_import_failure_reports_docker_detail_without_replay(self):
        def fail(command, **kwargs):
            self.assertEqual(kwargs["stdin"].read(), self.source.read_bytes())
            kwargs["stderr"].write(b"archive/tar: invalid tar header")
            return subprocess.CompletedProcess(command, 1)
        with patch.object(transport.subprocess, "run", side_effect=fail) as run:
            with self.assertRaisesRegex(transport.WorkspaceArchiveError, "no automatic replay.*invalid tar header"):
                transport.copy_archive_in("target-container", self.source)
            self.assertEqual(run.call_count, 1)

    def test_import_timeout_is_not_replayed(self):
        with patch.object(transport.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 1)) as run:
            with self.assertRaisesRegex(transport.WorkspaceArchiveError, "partially written; no automatic replay"):
                transport.copy_archive_in("target-container", self.source, timeout=1)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
