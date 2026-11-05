import json

import pytest

from csv_judge.cli import main
from csv_judge.judge import judge_submission, validate_problem


def make_problem(tmp_path, *, task, metric, truth, submission, columns, higher):
    problem = tmp_path / f"{task}-{metric}"
    problem.mkdir()
    config = {
        "version": 1,
        "id_column": "id",
        "target_column": "target",
        "prediction_columns": columns,
        "task_type": task,
        "metric": metric,
        "greater_is_better": higher,
        "max_file_size_mb": 1,
        "max_rows": 100,
        "allow_extra_columns": False,
    }
    (problem / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (problem / "ground_truth.csv").write_text(truth, encoding="utf-8")
    (problem / "sample_submission.csv").write_text(submission, encoding="utf-8")
    return problem


@pytest.mark.parametrize(
    ("metric", "expected"),
    [
        ("mse", 1.0),
        ("rmse", 1.0),
        ("mae", 1.0),
        ("mape", 0.375),
        ("smape", (2 / 3 + 2 / 9) / 2),
    ],
)
def test_extended_regression_metrics(tmp_path, metric, expected):
    problem = make_problem(
        tmp_path,
        task="regression",
        metric=metric,
        truth="id,target\n001,2\n002,4\n",
        submission="id,prediction\n001,1\n002,5\n",
        columns=["prediction"],
        higher=False,
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(expected)


@pytest.mark.parametrize(
    ("metric", "expected"),
    [
        ("precision", 0.5),
        ("recall", 1.0),
        ("balanced_accuracy", 0.5),
    ],
)
def test_extended_binary_metrics(tmp_path, metric, expected):
    problem = make_problem(
        tmp_path,
        task="binary_probability",
        metric=metric,
        truth="id,target\n001,1\n002,0\n",
        submission="id,prediction\n001,0.9\n002,0.8\n",
        columns=["prediction"],
        higher=True,
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(expected)


@pytest.mark.parametrize("metric", ["macro_precision", "macro_recall"])
def test_extended_multiclass_metrics(tmp_path, metric):
    problem = make_problem(
        tmp_path,
        task="multiclass_probability",
        metric=metric,
        truth="id,target\n001,cat\n002,dog\n003,bird\n",
        submission=(
            "id,cat,dog,bird\n"
            "001,0.8,0.1,0.1\n"
            "002,0.1,0.8,0.1\n"
            "003,0.1,0.1,0.8\n"
        ),
        columns=["cat", "dog", "bird"],
        higher=True,
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(1.0)


@pytest.mark.parametrize("metric", ["sacrebleu", "chrf"])
def test_text_metrics_score_exact_match_as_100(tmp_path, metric):
    problem = make_problem(
        tmp_path,
        task="text_generation",
        metric=metric,
        truth=(
            "id,target\n"
            "001,the cat is sitting on the mat\n"
            "002,machine learning needs good data\n"
        ),
        submission=(
            "id,prediction\n"
            "002,machine learning needs good data\n"
            "001,the cat is sitting on the mat\n"
        ),
        columns=["prediction"],
        higher=True,
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(100.0)


def test_unknown_metric_is_invalid_config(tmp_path):
    problem = make_problem(
        tmp_path,
        task="regression",
        metric="mystery_score",
        truth="id,target\n001,1\n",
        submission="id,prediction\n001,1\n",
        columns=["prediction"],
        higher=False,
    )

    result = validate_problem(problem)

    assert result.status == "failed"
    assert result.error_code == "INVALID_CONFIG"


def test_incompatible_task_metric_is_invalid_config(tmp_path):
    problem = make_problem(
        tmp_path,
        task="regression",
        metric="sacrebleu",
        truth="id,target\n001,1\n",
        submission="id,prediction\n001,1\n",
        columns=["prediction"],
        higher=True,
    )

    result = validate_problem(problem)

    assert result.status == "failed"
    assert result.error_code == "INVALID_CONFIG"


def test_capabilities_cli_reports_registered_combinations(capsys):
    exit_code = main(["list-capabilities", "--output", "json"])
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert "rmse" in payload["regression"]
    assert "sacrebleu" in payload["text_generation"]
    assert "macro_f1" in payload["multiclass_probability"]
