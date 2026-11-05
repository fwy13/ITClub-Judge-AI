"""Compatibility facade for registered task adapters."""

import pandas as pd

from csv_judge.adapters import GroundTruth, Prediction, get_task_adapter
from csv_judge.models import ProblemConfig


def validate_and_align(
    truth: pd.DataFrame,
    submission: pd.DataFrame,
    config: ProblemConfig,
) -> tuple[GroundTruth, Prediction]:
    """Compatibility facade over the registered task adapter."""

    prepared = get_task_adapter(config.task_type).prepare(truth, submission, config)
    return prepared.y_true, prepared.y_pred
