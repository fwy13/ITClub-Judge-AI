"""Public orchestration entry point for judging one submission."""

import math
from pathlib import Path

from csv_judge.adapters import get_task_adapter
from csv_judge.exceptions import JudgeInternalError, SubmissionError
from csv_judge.loader import load_ground_truth, load_problem_config, load_submission
from csv_judge.metric_registry import validate_metric_config
from csv_judge.result import JudgeResult


def judge_submission(
    problem_dir: str | Path,
    submission_path: str | Path,
) -> JudgeResult:
    problem_dir = Path(problem_dir)
    submission_path = Path(submission_path)

    try:
        config = load_problem_config(problem_dir)
        truth = load_ground_truth(problem_dir, config)
        submission = load_submission(submission_path, config)
        prepared = get_task_adapter(config.task_type).prepare(
            truth,
            submission,
            config,
        )
        metric = validate_metric_config(config)
        score = metric.calculate(prepared, config)
        if not math.isfinite(score):
            raise JudgeInternalError(
                "METRIC_UNDEFINED",
                "The configured metric produced a non-finite score",
            )
        return JudgeResult(
            status="accepted",
            score=score,
            metric=config.metric,
            rows=prepared.rows,
        )
    except SubmissionError as exc:
        return JudgeResult(
            status="rejected",
            error_code=exc.code,
            message=exc.message,
            examples=exc.examples,
        )
    except JudgeInternalError as exc:
        return JudgeResult(
            status="failed",
            error_code=exc.code,
            message=exc.message,
        )
    except Exception:
        return JudgeResult(
            status="failed",
            error_code="INTERNAL_JUDGE_ERROR",
            message="An unexpected internal error occurred while judging",
        )


def validate_problem(problem_dir: str | Path) -> JudgeResult:
    """Validate private data and the problem's sample submission end to end."""

    problem_dir = Path(problem_dir)
    result = judge_submission(problem_dir, problem_dir / "sample_submission.csv")
    if result.status == "rejected":
        return JudgeResult(
            status="failed",
            error_code="INVALID_SAMPLE_SUBMISSION",
            message=f"Sample submission is invalid: {result.error_code}: {result.message}",
            examples=result.examples,
        )
    return result
