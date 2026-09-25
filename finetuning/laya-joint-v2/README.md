# Laya joint route-and-delivery fine-tuning

This folder contains the frozen data and scripts for one multilingual Laya
choice model. It predicts an EASY CODE work mode (`DIRECT`, `PLAN`, `CODE`) or
a pre-delivery decision (`RELEASE`, `CHALLENGE`). The fine-tuned checkpoint is
provided in [`../../model-weights/laya-multilingual/joint-v2/model/`](../../model-weights/laya-multilingual/joint-v2/model/).
The **original, pre-fine-tuning weights are not distributed in this repository**.
This checkpoint is experimental. EASY CODE Runtime uses it for local Auto
routing and a one-time pre-delivery reminder, while retaining its existing
completion checks and independent reviewer.

## Obtain the original checkpoint (only for retraining)

- Laya library and source: [GitHub](https://github.com/NandhaKishorM/laya)
- Original multilingual checkpoint: [Hugging Face](https://huggingface.co/convaiinnovations/laya-multilingual)
- Download command and options: [Hugging Face CLI guide](https://huggingface.co/docs/huggingface_hub/guides/cli#hf-download)

Use Python 3.11 and a CUDA-capable environment for these scripts. Install a
CUDA-enabled PyTorch build appropriate for your system using the
[official PyTorch selector](https://pytorch.org/get-started/locally/), then
install `laya==0.3.20`, `safetensors`, and `huggingface_hub` in the same Python
environment. The original run used Laya 0.3.20 and PyTorch 2.8.0+cu128;
other combinations have not been verified here.

From the EASY CODE repository root, download the **exact upstream revision**
recorded in [`source.json`](source.json):

```text
hf download convaiinnovations/laya-multilingual --revision 82d57fc4f2d1be3d2caac494045f2ec51d0842f3 --local-dir model-weights/laya-multilingual/upstream-base
```

The target directory must directly contain `model.safetensors`,
`rl_agent_config.json`, `encoder/`, and `tokenizer/`. `train.py` checks the
downloaded weight against the SHA-256 in `source.json` before training. Do not
substitute `main` or a newer checkpoint when trying to reproduce this run.
The download directory is ignored by Git; it is local input, not part of the
published fine-tuned model.

## Train or evaluate

Run these commands from `finetuning/laya-joint-v2/` using the same Python
environment. Training requires the separately downloaded original checkpoint:

```text
python train.py --output PATH_TO_NEW_EMPTY_OUTPUT_DIRECTORY
```

The trainer refuses to overwrite an existing output directory. It verifies
the dataset and source hashes, selects an epoch on the internal validation
split, refits from the original checkpoint, and writes a new checkpoint and
`report.json`. It does **not** overwrite the retained fine-tuned weights.

To check the **already provided fine-tuned model**, no original checkpoint is
needed:

```text
python evaluate.py
```

`evaluate.py` verifies the frozen held-out test snapshot and prints route and
delivery accuracy, option-order consistency, and confusion matrices. Both
scripts currently require CUDA. The historical per-case results are in
[`../../model-weights/laya-multilingual/joint-v2/report.json`](../../model-weights/laya-multilingual/joint-v2/report.json);
its absolute paths describe the original training machine and are not paths
new users need to recreate.

## Data and method

According to the project owner's provenance statement, **all examples in
this dataset originate from the GPT-6 Luna teacher model**. The teacher
examples were subsequently filtered and rewritten to resemble Runtime
inputs; 50 delivery contrast groups and their rephrased probes received
additional author editing and labeling. Thus, "Luna-sourced" does not mean
every final input string or label is an unchanged teacher response. The
original per-example Luna generation transcripts are not preserved, so this
attribution cannot be independently verified row by row from this snapshot.

The frozen snapshot contains 525 route and 856 delivery inputs. Related
requests were kept together during a 4:1 development/test split: 995 fitting,
110 internal validation, and 276 held-out test cases (105 route, 171 delivery).
The original fixed test and contrast probes were pooled before this split at
the user's request, so the test is group-disjoint but **not a blind external
benchmark**. [`data/manifest.json`](data/manifest.json) records the hashes and
class counts.

Training used full-parameter supervised fine-tuning (**SFT**, not SFR) of the
original `convaiinnovations/laya-multilingual` encoder and choice head, with
cross-entropy on labeled choices and equal aggregate loss weight for the two
tasks. Example order and answer-option order were shuffled each epoch. BF16
and gradient checkpointing reduce GPU memory use. There was no DPO, LoRA,
command-approval objective, text-generation objective, or confidence
calibration.

Validation selected five epochs; a fresh copy of the downloaded original
checkpoint was then trained on all 1,105 development cases for five epochs.
The held-out test was evaluated only after this selection and refit.

## Held-out results and limits

Every route case was evaluated in all six answer orders; every delivery
case was evaluated in both orders. Matrix rows are reference labels and
columns are model predictions. Counts are **option-order evaluations**, not
unique user requests.

| Task | Original checkpoint | Fine-tuned checkpoint | Correct in every answer order |
| --- | ---: | ---: | ---: |
| Route | 316/630 (50.2%) | **599/630 (95.1%)** | 36/105 → 95/105 |
| Delivery | 196/342 (57.3%) | **237/342 (69.3%)** | 82/171 → 110/171 |

Route, after SFT:

| Actual \ Predicted | `DIRECT` | `PLAN` | `CODE` | Per-class accuracy |
| --- | ---: | ---: | ---: | ---: |
| `DIRECT` | 206 | 0 | 4 | 98.1% |
| `PLAN` | 0 | 209 | 1 | 99.5% |
| `CODE` | 16 | 10 | 184 | 87.6% |

Delivery, after SFT:

| Actual \ Predicted | `RELEASE` | `CHALLENGE` | Per-class accuracy |
| --- | ---: | ---: | ---: |
| `RELEASE` | 116 | 54 | 68.2% |
| `CHALLENGE` | 51 | 121 | 70.3% |

The 51 `CHALLENGE` → `RELEASE` evaluations are false releases. The delivery
model cannot certify code correctness or replace independent review; its
probabilities were not calibrated on this task. Re-running the held-out test
with the same data is a reproducibility check, not evidence of performance on
new user projects. A previously discussed “GLM 100%” result is only a
user-specified idealized reference, not a measured benchmark.
