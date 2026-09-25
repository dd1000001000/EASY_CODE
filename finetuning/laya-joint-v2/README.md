# Joint route and delivery decision model

This folder is the retained training snapshot for **one** Laya multilingual
model that chooses either an EASY CODE work mode (`DIRECT`, `PLAN`, `CODE`) or
a pre-delivery decision (`RELEASE`, `CHALLENGE`). The model is an experiment;
it is **not wired into EASY CODE Runtime**.

## Data provenance

According to the project owner's provenance statement, **all examples in
this dataset originate from the GPT-6 Luna teacher model**. The teacher
examples were subsequently filtered and rewritten to resemble Runtime
inputs; 50 delivery contrast groups and their rephrased probes received
additional author editing and labeling. Thus, "Luna-sourced" does not mean
every final input string or label is an unchanged teacher response. The
original per-example Luna generation transcripts are not preserved, so this
attribution cannot be independently verified row by row from this snapshot.

The frozen snapshot contains 525 route and 856 delivery inputs. Each task
was regrouped and split 4:1, with closely related requests kept in the same
partition. The combined 1,105 development cases include 995 for epoch
selection and 110 internal validation cases. The held-out test contains
105 route and 171 delivery cases (276 total). `data/manifest.json` records
the snapshot hashes and class counts. The previous fixed test and contrast
probes were pooled before this new split at the user's request; hence the
new test is group-disjoint but **not an entirely blind external benchmark**.

## Training method

The method is **SFT (supervised fine-tuning)**, not "SFR": full-parameter
training of the original `convaiinnovations/laya-multilingual` encoder and
choice head using labeled examples and cross-entropy. No DPO, LoRA, command
approval task, text-generation objective, or confidence calibration is used.
Route and delivery share one model; each task receives equal *total* loss
weight despite different dataset sizes. Example order and answer-option
order are shuffled each epoch. BF16 and gradient checkpointing reduce GPU
memory use.

Validation selected five epochs; a fresh copy of the upstream model was then
trained on all 1,105 development cases for five epochs. The held-out test
was evaluated only after this selection and refit. The final checkpoint is
`../../model-weights/laya-multilingual/joint-v2/model/`; the detailed
per-case report is `../../model-weights/laya-multilingual/joint-v2/report.json`.
The source checkpoint remains in
`../../model-weights/laya-multilingual/upstream-base/` to make retraining
possible. With a CUDA-capable Python environment containing `laya==0.3.20`,
`torch==2.8.0+cu128`, and `safetensors`, run `python train.py --output NEW_DIR`;
the script refuses to overwrite an existing output directory.

## Accuracy and confusion matrices

Every route case was evaluated in all six answer orders; every delivery
case was evaluated in both orders. Matrix rows are reference labels and
columns are model predictions. Counts are *option-order evaluations*, not
unique user requests.

| Task | Original Laya | Joint SFT model | Correct in every option order |
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

The 51 `CHALLENGE` → `RELEASE` decisions are unsafe false releases. The
delivery score is also slightly below the earlier delivery-only experiment
(69.9%). Consequently, this model must **not** replace independent delivery
review or silently approve command execution.

If one *assumes* a GLM reference model is 100% accurate, its hypothetical
confusion matrices would be diagonal with 630/630 route and 342/342 delivery
correct. That is a user-specified idealized reference, **not a measured GLM
result**; these Luna-sourced test labels were subsequently edited or
reviewed and were not all independently verified by GLM.
