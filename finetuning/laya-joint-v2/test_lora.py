"""Small real ModernBERT tests for the optional LoRA training path (CPU)."""
import copy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import torch
from laya.common import DecisionModel
from transformers import ModernBertConfig, ModernBertModel

from lora_support import configure_lora, load_adapter, save_and_merge


def tiny_agent():
    config = ModernBertConfig(vocab_size=100, hidden_size=32, intermediate_size=48,
                             num_hidden_layers=2, num_attention_heads=4,
                             max_position_embeddings=64, local_attention=8,
                             pad_token_id=0, bos_token_id=1, eos_token_id=2,
                             cls_token_id=1, sep_token_id=2)
    config._attn_implementation = "sdpa"
    model = DecisionModel(ModernBertModel(config), head_layers=1, dropout=0.)
    return SimpleNamespace(model=model, device="cpu")


def batch():
    return dict(input_ids=torch.tensor([[1, 4, 5, 6, 7, 2], [1, 8, 9, 2, 0, 0]]),
                attention_mask=torch.tensor([[1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 0, 0]]),
                marker_pos=torch.tensor([[1, 3], [1, 2]]),
                marker_mask=torch.ones((2, 2), dtype=torch.bool), qtype=torch.zeros(2, dtype=torch.long))


class LoraTests(unittest.TestCase):
    def test_default_recipe_matches_released_lora(self):
        from train import build_parser
        args = build_parser().parse_args([])
        self.assertEqual(args.method, "lora")
        self.assertEqual((args.lora_rank, args.lora_alpha, args.lora_dropout), (8, 16, .05))
        self.assertEqual((args.lora_lr, args.head_lr, args.seed), (1e-4, 1e-5, 20260925))
        self.assertEqual(build_parser().parse_args(["--method", "full"]).method, "full")

    def setUp(self):
        torch.manual_seed(123)
        torch.set_num_threads(2)

    def test_base_frozen_and_both_adapter_and_head_update(self):
        agent = tiny_agent()
        optimizer, parameters = configure_lora(agent, rank=2, alpha=4, dropout=0.)
        before = {name: p.detach().clone() for name, p in agent.model.named_parameters()}
        trainable = {name for name, p in agent.model.named_parameters() if p.requires_grad}
        self.assertTrue(all("lora_" in name for name in trainable if name.startswith("encoder.")))
        self.assertFalse(any(name.startswith("act_head.") for name in trainable))
        self.assertEqual({id(p) for p in parameters}, {id(p) for p in agent.model.parameters() if p.requires_grad})
        agent.model.train()
        logits, _ = agent.model(**batch())
        torch.nn.functional.cross_entropy(logits, torch.tensor([0, 1])).backward()
        self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0
                            for name, p in agent.model.named_parameters() if "lora_B" in name))
        optimizer.step()
        changed = {name for name, p in agent.model.named_parameters() if not torch.equal(before[name], p)}
        self.assertTrue(any("lora_" in name for name in changed))
        self.assertTrue(any(name.startswith("scorer.") for name in changed))
        self.assertTrue(changed <= trainable)

    def test_initial_adapter_preserves_output(self):
        agent = tiny_agent()
        agent.model.eval()
        with torch.no_grad():
            expected = agent.model(**batch())
        configure_lora(agent, rank=2, alpha=4, dropout=0.)
        agent.model.eval()
        with torch.no_grad():
            for actual, wanted in zip(agent.model(**batch()), expected):
                torch.testing.assert_close(actual, wanted)

    def test_save_reload_merge_and_wrong_base_rejection(self):
        agent = tiny_agent()
        original = copy.deepcopy(agent.model.state_dict())
        configure_lora(agent, rank=2, alpha=4, dropout=0.)
        with torch.no_grad():
            for name, parameter in agent.model.named_parameters():
                if "lora_B" in name:
                    parameter.normal_(0, .01)
        agent.model.eval()
        with torch.no_grad():
            expected = agent.model(**batch())
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "model.safetensors").write_bytes(b"test-only-original-checkpoint")
            save_and_merge(agent, root / "adapter", root)
            self.assertFalse(any("lora_" in name for name, _ in agent.model.named_parameters()))
            restored = tiny_agent()
            restored.model.load_state_dict(original)
            load_adapter(restored, root / "adapter", root)
            with torch.no_grad():
                for model in (agent.model, restored.model):
                    for actual, wanted in zip(model(**batch()), expected):
                        torch.testing.assert_close(actual, wanted, atol=1e-5, rtol=1e-4)
            (root / "model.safetensors").write_bytes(b"wrong-base")
            with self.assertRaisesRegex(ValueError, "base checkpoint mismatch"):
                load_adapter(tiny_agent(), root / "adapter", root)

    def test_invalid_configuration(self):
        for kwargs in ({"rank": 0}, {"alpha": 0}, {"dropout": 1}, {"learning_rate": 0}):
            with self.assertRaises(ValueError):
                configure_lora(tiny_agent(), **kwargs)

    def test_full_sft_still_trains_encoder_without_lora(self):
        import support
        agent = tiny_agent()
        _, parameters = support.configure(agent, 2e-6, 1e-5)
        self.assertTrue(all(p.requires_grad for p in agent.model.encoder.parameters()))
        self.assertFalse(any("lora_" in name for name, _ in agent.model.named_parameters()))
        self.assertFalse(any(p.requires_grad for p in agent.model.act_head.parameters()))
        self.assertEqual({id(p) for p in parameters}, {id(p) for p in agent.model.parameters() if p.requires_grad})


if __name__ == "__main__":
    unittest.main()
