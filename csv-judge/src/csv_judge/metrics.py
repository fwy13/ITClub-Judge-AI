"""Compatibility facade for the metric registry."""

from csv_judge.adapters import GroundTruth, Prediction, PreparedData
from csv_judge.metric_registry import validate_metric_config
from csv_judge.models import ProblemConfig


def calculate_metric(
    y_true: GroundTruth,
    y_pred: Prediction,
    config: ProblemConfig,
) -> float:
    """Compatibility facade over the registered metric implementation."""

    metric = validate_metric_config(config)
    return metric.calculate(PreparedData(y_true, y_pred), config)
