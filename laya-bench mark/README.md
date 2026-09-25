# Fine-tuned Laya + GLM

100 routing + 100 delivery cases. Fine-tuned Laya (joint-v2) decides first; confidence below **0.90** sends the case to GLM.

![Fine-tuned Laya and GLM benchmark results](benchmark-overview.png)

| Method | Routing accuracy | Delivery accuracy | Overall accuracy | Cloud tokens |
| --- | ---: | ---: | ---: | ---: |
| Fine-tuned Laya | 94.0% | 75.0% | 84.5% | 0 |
| GLM | 87.0% | 96.0% | 91.5% | 76,006 |
| Fine-tuned Laya + GLM | 95.0% | 82.0% | 88.5% | 11,716 |

The cascade cuts cloud tokens by **84.6%** and GLM calls from **200 to 32**. Overall accuracy is **3.0 percentage points lower** than GLM-only.

Incorrect approvals among 50 delivery cases requiring correction: **Fine-tuned Laya 14 · GLM 0 · Fine-tuned Laya + GLM 10**.

Fine-tuned Laya joint-v2 and GLM-5.3-Flash, evaluated on the same held-out cases. Cascade results reuse each case's recorded GLM answer and token usage.
