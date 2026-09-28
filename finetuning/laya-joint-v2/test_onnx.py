"""Real-model ONNX checks; run with the minimal inference environment."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "resources/laya-decision"))
from runtime import OnnxAgent, build_sequence, pack_inputs, probabilities
from worker import decide, trim_to_model, QUESTIONS


class OnnxChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agent = OnnxAgent(Path(os.environ.get(
            "EASY_CODE_TEST_ONNX_MODEL", str(ROOT / "model-weights/laya-multilingual/joint-v2/model"))))

    def test_no_training_framework_imported(self):
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("transformers", sys.modules)
        self.assertNotIn("laya", sys.modules)

    def test_corrupt_model_is_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "model.onnx").write_bytes(b"not a model")
            (folder / "onnx_manifest.json").write_text(json.dumps({
                "format": "easy-code-laya-onnx-v1", "files": {"model.onnx": "wrong"}}))
            with self.assertRaisesRegex(ValueError, "hash mismatch: model.onnx"):
                OnnxAgent(folder)

    def test_invalid_order_is_rejected(self):
        for order in ([0, 0, 2], [0, 1], [0, 1, 3]):
            with self.assertRaises(ValueError):
                build_sequence(self.agent.tok, "Test", QUESTIONS["route"], option_order=order)

    def test_nonfinite_scores_are_not_decisions(self):
        for scores in ([float("nan"), 1.], [float("inf"), 1.]):
            with self.assertRaises(ValueError):
                probabilities(scores)

    def test_choices_and_invalid_request(self):
        for task in QUESTIONS:
            result = decide(self.agent, {"task": task, "input": "Inspect the code and explain the bug."})
            self.assertIn(result["decision"], QUESTIONS[task]["crit"])
            self.assertAlmostEqual(sum(result["scores"].values()), 1.)
            self.assertFalse(result["truncated"])
        for request in ({"task": "unknown", "input": "test"}, {"task": "route", "input": " "}):
            with self.assertRaises(ValueError):
                decide(self.agent, request)

    def test_long_unicode_input_retains_both_ends(self):
        text = "FIRST-开始 " + "中间内容 implementation detail " * 6000 + " LAST-结束"
        trimmed, _, clipped = trim_to_model(self.agent, text, QUESTIONS["route"])
        self.assertTrue(clipped)
        self.assertIn("FIRST", trimmed)
        self.assertIn("LAST", trimmed)
        ids, markers = build_sequence(self.agent.tok, trimmed, QUESTIONS["route"],
                                      self.agent.cfg["max_len"], self.agent.cfg["head_max_len"])
        self.assertLessEqual(len(ids), self.agent.cfg["max_len"])
        self.assertEqual(len(markers), 3)

    def test_padded_batch_equals_individual_requests(self):
        sequences = [build_sequence(self.agent.tok, text, QUESTIONS[task], 1024, 256)
                     for task, text in (("route", "Fix it."), ("delivery", "Requirements and summary. " * 35))]
        batched = self.agent.infer(pack_inputs(sequences, self.agent.tok.pad_token_id))
        for index, sequence in enumerate(sequences):
            individual = self.agent.infer(pack_inputs([sequence], self.agent.tok.pad_token_id))
            count = len(sequence[1])
            np.testing.assert_allclose(batched[0][index, :count], individual[0][0], atol=1e-4, rtol=1e-4)
            np.testing.assert_allclose(batched[1][index], individual[1][0], atol=1e-4, rtol=1e-4)

    def test_tokenizer_matches_training_snapshot(self):
        snapshots = json.loads((HERE / "tokenizer-parity.json").read_text(encoding="utf-8"))
        import hashlib
        for case in snapshots:
            text = case.get("text") or case["text_prefix"] + case["repeat_text"] * case["repeat_count"] + case["text_suffix"]
            encoded = build_sequence(self.agent.tok, text, QUESTIONS[case["task"]], 1024, 256, case["order"])
            digest = hashlib.sha256(json.dumps(encoded, separators=(",", ":")).encode()).hexdigest()
            self.assertEqual(digest, case["sha256"])


if __name__ == "__main__":
    unittest.main()
