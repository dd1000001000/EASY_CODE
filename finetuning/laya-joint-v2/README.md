# Laya joint routing and delivery — LoRA release

EASY CODE now ships **encoder LoRA + a trained choice head**, merged into a standalone
**FP32 ONNX** model. LoRA is the default training method. Full-parameter SFT remains
available with `--method full` for controlled experiments; it is not the released weight.

![Upstream / full SFT / LoRA accuracy](assets/results.png)

## Accuracy comparison

All three columns use CPU FP32 ONNX, the same 276 held-out cases and all 972 answer
orders. The upstream and LoRA evaluations were rerun for this release; full SFT
uses the saved evaluation of the hash-verified previous ONNX.

| Task | No fine-tuning | Full-parameter SFT | LoRA (current) |
| --- | ---: | ---: | ---: |
| Routing | 315/630 (50.00%) | 600/630 (95.24%) | 590/630 (93.65%) |
| Delivery | 197/342 (57.60%) | 239/342 (69.88%) | 247/342 (72.22%) |

This is a trade-off, not a claim of no regression: routing drops 1.59 percentage
points versus full SFT, while delivery rises 2.34 points. It is one seed and one
LoRA configuration, not evidence of general superiority. Older BF16 baseline
numbers use a different evaluation precision and are not mixed into this chart.
The product's 0.90 delivery threshold is applied after these highest-score predictions.

[GLM API vs LoRA: tokens and inference speed](../../laya-bench%20mark/README.md)
is a separate 200-input comparison. No cascade results are presented. GLM
observations are historical API records; LoRA is rerun locally. Those 200 inputs
overlap the held-out set, rather than adding an independent test dataset.

## Training recipe

Data originates from GPT-6 Luna teacher outputs curated into EASY CODE requests
and completion summaries. The fixed split contains 995 fit, 110 validation and
276 held-out cases. Dataset hashes and split IDs are checked before training.

- Freeze the original multilingual ModernBERT encoder and action head.
- Apply LoRA to all encoder linear projections: fused QKV, attention output and MLP.
- Train the custom choice head in full, using choice cross-entropy and equal total
  route/delivery task weight. Shuffle examples and answer-option order each epoch.
- Select epochs on validation only, then reload the original base and refit on
  all 1,105 development cases. This run selected **3 epochs** (early stopping at 6).
- Save the adapter and choice head for developer reloads; merge before ONNX export.
  Validate both heads, long inputs and padded batches against PyTorch.

| Parameter | Current recipe |
| --- | --- |
| LoRA rank / alpha / dropout | 8 / 16 / 0.05 |
| LoRA / choice-head learning rate | 1e-4 / 1e-5 |
| Effective / micro batch size | 16 / 4 |
| Maximum selection epochs / patience | 8 / 3 |
| Seed | 20260925 |
| Training precision | CUDA BF16 autocast; gradient checkpointing |
| Trainable parameters | 16,460,545 (5.09% of model with adapters) |
| Encoder LoRA parameters | 1,689,600 (remainder is the choice head) |
| Deployment | Merged FP32 ONNX, CPU, no PEFT/PyTorch dependency |

LoRA reduces training parameters and adapter storage, **not** the merged inference
model size: the released graph remains about 1.29 GB. Historical full SFT training
used different PyTorch/CUDA versions, so its recorded training time is not a
controlled resource comparison.

## Reproduce

Use a CUDA-enabled PyTorch environment. This run used Python 3.14.4,
PyTorch 2.14.0+cu132, Laya 0.3.20, Transformers 5.17.0, PEFT 0.20.0,
ONNX 1.20.1, ONNX Runtime 1.24.3 and tokenizers 0.23.2 under WSL.
Install training packages in a separate environment, not the application's runtime:

```text
pip install laya==0.3.20 transformers==5.17.0 peft==0.20.0 safetensors huggingface_hub matplotlib onnx==1.20.1 onnxruntime==1.24.3 tokenizers==0.23.2
hf download convaiinnovations/laya-multilingual --revision 82d57fc4f2d1be3d2caac494045f2ec51d0842f3 --local-dir .easy-code-runtime/lora-base

# From repository root; use a fresh output directory
python finetuning/laya-joint-v2/train.py --output .easy-code-runtime/laya-lora-run

# Optional full-SFT control, with a separate output
python finetuning/laya-joint-v2/train.py --method full --output .easy-code-runtime/laya-full-run

python finetuning/laya-joint-v2/evaluate.py --output model-weights/laya-multilingual/joint-v2/onnx-evaluation.json
python finetuning/laya-joint-v2/test_lora.py
python finetuning/laya-joint-v2/test_onnx.py
python finetuning/laya-joint-v2/render_results.py
```

`train.py` refuses an existing output directory; its default output is Git-ignored,
not the published model directory. `--source` overrides the original-base path,
but the pinned source SHA-256 must match [source.json](source.json).

To refresh the untrained reference, export the pinned original base with
`export_onnx.py --checkpoint <base> --output <new-onnx-folder>`, then run
`evaluate.py --model <new-onnx-folder> --output <reference-json>`. The renderer
accepts `--upstream`, `--sft` and `--current` evaluation paths and rejects
different datasets, answer-order coverage or backends.

`compare_lora.py` takes explicit `--reference-model` and
`--reference-evaluation` in addition to `--run` and `--output`; the old full-SFT
model must be supplied from its backup. It rejects self-comparisons and reference
hash mismatches. `lora_support.load_adapter()` validates the original base before reload.

For inference-only checks, use ONNX Runtime and tokenizers without torch/PEFT.
Set `EASY_CODE_TEST_ONNX_MODEL` to test another export. Python 3.10 / Intel macOS
use ONNX Runtime 1.23.2; Intel macOS Python 3.14 is unsupported by the installer.

## Artifacts

- [Current ONNX weights](../../model-weights/laya-multilingual/joint-v2/model/)
  and [current CPU evaluation](../../model-weights/laya-multilingual/joint-v2/onnx-evaluation.json).
- [Training report](../../model-weights/laya-multilingual/joint-v2/report.json),
  [dataset manifest](data/manifest.json), [cross-platform checks](onnx-validation.json).
- [Original base ONNX evaluation](experiments/upstream-reference/onnx-evaluation.json)
  and [former full-SFT ONNX evaluation](experiments/full-sft-reference/onnx-evaluation.json).
- [Historical LoRA selection experiment](experiments/lora-r8-20260928/README.md).
- Local pre-replacement backup: `F:\models\easy-code-laya-full-sft-20260928`.
  All 10 original release files were SHA-256 verified before replacing the release.
  The backup is not included in the repository or application package.

[Upstream code](https://github.com/NandhaKishorM/laya) ·
[Original checkpoint](https://huggingface.co/convaiinnovations/laya-multilingual).
