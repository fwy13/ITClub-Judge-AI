"""CSV Judge public API."""

from csv_judge.judge import judge_submission, validate_problem
from csv_judge.result import JudgeResult

__all__ = ["JudgeResult", "judge_submission", "validate_problem"]
