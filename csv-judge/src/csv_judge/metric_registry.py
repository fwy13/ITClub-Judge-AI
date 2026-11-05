"""Built-in metric implementations and their registry metadata."""

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd
import sacrebleu
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    f1_score,
    hamming_loss,
    log_loss,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
)

from csv_judge.adapters import PreparedData
from csv_judge.exceptions import JudgeInternalError
from csv_judge.models import ProblemConfig

MetricFunction = Callable[[PreparedData, ProblemConfig], float]


@dataclass(frozen=True, slots=True)
class MetricSpec:
    name: str
    tasks: frozenset[str]
    greater_is_better: bool
    calculate: MetricFunction


def _probabilities(data: PreparedData) -> np.ndarray:
    return np.asarray(data.y_pred, dtype=float)


def _binary_labels(data: PreparedData, config: ProblemConfig) -> np.ndarray:
    return (_probabilities(data) >= config.binary_threshold).astype(int)


def metric_log_loss(data: PreparedData, config: ProblemConfig) -> float:
    epsilon = 1e-15
    if config.task_type == "binary_probability":
        clipped = np.clip(_probabilities(data), epsilon, 1.0 - epsilon)
        return float(log_loss(data.y_true, clipped, labels=[0, 1]))

    if not isinstance(data.y_pred, pd.DataFrame):
        raise JudgeInternalError(
            "INTERNAL_JUDGE_ERROR",
            "Multiclass predictions must be a table",
        )
    ordered_labels = sorted(config.prediction_columns)
    clipped = np.clip(
        data.y_pred[ordered_labels].to_numpy(dtype=float),
        epsilon,
        1.0,
    )
    normalized = clipped / clipped.sum(axis=1, keepdims=True)
    return float(log_loss(data.y_true, normalized, labels=ordered_labels))


def metric_accuracy(data: PreparedData, config: ProblemConfig) -> float:
    if config.task_type == "binary_probability":
        labels = _binary_labels(data, config)
    else:
        if not isinstance(data.y_pred, pd.DataFrame):
            raise JudgeInternalError(
                "INTERNAL_JUDGE_ERROR",
                "Multiclass predictions must be a table",
            )
        labels = data.y_pred.idxmax(axis=1)
    return float(accuracy_score(data.y_true, labels))


def metric_binary_f1(data: PreparedData, config: ProblemConfig) -> float:
    return float(
        f1_score(
            data.y_true,
            _binary_labels(data, config),
            zero_division=0,
        )
    )


def metric_binary_precision(data: PreparedData, config: ProblemConfig) -> float:
    return float(
        precision_score(
            data.y_true,
            _binary_labels(data, config),
            zero_division=0,
        )
    )


def metric_binary_recall(data: PreparedData, config: ProblemConfig) -> float:
    return float(
        recall_score(
            data.y_true,
            _binary_labels(data, config),
            zero_division=0,
        )
    )


def metric_balanced_accuracy(data: PreparedData, config: ProblemConfig) -> float:
    return float(
        balanced_accuracy_score(data.y_true, _binary_labels(data, config))
    )


def _multiclass_labels(data: PreparedData) -> pd.Series:
    if not isinstance(data.y_pred, pd.DataFrame):
        raise JudgeInternalError(
            "INTERNAL_JUDGE_ERROR",
            "Multiclass predictions must be a table",
        )
    return data.y_pred.idxmax(axis=1)


def metric_macro_f1(data: PreparedData, config: ProblemConfig) -> float:
    if config.task_type == "multilabel_probability":
        if not isinstance(data.y_true, pd.DataFrame) or not isinstance(
            data.y_pred, pd.DataFrame
        ):
            raise JudgeInternalError(
                "INTERNAL_JUDGE_ERROR",
                "Multilabel data must be tables",
            )
        labels = (data.y_pred >= config.binary_threshold).astype(int)
        return float(
            f1_score(
                data.y_true,
                labels,
                average="macro",
                zero_division=0,
            )
        )
    return float(
        f1_score(
            data.y_true,
            _multiclass_labels(data),
            labels=config.prediction_columns,
            average="macro",
            zero_division=0,
        )
    )


def metric_micro_f1(data: PreparedData, config: ProblemConfig) -> float:
    if not isinstance(data.y_true, pd.DataFrame) or not isinstance(
        data.y_pred, pd.DataFrame
    ):
        raise JudgeInternalError(
            "INTERNAL_JUDGE_ERROR",
            "Multilabel data must be tables",
        )
    labels = (data.y_pred >= config.binary_threshold).astype(int)
    return float(
        f1_score(data.y_true, labels, average="micro", zero_division=0)
    )


def metric_hamming_loss(data: PreparedData, config: ProblemConfig) -> float:
    if not isinstance(data.y_true, pd.DataFrame) or not isinstance(
        data.y_pred, pd.DataFrame
    ):
        raise JudgeInternalError(
            "INTERNAL_JUDGE_ERROR",
            "Multilabel data must be tables",
        )
    labels = (data.y_pred >= config.binary_threshold).astype(int)
    return float(hamming_loss(data.y_true, labels))


def metric_macro_precision(data: PreparedData, config: ProblemConfig) -> float:
    return float(
        precision_score(
            data.y_true,
            _multiclass_labels(data),
            labels=config.prediction_columns,
            average="macro",
            zero_division=0,
        )
    )


def metric_macro_recall(data: PreparedData, config: ProblemConfig) -> float:
    return float(
        recall_score(
            data.y_true,
            _multiclass_labels(data),
            labels=config.prediction_columns,
            average="macro",
            zero_division=0,
        )
    )


def metric_mae(data: PreparedData, config: ProblemConfig) -> float:
    return float(mean_absolute_error(data.y_true, data.y_pred))


def metric_mse(data: PreparedData, config: ProblemConfig) -> float:
    return float(mean_squared_error(data.y_true, data.y_pred))


def metric_rmse(data: PreparedData, config: ProblemConfig) -> float:
    return float(mean_squared_error(data.y_true, data.y_pred) ** 0.5)


def metric_r2(data: PreparedData, config: ProblemConfig) -> float:
    if data.rows < 2:
        raise JudgeInternalError(
            "METRIC_UNDEFINED",
            "R2 requires at least two ground-truth rows",
        )
    return float(r2_score(data.y_true, data.y_pred))


def metric_mape(data: PreparedData, config: ProblemConfig) -> float:
    epsilon = float(config.metric_options.get("epsilon", 1e-8))
    if epsilon <= 0:
        raise JudgeInternalError(
            "INVALID_CONFIG",
            "metric_options.epsilon must be greater than zero",
        )
    truth = data.y_true.to_numpy(dtype=float)
    prediction = np.asarray(data.y_pred, dtype=float)
    denominator = np.maximum(np.abs(truth), epsilon)
    return float(np.mean(np.abs(truth - prediction) / denominator))


def metric_smape(data: PreparedData, config: ProblemConfig) -> float:
    truth = data.y_true.to_numpy(dtype=float)
    prediction = np.asarray(data.y_pred, dtype=float)
    denominator = np.abs(truth) + np.abs(prediction)
    terms = np.divide(
        2.0 * np.abs(truth - prediction),
        denominator,
        out=np.zeros_like(denominator, dtype=float),
        where=denominator != 0,
    )
    return float(np.mean(terms))


def metric_sacrebleu(data: PreparedData, config: ProblemConfig) -> float:
    hypotheses = data.y_pred.astype(str).tolist()
    references = [data.y_true.astype(str).tolist()]
    tokenize = str(config.metric_options.get("tokenize", "13a"))
    lowercase = bool(config.metric_options.get("lowercase", False))
    score = float(
        sacrebleu.corpus_bleu(
            hypotheses,
            references,
            tokenize=tokenize,
            lowercase=lowercase,
        ).score
    )
    return min(100.0, max(0.0, score))


def metric_chrf(data: PreparedData, config: ProblemConfig) -> float:
    hypotheses = data.y_pred.astype(str).tolist()
    reference_sentences = data.y_true.astype(str).tolist()
    if bool(config.metric_options.get("lowercase", False)):
        hypotheses = [sentence.lower() for sentence in hypotheses]
        reference_sentences = [sentence.lower() for sentence in reference_sentences]
    references = [reference_sentences]
    score = float(
        sacrebleu.corpus_chrf(
            hypotheses,
            references,
            char_order=int(config.metric_options.get("char_order", 6)),
            word_order=int(config.metric_options.get("word_order", 0)),
            beta=int(config.metric_options.get("beta", 2)),
            remove_whitespace=bool(
                config.metric_options.get("remove_whitespace", True)
            ),
        ).score
    )
    return min(100.0, max(0.0, score))


def _ranking_frame(data: PreparedData, config: ProblemConfig) -> pd.DataFrame:
    if data.metadata is None:
        raise JudgeInternalError(
            "INTERNAL_JUDGE_ERROR",
            "Ranking data is missing query/item metadata",
        )
    frame = data.metadata.copy()
    frame["__relevance"] = np.asarray(data.y_true, dtype=float)
    frame["__score"] = np.asarray(data.y_pred, dtype=float)
    return frame


def _ranking_k(config: ProblemConfig) -> int:
    try:
        value = int(config.metric_options.get("k", 10))
    except (TypeError, ValueError) as exc:
        raise JudgeInternalError(
            "INVALID_CONFIG",
            "metric_options.k must be a positive integer",
        ) from exc
    if value <= 0:
        raise JudgeInternalError(
            "INVALID_CONFIG",
            "metric_options.k must be a positive integer",
        )
    return value


def _ranked_group(group: pd.DataFrame, config: ProblemConfig) -> pd.DataFrame:
    item_column = config.item_column
    if item_column is None:
        raise JudgeInternalError(
            "INVALID_CONFIG",
            "ranking requires item_column",
        )
    return group.sort_values(
        ["__score", item_column],
        ascending=[False, True],
        kind="mergesort",
    )


def metric_mrr(data: PreparedData, config: ProblemConfig) -> float:
    frame = _ranking_frame(data, config)
    values: list[float] = []
    for _, group in frame.groupby(config.id_column, sort=False):
        ranked = _ranked_group(group, config)
        relevant = ranked["__relevance"].to_numpy() > 0
        positions = np.flatnonzero(relevant)
        values.append(0.0 if len(positions) == 0 else 1.0 / (positions[0] + 1))
    return float(np.mean(values))


def metric_map(data: PreparedData, config: ProblemConfig) -> float:
    frame = _ranking_frame(data, config)
    values: list[float] = []
    for _, group in frame.groupby(config.id_column, sort=False):
        ranked = _ranked_group(group, config)
        relevant = ranked["__relevance"].to_numpy() > 0
        relevant_count = int(relevant.sum())
        if relevant_count == 0:
            values.append(0.0)
            continue
        precision_at_rank = np.cumsum(relevant) / np.arange(1, len(relevant) + 1)
        values.append(float(precision_at_rank[relevant].sum() / relevant_count))
    return float(np.mean(values))


def metric_recall_at_k(data: PreparedData, config: ProblemConfig) -> float:
    frame = _ranking_frame(data, config)
    k = _ranking_k(config)
    values: list[float] = []
    for _, group in frame.groupby(config.id_column, sort=False):
        ranked = _ranked_group(group, config)
        relevant = ranked["__relevance"].to_numpy() > 0
        total = int(relevant.sum())
        values.append(0.0 if total == 0 else float(relevant[:k].sum() / total))
    return float(np.mean(values))


def metric_ndcg_at_k(data: PreparedData, config: ProblemConfig) -> float:
    frame = _ranking_frame(data, config)
    k = _ranking_k(config)
    values: list[float] = []
    for _, group in frame.groupby(config.id_column, sort=False):
        ranked = _ranked_group(group, config)
        relevance = ranked["__relevance"].to_numpy(dtype=float)[:k]
        ideal = np.sort(group["__relevance"].to_numpy(dtype=float))[::-1][:k]
        discounts = np.log2(np.arange(2, len(relevance) + 2))
        ideal_discounts = np.log2(np.arange(2, len(ideal) + 2))
        dcg = np.sum((np.power(2.0, relevance) - 1.0) / discounts)
        idcg = np.sum((np.power(2.0, ideal) - 1.0) / ideal_discounts)
        values.append(0.0 if idcg == 0 else float(dcg / idcg))
    return float(np.mean(values))


def _spec(
    name: str,
    tasks: set[str],
    greater_is_better: bool,
    calculate: MetricFunction,
) -> MetricSpec:
    return MetricSpec(name, frozenset(tasks), greater_is_better, calculate)


METRICS: dict[str, MetricSpec] = {
    spec.name: spec
    for spec in (
        _spec("log_loss", {"binary_probability", "multiclass_probability"}, False, metric_log_loss),
        _spec("accuracy", {"binary_probability", "multiclass_probability"}, True, metric_accuracy),
        _spec("f1", {"binary_probability"}, True, metric_binary_f1),
        _spec("precision", {"binary_probability"}, True, metric_binary_precision),
        _spec("recall", {"binary_probability"}, True, metric_binary_recall),
        _spec("balanced_accuracy", {"binary_probability"}, True, metric_balanced_accuracy),
        _spec("macro_f1", {"multiclass_probability", "multilabel_probability"}, True, metric_macro_f1),
        _spec("micro_f1", {"multilabel_probability"}, True, metric_micro_f1),
        _spec("hamming_loss", {"multilabel_probability"}, False, metric_hamming_loss),
        _spec("macro_precision", {"multiclass_probability"}, True, metric_macro_precision),
        _spec("macro_recall", {"multiclass_probability"}, True, metric_macro_recall),
        _spec("mae", {"regression"}, False, metric_mae),
        _spec("mse", {"regression"}, False, metric_mse),
        _spec("rmse", {"regression"}, False, metric_rmse),
        _spec("r2", {"regression"}, True, metric_r2),
        _spec("mape", {"regression"}, False, metric_mape),
        _spec("smape", {"regression"}, False, metric_smape),
        _spec("sacrebleu", {"text_generation"}, True, metric_sacrebleu),
        _spec("chrf", {"text_generation"}, True, metric_chrf),
        _spec("mrr", {"ranking"}, True, metric_mrr),
        _spec("map", {"ranking"}, True, metric_map),
        _spec("recall_at_k", {"ranking"}, True, metric_recall_at_k),
        _spec("ndcg_at_k", {"ranking"}, True, metric_ndcg_at_k),
    )
}


def get_metric_spec(name: str) -> MetricSpec:
    try:
        return METRICS[name]
    except KeyError as exc:
        raise ValueError(f"unsupported metric '{name}'") from exc


def validate_metric_config(config: ProblemConfig) -> MetricSpec:
    spec = get_metric_spec(config.metric)
    if config.task_type not in spec.tasks:
        raise ValueError(
            f"metric '{config.metric}' is incompatible with {config.task_type}"
        )
    if config.greater_is_better != spec.greater_is_better:
        raise ValueError(
            f"greater_is_better must be {spec.greater_is_better} for metric "
            f"'{config.metric}'"
        )
    return spec
