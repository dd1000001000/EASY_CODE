# Laya LoRA experiment — 2026-09-28

The experiment completed on an RTX 5070 Ti under WSL. It starts from the pinned
**original upstream Laya**, not EASY CODE's already fine-tuned model. The
application now ships this merged LoRA ONNX at the user's request. The former full-SFT
model is backed up at `F:\models\easy-code-laya-full-sft-20260928`. This file preserves
the original experiment; current comparisons are in the [training guide](../../README.md).

## Protocol

- Existing data unchanged: 995 fit, 110 validation, 276 held-out cases.
- Encoder LoRA (`r=8`, `alpha=16`, dropout `0.05`, LR `1e-4`) on all encoder
  linear projections, plus fully trainable choice head (LR `1e-5`). Base encoder
  and action head frozen. Effective/micro batches: 16/4, CUDA BF16 autocast.
- Same validation selection criterion as full SFT. Early stopping after epoch 6
  selected **3 epochs**; refit started from the original base on all 1,105
  development cases. Test data did not select epochs or hyperparameters.
- Merge LoRA before export; evaluate the standalone **FP32 ONNX on CPU**.
- One fixed configuration and seed (`20260925`), not a hyperparameter sweep.

## Results

| Evaluation | Former full SFT | Promoted LoRA |
| --- | ---: | ---: |
| Routing, all 630 answer-order trials | 600/630 (95.24%) | 590/630 (93.65%) |
| Delivery, all 342 answer-order trials | 239/342 (69.88%) | 247/342 (72.22%) |
| Worker routing, 100 frozen inputs | 94/100 | 94/100 |
| Worker delivery, 100 frozen inputs | 75/100 | 74/100 |

The 972-order full-SFT reference is the previously saved CPU ONNX evaluation.
Both models' 200-input worker results were rerun here with the application's
actual preprocessing. The worker cases are a subset of the held-out set, not an
independent dataset; default option order and input truncation also differ from
the all-order evaluation protocol. No cloud API or SWE benchmark was rerun.

**Conclusion:** LoRA learns both tasks with fewer trainable parameters, but this
run is not uniformly better. In particular, CODE routing falls from 185/210 to
170/210 across answer orders. The user chose to promote LoRA despite this trade-off;
do not infer general superiority or statistical significance from this one run.

## Resources and artifacts

- Trainable parameters: **16,460,545 / 323,598,595 (5.09%)**. Encoder LoRA accounts
  for 1,689,600; the remainder is the choice head, not LoRA matrices.
- Selection: 184.14 seconds; refit: 100.54 seconds. End-to-end training, export and
  held-out evaluation: 499.40 seconds (excludes setup and the later worker rerun).
- Peak training tensors allocated by PyTorch: 1,651.78 MiB during selection,
  1,650.51 MiB during refit. This excludes allocator-reserved memory, CUDA context,
  desktop applications and other process GPU allocations.
- Historical full SFT used a different PyTorch version; do not interpret its
  recorded time or memory as a controlled same-environment resource comparison.
- The merged ONNX is still about 1.29 GB: LoRA reduces training costs and adapter
  storage, **not** the size of the merged inference model.

Local experimental weights are Git-ignored under
`.easy-code-runtime/lora-r8-20260928/`: `model/` contains the ONNX release-format
export, and `adapter/` contains the small encoder adapter plus choice-head state.
The original base is `.easy-code-runtime/lora-base/`. Reproduce using the
[training instructions](../../README.md); the adapter is not added to
the application package or Git LFS.

[Full training report](training-report.json) · [Comparison summary](summary.json)
· [Per-input worker results](worker-results.json)

## Checks

- Six CPU LoRA/full-SFT regression tests passed (default recipe, frozen base, gradients,
  zero-update parity, adapter reload/merge, invalid configurations and full-SFT path).
- Exporter checked ONNX against merged PyTorch, both heads, long inputs and padded batches.
- Eight ONNX runtime checks passed for the experimental model on **Windows and WSL**.
- The promoted release passed eight runtime checks on Windows and WSL; all 972 held-out choices agree between platforms.
- Four benchmark regression tests passed; `git diff --check` passed.
- Release promotion passed 1,453 application tests, 27 extension tests and the build.
