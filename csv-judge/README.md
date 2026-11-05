# CSV Judge

Core judge for CSV-based AI submissions. Task adapters validate and normalize
each CSV shape, while a metric registry provides reusable scoring functions.

## Requirements

- Python 3.11 or newer

## Install for development

```powershell
python -m pip install -e ".[dev]"
```

## Score a submission

```powershell
csv-judge score `
  --problem problems/example_binary `
  --submission problems/example_binary/sample_submission.csv
```

Validate a complete problem package before publishing it:

```powershell
csv-judge validate-problem problems/example_binary
```

List every registered task/metric combination:

```powershell
csv-judge list-capabilities
```

For machine-readable output:

```powershell
csv-judge score `
  --problem problems/example_binary `
  --submission problems/example_binary/sample_submission.csv `
  --output json
```

## Run tests

```powershell
pytest
```

## Problem format

Each problem directory contains:

- `config.json`: schema, limits, task type, and metric.
- `ground_truth.csv`: private IDs and labels.
- `sample_submission.csv`: contestant-facing submission template.

IDs are loaded as strings. Most tasks align rows by `id_column`; ranking aligns
by the composite `(id_column, item_column)` key. Submission row order never
affects the score.

Supported task/metric combinations:

- `binary_probability`: `log_loss`, `accuracy`, `f1`, `precision`, `recall`,
  `balanced_accuracy`
- `multiclass_probability`: `log_loss`, `accuracy`, `macro_f1`,
  `macro_precision`, `macro_recall`
- `regression`: `mae`, `mse`, `rmse`, `r2`, `mape`, `smape`
- `text_generation`: `sacrebleu`, `chrf`
- `multilabel_probability`: `micro_f1`, `macro_f1`, `hamming_loss`
- `ranking`: `mrr`, `map`, `recall_at_k`, `ndcg_at_k`

`mape` and `smape` return ratios rather than percentages. For example, `0.15`
means 15%. MAPE uses `metric_options.epsilon` (default `1e-8`) to handle zero
targets.

Ranking problems use `id_column` as the query key and require `item_column`.
`recall_at_k` and `ndcg_at_k` read `metric_options.k` (default `10`).
Equal ranking scores are broken deterministically by ascending `item_column`,
never by private ground-truth row order.
Multilabel problems map `target_columns` in ground truth to
`prediction_columns` in the submission by list position.

The current text adapter supports one reference per ID. A future
multi-reference metric should extend the adapter rather than encode multiple
references into one CSV cell.

## Extend the judge

- Add a new CSV shape by implementing `TaskAdapter` in `adapters.py` and
  registering one instance in `TASK_ADAPTERS`.
- Add a metric by implementing a function in `metric_registry.py` and adding a
  `MetricSpec` to `METRICS`.
- Declare compatible task types and score direction in the metric spec. The
  config loader rejects unknown or incompatible combinations before scoring.
- Add an example problem and tests that compute expected scores independently
  of the implementation.

Contestant-provided code is never imported or executed. All adapters and metric
functions are trusted, version-controlled judge code.
