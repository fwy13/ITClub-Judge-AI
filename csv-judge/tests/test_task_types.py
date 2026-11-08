import json
import math

import pytest
from sklearn.metrics import mean_squared_error

from csv_judge.judge import judge_submission, validate_problem


def make_problem(tmp_path, config, truth, sample):
    problem = tmp_path / "problem"
    problem.mkdir()
    (problem / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (problem / "ground_truth.csv").write_text(truth, encoding="utf-8")
    (problem / "sample_submission.csv").write_text(sample, encoding="utf-8")
    return problem


def base_config(task_type, metric, prediction_columns):
    return {
        "version": 1,
        "id_column": "id",
        "target_column": "target",
        "prediction_columns": prediction_columns,
        "task_type": task_type,
        "metric": metric,
        "greater_is_better": metric in {"accuracy", "f1", "macro_f1", "r2"},
        "max_file_size_mb": 1,
        "max_rows": 100,
        "allow_extra_columns": False,
    }


@pytest.mark.parametrize("metric", ["mae", "rmse", "r2"])
def test_regression_metrics(tmp_path, metric):
    config = base_config("regression", metric, ["prediction"])
    truth = "id,target\n001,1.0\n002,2.0\n003,4.0\n"
    sample = "id,prediction\n003,3.5\n001,1.5\n002,2.5\n"
    problem = make_problem(tmp_path, config, truth, sample)

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.rows == 3
    if metric == "rmse":
        expected = mean_squared_error([1.0, 2.0, 4.0], [1.5, 2.5, 3.5]) ** 0.5
        assert result.score == pytest.approx(expected)


@pytest.mark.parametrize("metric", ["log_loss", "accuracy", "macro_f1"])
def test_multiclass_metrics(tmp_path, metric):
    config = base_config(
        "multiclass_probability",
        metric,
        ["cat", "dog", "bird"],
    )
    truth = "id,target\n001,cat\n002,dog\n003,bird\n"
    sample = (
        "id,cat,dog,bird\n"
        "001,0.8,0.1,0.1\n"
        "002,0.1,0.7,0.2\n"
        "003,0.1,0.2,0.7\n"
    )
    problem = make_problem(tmp_path, config, truth, sample)

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    if metric == "log_loss":
        expected = -(math.log(0.8) + math.log(0.7) + math.log(0.7)) / 3
        assert result.score == pytest.approx(expected)
    else:
        assert result.score == pytest.approx(1.0)


def test_rejects_invalid_multiclass_probability_sum(tmp_path):
    config = base_config(
        "multiclass_probability",
        "log_loss",
        ["cat", "dog"],
    )
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,cat\n002,dog\n",
        "id,cat,dog\n001,0.8,0.8\n002,0.1,0.9\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "rejected"
    assert result.error_code == "INVALID_PROBABILITY_SUM"


@pytest.mark.parametrize("metric", ["accuracy", "macro_f1"])
def test_multiclass_label_metrics(tmp_path, metric):
    config = base_config("multiclass_label", metric, ["label"])
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,0\n002,1\n003,2\n",
        "id,label\n003,2\n001,0\n002,1\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(1.0)


def test_multiclass_label_rejects_unknown_label(tmp_path):
    config = base_config("multiclass_label", "accuracy", ["label"])
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,cat\n002,dog\n",
        "id,label\n001,cat\n002,bird\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "rejected"
    assert result.error_code == "UNKNOWN_LABEL"


def test_rejects_non_finite_regression_value(tmp_path):
    config = base_config("regression", "rmse", ["prediction"])
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,1.0\n002,2.0\n",
        "id,prediction\n001,inf\n002,2.0\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "rejected"
    assert result.error_code == "NON_FINITE_NUMBER"


def test_validate_problem_accepts_valid_sample(tmp_path):
    config = base_config("regression", "mae", ["prediction"])
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,1.0\n",
        "id,prediction\n001,1.2\n",
    )

    result = validate_problem(problem)

    assert result.status == "accepted"


def test_validate_problem_converts_bad_sample_to_internal_failure(tmp_path):
    config = base_config("regression", "mae", ["prediction"])
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,1.0\n",
        "id,prediction\n002,1.2\n",
    )

    result = validate_problem(problem)

    assert result.status == "failed"
    assert result.error_code == "INVALID_SAMPLE_SUBMISSION"


def test_rejects_wrong_metric_direction_in_config(tmp_path):
    config = base_config("regression", "rmse", ["prediction"])
    config["greater_is_better"] = True
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,1.0\n002,2.0\n",
        "id,prediction\n001,1.0\n002,2.0\n",
    )

    result = validate_problem(problem)

    assert result.status == "failed"
    assert result.error_code == "INVALID_CONFIG"


def test_undefined_r2_is_an_internal_failure(tmp_path):
    config = base_config("regression", "r2", ["prediction"])
    problem = make_problem(
        tmp_path,
        config,
        "id,target\n001,1.0\n",
        "id,prediction\n001,1.0\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "failed"
    assert result.error_code == "METRIC_UNDEFINED"
