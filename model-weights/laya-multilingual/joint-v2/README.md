# Released Laya: merged LoRA ONNX

`model/` contains EASY CODE's current FP32 ONNX local decision model for Auto
routing and a one-time pre-delivery check. It was trained from the pinned
original multilingual Laya using **encoder LoRA plus a fully trained choice
head**, not full-parameter encoder fine-tuning.

LoRA rank 8, alpha 16, dropout 0.05; adapter/head learning rates 1e-4 / 1e-5.
Validation selected 3 epochs, followed by refit on 1,105 development cases.
The adapter is merged into the encoder before export. Runtime needs only
ONNX Runtime and tokenizers, not PyTorch or PEFT. LoRA does not reduce the
merged FP32 graph's size.

`onnx_manifest.json` records weight/tokenizer/config hashes and the training
recipe. The ONNX and tokenizer JSON are Git LFS assets. No adapter, original
base safetensors or full-SFT backup is shipped in this directory.

Current CPU ONNX evaluation: **590/630 routing (93.65%)** and **247/342 delivery
(72.22%)**. All 972 answer orders use the fixed 276 held-out cases. Full SFT
previously achieved 95.24% / 69.88%, so this release involves a trade-off.
See [the training guide](../../../finetuning/laya-joint-v2/README.md) for the
untrained / full-SFT / LoRA comparison and reproduction instructions.

`report.json` is the LoRA training report; `onnx-evaluation.json` evaluates the
current released graph. Previous full-SFT reports are archived under
`finetuning/laya-joint-v2/experiments/full-sft-reference/`. The complete old
release is backed up locally at `F:\models\easy-code-laya-full-sft-20260928`.

Command approvals, independent review and runtime completion checks are
unchanged. If local inference fails, Auto falls back to the cloud controller;
delivery reports the issue and continues through the existing completion checks.
The upstream model is licensed under Apache-2.0.
