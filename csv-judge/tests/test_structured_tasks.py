import json
import math

import pytest

from csv_judge.judge import judge_submission


def make_problem(tmp_path, config, truth, submission):
    problem = tmp_path / config["task_type"]
    problem.mkdir()
    (problem / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (problem / "ground_truth.csv").write_text(truth, encoding="utf-8")
    (problem / "sample_submission.csv").write_text(submission, encoding="utf-8")
    return problem


def multilabel_config(metric):
    return {
        "version": 1,
        "id_column": "id",
        "target_column": "unused",
        "target_columns": ["true_a", "true_b"],
        "prediction_columns": ["a", "b"],
        "task_type": "multilabel_probability",
        "metric": metric,
        "greater_is_better": metric != "hamming_loss",
        "binary_threshold": 0.5,
        "max_file_size_mb": 1,
        "max_rows": 100,
        "allow_extra_columns": False,
    }


@pytest.mark.parametrize(
    ("metric", "expected"),
    [
        ("micro_f1", 0.8),
        ("macro_f1", (1.0 + 2 / 3) / 2),
        ("hamming_loss", 0.25),
    ],
)
def test_multilabel_metrics(tmp_path, metric, expected):
    problem = make_problem(
        tmp_path,
        multilabel_config(metric),
        "id,true_a,true_b\n001,1,0\n002,0,1\n",
        "id,a,b\n002,0.1,0.9\n001,0.9,0.8\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(expected)


def ranking_config(metric, k=2):
    return {
        "version": 1,
        "id_column": "query_id",
        "item_column": "item_id",
        "target_column": "relevance",
        "prediction_columns": ["score"],
        "task_type": "ranking",
        "metric": metric,
        "greater_is_better": True,
        "max_file_size_mb": 1,
        "max_rows": 100,
        "allow_extra_columns": False,
        "metric_options": {"k": k},
    }


RANKING_TRUTH = (
    "query_id,item_id,relevance\n"
    "q1,a,1\nq1,b,0\nq1,c,1\n"
    "q2,d,0\nq2,e,1\n"
)
RANKING_SUBMISSION = (
    "query_id,item_id,score\n"
    "q2,e,0.9\nq1,c,0.7\nq1,b,0.9\nq2,d,0.1\nq1,a,0.8\n"
)


@pytest.mark.parametrize(
    ("metric", "expected"),
    [
        ("mrr", (0.5 + 1.0) / 2),
        ("map", (((1 / 2 + 2 / 3) / 2) + 1.0) / 2),
        ("recall_at_k", (0.5 + 1.0) / 2),
        (
            "ndcg_at_k",
            (((1 / math.log2(3)) / (1 + 1 / math.log2(3))) + 1.0) / 2,
        ),
    ],
)
def test_ranking_metrics(tmp_path, metric, expected):
    problem = make_problem(
        tmp_path,
        ranking_config(metric),
        RANKING_TRUTH,
        RANKING_SUBMISSION,
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(expected)


def test_ranking_rejects_duplicate_query_item_pair(tmp_path):
    problem = make_problem(
        tmp_path,
        ranking_config("mrr"),
        RANKING_TRUTH,
        (
            "query_id,item_id,score\n"
            "q1,a,0.8\nq1,a,0.7\nq1,c,0.6\nq2,d,0.1\nq2,e,0.9\n"
        ),
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "rejected"
    assert result.error_code == "DUPLICATE_IDS"


def test_ranking_ties_are_broken_by_item_id_not_private_row_order(tmp_path):
    problem = make_problem(
        tmp_path,
        ranking_config("mrr"),
        "query_id,item_id,relevance\nq1,b,0\nq1,a,1\n",
        "query_id,item_id,score\nq1,b,0.5\nq1,a,0.5\n",
    )

    result = judge_submission(problem, problem / "sample_submission.csv")

    assert result.status == "accepted"
    assert result.score == pytest.approx(1.0)
