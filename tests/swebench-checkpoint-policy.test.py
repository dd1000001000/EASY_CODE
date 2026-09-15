"""Focused tests for benchmark checkpoint filesystem policy."""
import ast
import os
from pathlib import Path
import stat as statlib
import shutil
import tempfile
from collections.abc import Callable
import unittest


SOURCE = Path(__file__).parents[1] / "benchmarks/swebench_verified/easy_code_agent.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
agent = next(
    node
    for node in tree.body
    if isinstance(node, ast.ClassDef) and node.name == "EasyCodeAgent"
)
method_names = {
    "_checkpoint_copy_ignores",
    "_checkpoint_path_ignored",
    "_assert_regular_tree",
    "_install_workspace_checkpoint",
    "_discover_main_thread_id",
}
methods = [
    node
    for node in agent.body
    if isinstance(node, ast.FunctionDef) and node.name in method_names
]
fixture_class = ast.ClassDef(
    name="EasyCodeAgent",
    bases=[],
    keywords=[],
    body=methods,
    decorator_list=[],
)
namespace = {
    "Path": Path,
    "Callable": Callable,
    "statlib": statlib,
    "shutil": shutil,
    "json": __import__("json"),
    "_THREAD_ID_PATTERN": __import__("re").compile(
        r"^thread_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    ),
    "_TESTBED": "/testbed",
    "_WORKSPACE_CHECKPOINT_FILES": (
        "workspace.base",
        "workspace.json",
        "workspace.patch",
        "untracked.tar.gz",
        "easy-code-refs.tsv",
        "easy-code-refs.bundle",
    ),
    "_REQUIRED_WORKSPACE_CHECKPOINT_FILES": {
        "workspace.base",
        "workspace.json",
        "workspace.patch",
    },
}
exec(
    compile(ast.fix_missing_locations(ast.Module(body=[fixture_class], type_ignores=[])), str(SOURCE), "exec"),
    namespace,
)
EasyCodeAgent = namespace["EasyCodeAgent"]


class CheckpointTreePolicyTests(unittest.TestCase):
    def test_installs_downloaded_checkpoint_and_removes_stale_optional_files(self):
        with tempfile.TemporaryDirectory(prefix="easy-checkpoint-install-") as temporary:
            root = Path(temporary)
            adapter = root / "adapter"
            downloaded = root / "downloaded"
            stage = adapter / "easy-code-checkpoint"
            downloaded.mkdir()
            stage.mkdir(parents=True)
            (stage / "binding.json").write_text("{}", encoding="utf-8")
            (stage / "untracked.tar.gz").write_bytes(b"stale")
            for name, content in {
                "workspace.base": "a" * 40 + "\n",
                "workspace.json": "{}\n",
                "workspace.patch": "patch\n",
            }.items():
                (downloaded / name).write_text(content, encoding="utf-8")
            owner = EasyCodeAgent()
            owner._adapter_logs_dir = adapter
            owner._install_workspace_checkpoint(downloaded)
            self.assertTrue((stage / "binding.json").is_file())
            self.assertEqual((stage / "workspace.patch").read_text(encoding="utf-8"), "patch\n")
            self.assertFalse((stage / "untracked.tar.gz").exists())

    def test_discovers_only_the_main_testbed_thread(self):
        with tempfile.TemporaryDirectory(prefix="easy-main-thread-") as temporary:
            root = Path(temporary)
            threads = root / "easy-code-data" / "threads"
            threads.mkdir(parents=True)
            main_id = "thread_11111111-1111-1111-1111-111111111111"
            review_id = "thread_22222222-2222-2222-2222-222222222222"
            child_id = "thread_33333333-3333-3333-3333-333333333333"

            def journal(thread_id, workspace, child=False):
                directory = threads / thread_id
                directory.mkdir()
                events = [{"type": "thread.created", "payload": {"state": {"workspaceRoot": workspace}}}]
                if child:
                    events.append({"type": "subagent.session_bound", "payload": {}})
                (directory / "events.jsonl").write_text(
                    "".join(__import__("json").dumps(event) + "\n" for event in events), encoding="utf-8"
                )

            journal(main_id, "/testbed")
            journal(review_id, "/tmp/easy-code-review/reviewer")
            journal(child_id, "/testbed", child=True)
            owner = EasyCodeAgent()
            owner._adapter_logs_dir = root
            self.assertEqual(owner._discover_main_thread_id(), main_id)

    def test_validation_and_copy_share_the_runtime_ignore_policy(self):
        with tempfile.TemporaryDirectory(prefix="easy-checkpoint-policy-") as temporary:
            root = Path(temporary)
            (root / "regular.json").write_text("{}\n", encoding="utf-8")
            (root / "easy-code.db.lock").mkdir()
            (root / "easy-code.db.easy-code-advisory-lock.stale").mkdir()
            (root / "worktrees" / "nested").mkdir(parents=True)

            EasyCodeAgent._assert_regular_tree(
                root, ignored_path=EasyCodeAgent._checkpoint_path_ignored
            )
            ignored = EasyCodeAgent._checkpoint_copy_ignores(
                root,
                root,
                [
                    "regular.json",
                    "easy-code.db.lock",
                    "easy-code.db.easy-code-advisory-lock.stale",
                    "worktrees",
                ],
            )
            self.assertEqual(
                ignored,
                {
                    "easy-code.db.lock",
                    "easy-code.db.easy-code-advisory-lock.stale",
                    "worktrees",
                },
            )

    def test_rejects_a_non_ignored_symlink_with_its_relative_path(self):
        with tempfile.TemporaryDirectory(prefix="easy-checkpoint-link-") as temporary:
            root = Path(temporary)
            target = root / "target.txt"
            target.write_text("target", encoding="utf-8")
            link = root / "unsafe-link"
            try:
                link.symlink_to(target)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")
            with self.assertRaisesRegex(RuntimeError, "unsafe-link"):
                EasyCodeAgent._assert_regular_tree(root)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO creation is unavailable")
    def test_rejects_a_non_ignored_special_file_with_its_relative_path(self):
        if os.name == "nt":
            self.skipTest("Windows does not provide mkfifo")
        with tempfile.TemporaryDirectory(prefix="easy-checkpoint-special-") as temporary:
            root = Path(temporary)
            os.mkfifo(root / "unexpected.fifo")
            with self.assertRaisesRegex(RuntimeError, "unexpected.fifo"):
                EasyCodeAgent._assert_regular_tree(root)


if __name__ == "__main__":
    unittest.main()
