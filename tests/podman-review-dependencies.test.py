import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / "resources/podman/review-dependencies.py"

@unittest.skipIf(os.name == "nt", "The helper runs only in Linux containers; execute tests in WSL")
class DependencySnapshotTest(unittest.TestCase):
    def run_helper(self, source, target="", files=1000, size=100000):
        return subprocess.run([sys.executable, "-I", str(HELPER), str(source), str(target), str(files), str(size), "10"],
                              text=True, capture_output=True, timeout=15)

    def test_content_changes_budget_and_independent_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            package = source / "node_modules/dep"
            package.mkdir(parents=True)
            (package / "index.js").write_text("original")
            target = Path(directory) / "copy"
            first = self.run_helper(source)
            self.assertEqual(first.returncode, 0, first.stderr)
            copied = self.run_helper(source, target)
            self.assertEqual(copied.returncode, 0, copied.stderr)
            self.assertEqual(json.loads(first.stdout), json.loads(copied.stdout))
            (target / "node_modules/dep/index.js").write_text("changed copy")
            self.assertEqual((package / "index.js").read_text(), "original")
            (package / "index.js").write_text("changed source")
            self.assertNotEqual(json.loads(first.stdout)["digest"], json.loads(self.run_helper(source).stdout)["digest"])
            self.assertNotEqual(self.run_helper(source, files=1).returncode, 0)
            self.assertNotEqual(self.run_helper(source, size=1).returncode, 0)

    @unittest.skipIf(os.name == "nt", "Linux link semantics: run this case in WSL or container")
    def test_linux_links_modes_and_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            dep = source / "node_modules/dep"
            dep.mkdir(parents=True)
            entry = dep / "cli.js"
            entry.write_text("console.log(42)")
            entry.chmod(0o755)
            bin_dir = source / "node_modules/.bin"
            bin_dir.mkdir()
            (bin_dir / "dep").symlink_to("../dep/cli.js")
            venv = source / ".venv/bin"
            venv.mkdir(parents=True)
            (venv / "python").symlink_to(sys.executable)
            target = Path(directory) / "copy"
            result = self.run_helper(source, target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.readlink(target / "node_modules/.bin/dep"), "../dep/cli.js")
            self.assertTrue(os.access(target / "node_modules/dep/cli.js", os.X_OK))
            self.assertEqual(os.readlink(target / ".venv/bin/python"), sys.executable)
            (bin_dir / "escape").symlink_to("/etc/passwd")
            self.assertNotEqual(self.run_helper(source).returncode, 0)

if __name__ == "__main__":
    unittest.main()
