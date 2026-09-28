"""Encoder LoRA + trainable choice head; merge before the existing ONNX export."""
from __future__ import annotations

import json
from pathlib import Path


def configure_lora(agent, rank=8, alpha=16, dropout=.05, learning_rate=1e-4, head_lr=1e-5):
    import torch
    from peft import LoraConfig, get_peft_model

    if rank < 1 or alpha < 1 or not 0 <= dropout < 1 or min(learning_rate, head_lr) <= 0:
        raise ValueError("Invalid LoRA configuration")
    model = agent.model
    model.requires_grad_(False)
    # ModernBERT uses fused QKV and MLP projections. Target all encoder Linear
    # modules, not the custom head's MultiheadAttention (which accesses weights
    # directly). The entire choice head remains trainable, as in standard PEFT.
    model.encoder = get_peft_model(model.encoder, LoraConfig(
        r=rank, lora_alpha=alpha, lora_dropout=dropout,
        target_modules="all-linear", bias="none"))
    model.encoder.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    for name, parameter in model.named_parameters():
        if not name.startswith(("encoder.", "act_head.")):
            parameter.requires_grad_(True)
    encoder = [p for p in model.encoder.parameters() if p.requires_grad]
    choice = [p for name, p in model.named_parameters()
              if not name.startswith("encoder.") and p.requires_grad]
    if not encoder or not choice:
        raise ValueError("Expected both LoRA matrices and trainable choice-head parameters")
    if any(p.requires_grad for name, p in model.encoder.named_parameters() if "lora_" not in name):
        raise ValueError("LoRA unexpectedly unfroze base encoder weights")
    optimizer = torch.optim.AdamW([
        {"params": encoder, "lr": learning_rate},
        {"params": choice, "lr": head_lr}], weight_decay=.01)
    return optimizer, encoder + choice


def save_and_merge(agent, destination: Path, source: Path):
    """Keep a reloadable small adapter and choice head, then merge encoder LoRA."""
    from safetensors.torch import save_file
    import support

    destination.mkdir(parents=True, exist_ok=False)
    agent.model.eval()
    agent.model.encoder.save_pretrained(destination / "encoder", safe_serialization=True)
    choice = {name: tensor.detach().cpu().contiguous()
              for name, tensor in agent.model.state_dict().items()
              if not name.startswith("encoder.")}
    save_file(choice, str(destination / "choice_head.safetensors"))
    (destination / "base.json").write_text(json.dumps({
        "source_sha256": support.digest(source / "model.safetensors"),
        "source": json.loads((support.HERE / "source.json").read_text(encoding="utf-8")),
        "format": "easy-code-laya-encoder-lora-v1",
        "choice_head": "choice_head.safetensors",
    }, indent=2) + "\n", encoding="utf-8")
    agent.model.encoder = agent.model.encoder.merge_and_unload(safe_merge=True)


def load_adapter(agent, folder: Path, source: Path):
    """Restore an experimental adapter onto the exact original upstream model."""
    from peft import PeftModel
    from safetensors.torch import load_file
    import support

    metadata = json.loads((folder / "base.json").read_text(encoding="utf-8"))
    if metadata["format"] != "easy-code-laya-encoder-lora-v1" or (
            metadata["source_sha256"] != support.digest(source / "model.safetensors")):
        raise ValueError("LoRA base checkpoint mismatch")
    agent.model.encoder = PeftModel.from_pretrained(agent.model.encoder, folder / "encoder")
    state = load_file(str(folder / "choice_head.safetensors"), device=str(agent.device))
    expected = {name for name in agent.model.state_dict() if not name.startswith("encoder.")}
    if set(state) != expected:
        raise ValueError("LoRA choice-head state mismatch")
    agent.model.load_state_dict(state, strict=False)
    agent.model.eval()
    return agent
