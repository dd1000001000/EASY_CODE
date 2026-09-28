"""Offline regression checks for reruns that retain recorded cloud controls."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark
import speed


class RerunChecks(unittest.TestCase):
    def test_local_refresh_preserves_cloud_and_original_baseline(self):
        row = {"id": "r1", "task": "route", "input": "Explain", "expected": "DIRECT"}
        old = {**row, "laya": {"decision": "DIRECT"}, "glm": {"decision": "CODE", "total_tokens": 42}}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "results.jsonl"
            benchmark.append_jsonl(path, old)
            with patch.object(benchmark, "RESULTS", path), patch.object(benchmark, "prepare", return_value=[row]), \
                 patch.object(benchmark, "local_results", return_value={"r1": {"decision": "PLAN"}}):
                benchmark.refresh_local("unused")
                benchmark.refresh_local("unused")
            current = benchmark.read_jsonl(path)[0]
            self.assertEqual(current["glm"], old["glm"])
            self.assertEqual(current["previous_laya"], old["laya"])
            self.assertEqual(current["laya"]["decision"], "PLAN")
            self.assertEqual(current["local_backend"], "onnx-fp32")

    def test_changed_input_cannot_reuse_cloud_control(self):
        row = {"id": "r1", "task": "route", "input": "Explain", "expected": "DIRECT"}
        with patch.object(benchmark, "prepare", return_value=[row]), \
             patch.object(benchmark, "read_jsonl", return_value=[{**row, "input": "Different"}]), \
             patch.object(benchmark, "local_results") as local:
            with self.assertRaisesRegex(ValueError, "does not match"):
                benchmark.refresh_local("unused")
            local.assert_not_called()

    def test_timing_report_preserves_rerun_provenance(self):
        rows = [{"id": task, "task": task} for task in ("route", "delivery")]
        with tempfile.TemporaryDirectory() as folder:
            timings, summary = Path(folder) / "timings.jsonl", Path(folder) / "summary.json"
            for row in rows:
                benchmark.append_jsonl(timings, {**row, "laya": {"ms": 10}, "glm": {"ms": 100, "attempts": 1}})
            provenance = {"local_backend": "onnx-fp32", "glm_source": "historical recorded API timings",
                          "previous_local": {"cold_start_ms": 500}, "laya_cold_start_ms": 100, "laya_device": "cpu"}
            summary.write_text(json.dumps(provenance), encoding="utf-8")
            with patch.object(speed, "TIMINGS", timings), patch.object(speed, "SUMMARY", summary), \
                 patch.object(benchmark, "prepare", return_value=rows), \
                 patch("sys.argv", ["speed.py", "--python", "unused"]), contextlib.redirect_stdout(io.StringIO()):
                speed.main()
            saved = json.loads(summary.read_text(encoding="utf-8"))
            for key, value in provenance.items():
                self.assertEqual(saved[key], value)


if __name__ == "__main__":
    unittest.main()
