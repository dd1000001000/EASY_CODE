"""Checkpoint helpers used by the V10 training script only."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


MODEL_ROOT = Path(__file__).resolve().parents[2] / "model-weights" / "laya-multilingual"
DEFAULT_MODEL = MODEL_ROOT / "base"


def prepare_output(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=False)
    for dirname in ("encoder", "tokenizer"):
        shutil.copytree(source / dirname, target / dirname)


def save_checkpoint(agent, target: Path, metadata: dict) -> None:
    from safetensors.torch import save_file

    config = dict(agent.cfg)
    config["temperature"] = [1.0, 1.0, 1.0]
    config["temperature_by_options"] = {}
    (target / "rl_agent_config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    weights = {name: value.detach().contiguous().cpu()
               for name, value in agent.model.state_dict().items()}
    pending = target / "model.safetensors.pending"
    save_file(weights, pending)
    os.replace(pending, target / "model.safetensors")
    (target / "training_metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def training_parameters(model, encoder_lr: float, head_lr: float):
    for parameter in model.act_head.parameters():
        parameter.requires_grad_(False)
    encoder = list(model.encoder.parameters())
    choice = [parameter for name, parameter in model.named_parameters()
              if not name.startswith("encoder.") and parameter.requires_grad]
    return [{"params": encoder, "lr": encoder_lr, "name": "encoder"},
            {"params": choice, "lr": head_lr, "name": "choice_head"}]
