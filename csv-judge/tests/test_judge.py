import json

import pandas as pd
import pytest
from sklearn.metrics import log_loss

from csv_judge.cli import main
from csv_judge.judge import judge_submission


def create_problem(tmp_path):
    problem_dir = tmp_path / "problem"
    problem_dir.mkdir()
    config = {
        "version": 1,
        "id_column": "id",
        "target_column": "label",
        "prediction_columns": ["prediction"],
        "task_type": "binary_probability",
        "metric": "log_loss",
        "greater_is_better": False,
        "max_file_size_mb": 1,
        "max_rows": 100,
        "allow_extra_columns": False,
    }
    (problem_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (problem_dir / "ground_truth.csv").write_text(
        "id,label\n001,1\n002,0\n003,1\n",
        encoding="utf-8",
    )
    return problem_dir


def write_submission(tmp_path, content):
    path = tmp_path / "submission.csv"
    path.write_text(content, encoding="utf-8")
    return path


def test_scores_valid_submission(tmp_path):
    problem = create_problem(tmp_path)
    submission = write_submission(
        tmp_path,
        "id,prediction\n001,0.9\n002,0.2\n003,0.8\n",
    )

    result = judge_submission(problem, submission)

    expected = log_loss([1, 0, 1], [0.9, 0.2, 0.8], labels=[0, 1])
    assert result.status == "accepted"
    assert result.score == pytest.approx(expected)
    assert result.metric == "log_loss"
    assert result.rows == 3


def test_row_order_does_not_change_score(tmp_path):
    problem = create_problem(tmp_path)
    ordered = write_submission(
        tmp_path,
        "id,prediction\n001,0.9\n002,0.2\n003,0.8\n",
    )
    first = judge_submission(problem, ordered)

    shuffled = write_submission(
        tmp_path,
        "id,prediction\n003,0.8\n001,0.9\n002,0.2\n",
    )
    second = judge_submission(problem, shuffled)

    assert first.status == second.status == "accepted"
    assert first.score == pytest.approx(second.score)


@pytest.mark.parametrize(
    ("content", "error_code"),
    [
        ("id,prediction\n001,0.9\n001,0.8\n002,0.2\n", "DUPLICATE_IDS"),
        ("id,prediction\n001,0.9\n002,0.2\n", "MISSING_IDS"),
        (
            "id,prediction\n001,0.9\n002,0.2\n003,0.8\n999,0.1\n",
            "UNKNOWN_IDS",
        ),
        ("id,prediction\n001,abc\n002,0.2\n003,0.8\n", "INVALID_NUMBER"),
        ("id,prediction\n001,nan\n002,0.2\n003,0.8\n", "INVALID_NUMBER"),
        ("id,prediction\n001,inf\n002,0.2\n003,0.8\n", "NON_FINITE_NUMBER"),
        ("id,prediction\n001,1.2\n002,0.2\n003,0.8\n", "VALUE_OUT_OF_RANGE"),
        ("id,score\n001,0.9\n002,0.2\n003,0.8\n", "MISSING_COLUMNS"),
    ],
)
def test_rejects_invalid_submissions(tmp_path, content, error_code):
    problem = create_problem(tmp_path)
    submission = write_submission(tmp_path, content)

    result = judge_submission(problem, submission)

    assert result.status == "rejected"
    assert result.error_code == error_code


def test_keeps_leading_zeroes_in_ids(tmp_path):
    problem = create_problem(tmp_path)
    submission = write_submission(
        tmp_path,
        "id,prediction\n1,0.9\n002,0.2\n003,0.8\n",
    )

    result = judge_submission(problem, submission)

    assert result.status == "rejected"
    assert result.error_code == "MISSING_IDS"
    assert "001" in result.examples


def test_cli_returns_json_and_success_code(tmp_path, capsys):
    problem = create_problem(tmp_path)
    submission = write_submission(
        tmp_path,
        "id,prediction\n001,0.9\n002,0.2\n003,0.8\n",
    )

    exit_code = main(
        [
            "score",
            "--problem",
            str(problem),
            "--submission",
            str(submission),
            "--output",
            "json",
        ]
    )
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert payload["status"] == "accepted"
    assert isinstance(payload["score"], float)
