"""Task adapters validate and normalize task-specific CSV data."""

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np
import pandas as pd

from csv_judge.exceptions import JudgeInternalError, SubmissionError
from csv_judge.models import ProblemConfig

Prediction = pd.Series | pd.DataFrame
GroundTruth = pd.Series | pd.DataFrame


@dataclass(frozen=True, slots=True)
class PreparedData:
    y_true: GroundTruth
    y_pred: Prediction
    metadata: pd.DataFrame | None = None

    @property
    def rows(self) -> int:
        return len(self.y_true)


def _examples(values: pd.Series, limit: int = 5) -> list[str]:
    return [str(value) for value in values.head(limit).tolist()]


def _validate_schema_and_ids(
    truth: pd.DataFrame,
    submission: pd.DataFrame,
    config: ProblemConfig,
) -> None:
    expected_columns = {config.id_column, *config.prediction_columns}
    actual_columns = set(submission.columns)
    missing_columns = sorted(expected_columns - actual_columns)
    if missing_columns:
        raise SubmissionError(
            "MISSING_COLUMNS",
            f"Submission is missing required columns: {missing_columns}",
            missing_columns[:5],
        )

    extra_columns = sorted(actual_columns - expected_columns)
    if extra_columns and not config.allow_extra_columns:
        raise SubmissionError(
            "EXTRA_COLUMNS",
            f"Submission contains unexpected columns: {extra_columns}",
            extra_columns[:5],
        )

    submitted_ids = submission[config.id_column]
    truth_ids = truth[config.id_column]
    if submitted_ids.str.strip().eq("").any():
        raise SubmissionError(
            "EMPTY_ID",
            f"Column '{config.id_column}' contains empty IDs",
        )
    duplicate_ids = submitted_ids.duplicated(keep=False)
    if duplicate_ids.any():
        raise SubmissionError(
            "DUPLICATE_IDS",
            f"Column '{config.id_column}' contains duplicate IDs",
            _examples(submitted_ids.loc[duplicate_ids].drop_duplicates()),
        )

    if truth_ids.str.strip().eq("").any():
        raise JudgeInternalError("INVALID_GROUND_TRUTH", "Ground truth has empty IDs")
    if truth_ids.duplicated().any():
        raise JudgeInternalError("INVALID_GROUND_TRUTH", "Ground truth has duplicate IDs")

    expected_ids = set(truth_ids.tolist())
    actual_ids = set(submitted_ids.tolist())
    missing_ids = sorted(expected_ids - actual_ids)
    unknown_ids = sorted(actual_ids - expected_ids)
    if missing_ids:
        raise SubmissionError(
            "MISSING_IDS",
            f"Submission is missing {len(missing_ids)} required IDs",
            missing_ids[:5],
        )
    if unknown_ids:
        raise SubmissionError(
            "UNKNOWN_IDS",
            f"Submission contains {len(unknown_ids)} unknown IDs",
            unknown_ids[:5],
        )


def _numeric_frame(submission: pd.DataFrame, config: ProblemConfig) -> pd.DataFrame:
    raw = submission[config.prediction_columns]
    empty = raw.apply(lambda column: column.str.strip().eq(""))
    numeric = raw.apply(pd.to_numeric, errors="coerce")
    invalid = empty | numeric.isna()
    if invalid.any(axis=None):
        raise SubmissionError(
            "INVALID_NUMBER",
            "Prediction columns contain empty or non-numeric values",
            _examples(submission.loc[invalid.any(axis=1), config.id_column]),
        )

    finite = np.isfinite(numeric.to_numpy(dtype=float))
    if not finite.all():
        raise SubmissionError(
            "NON_FINITE_NUMBER",
            "Prediction columns contain NaN or Infinity",
            _examples(submission.loc[~finite.all(axis=1), config.id_column]),
        )
    return numeric.astype(float)


def _align(
    truth: pd.DataFrame,
    submission: pd.DataFrame,
    config: ProblemConfig,
    targets: pd.Series,
    predictions: pd.DataFrame,
) -> pd.DataFrame:
    private = truth[[config.id_column]].copy()
    private[config.target_column] = targets
    prepared = submission[[config.id_column]].copy()
    for column in config.prediction_columns:
        prepared[column] = predictions[column]
    return private.merge(
        prepared,
        on=config.id_column,
        how="left",
        validate="one_to_one",
        sort=False,
    )


class TaskAdapter(ABC):
    name: str

    @abstractmethod
    def validate_config(self, config: ProblemConfig) -> None:
        """Raise ValueError when the task-specific config is invalid."""

    def required_truth_columns(self, config: ProblemConfig) -> list[str]:
        return [config.target_column]

    @abstractmethod
    def prepare(
        self,
        truth: pd.DataFrame,
        submission: pd.DataFrame,
        config: ProblemConfig,
    ) -> PreparedData:
        """Validate and align private targets with submission predictions."""


class SingleNumericAdapter(TaskAdapter):
    def validate_config(self, config: ProblemConfig) -> None:
        if len(config.prediction_columns) != 1:
            raise ValueError(f"{self.name} requires exactly one prediction column")

    def numeric_targets(
        self,
        truth: pd.DataFrame,
        config: ProblemConfig,
    ) -> pd.Series:
        targets = pd.to_numeric(truth[config.target_column], errors="coerce")
        if targets.isna().any() or not np.isfinite(targets.to_numpy(dtype=float)).all():
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                f"{self.name} ground truth must contain finite numbers",
            )
        return targets


class RegressionAdapter(SingleNumericAdapter):
    name = "regression"

    def prepare(self, truth, submission, config) -> PreparedData:
        _validate_schema_and_ids(truth, submission, config)
        predictions = _numeric_frame(submission, config)
        targets = self.numeric_targets(truth, config).astype(float)
        aligned = _align(truth, submission, config, targets, predictions)
        return PreparedData(
            aligned[config.target_column].astype(float),
            aligned[config.prediction_columns[0]].astype(float),
        )


class BinaryProbabilityAdapter(SingleNumericAdapter):
    name = "binary_probability"

    def prepare(self, truth, submission, config) -> PreparedData:
        _validate_schema_and_ids(truth, submission, config)
        predictions = _numeric_frame(submission, config)
        outside = ((predictions < 0.0) | (predictions > 1.0)).any(axis=1)
        if outside.any():
            raise SubmissionError(
                "VALUE_OUT_OF_RANGE",
                "Probability predictions must be between 0 and 1",
                _examples(submission.loc[outside, config.id_column]),
            )
        targets = self.numeric_targets(truth, config)
        if not targets.isin([0, 1]).all():
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                "Binary ground-truth labels must be 0 or 1",
            )
        aligned = _align(truth, submission, config, targets.astype(int), predictions)
        return PreparedData(
            aligned[config.target_column].astype(int),
            aligned[config.prediction_columns[0]].astype(float),
        )


class MulticlassProbabilityAdapter(TaskAdapter):
    name = "multiclass_probability"

    def validate_config(self, config: ProblemConfig) -> None:
        if len(config.prediction_columns) < 2:
            raise ValueError(
                "multiclass_probability requires at least two prediction columns"
            )

    def prepare(self, truth, submission, config) -> PreparedData:
        _validate_schema_and_ids(truth, submission, config)
        predictions = _numeric_frame(submission, config)
        outside = ((predictions < 0.0) | (predictions > 1.0)).any(axis=1)
        if outside.any():
            raise SubmissionError(
                "VALUE_OUT_OF_RANGE",
                "Probability predictions must be between 0 and 1",
                _examples(submission.loc[outside, config.id_column]),
            )
        valid_sums = np.isclose(
            predictions.sum(axis=1).to_numpy(dtype=float),
            1.0,
            atol=config.probability_tolerance,
            rtol=0.0,
        )
        if not valid_sums.all():
            raise SubmissionError(
                "INVALID_PROBABILITY_SUM",
                "Multiclass probabilities in each row must sum to 1",
                _examples(submission.loc[~valid_sums, config.id_column]),
            )

        targets = truth[config.target_column]
        if targets.str.strip().eq("").any():
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                "Multiclass ground truth contains empty labels",
            )
        unknown = sorted(set(targets.tolist()) - set(config.prediction_columns))
        if unknown:
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                f"Ground-truth labels have no prediction column: {unknown[:5]}",
            )
        aligned = _align(
            truth,
            submission,
            config,
            targets.astype("string"),
            predictions,
        )
        return PreparedData(
            aligned[config.target_column].astype("string"),
            aligned[config.prediction_columns].astype(float),
        )


class MulticlassLabelAdapter(TaskAdapter):
    name = "multiclass_label"

    def validate_config(self, config: ProblemConfig) -> None:
        if len(config.prediction_columns) != 1:
            raise ValueError(
                "multiclass_label requires exactly one prediction column"
            )

    def prepare(self, truth, submission, config) -> PreparedData:
        _validate_schema_and_ids(truth, submission, config)
        prediction_column = config.prediction_columns[0]
        targets = truth[config.target_column].astype("string")
        predictions = submission[prediction_column].astype("string")

        if targets.str.strip().eq("").any():
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                "Multiclass ground truth contains empty labels",
            )
        empty_predictions = predictions.str.strip().eq("")
        if empty_predictions.any():
            raise SubmissionError(
                "EMPTY_LABEL",
                f"Column '{prediction_column}' contains empty labels",
                _examples(submission.loc[empty_predictions, config.id_column]),
            )

        known_labels = set(targets.tolist())
        unknown_predictions = ~predictions.isin(known_labels)
        if unknown_predictions.any():
            raise SubmissionError(
                "UNKNOWN_LABEL",
                "Submission contains labels that do not exist in ground truth",
                _examples(predictions.loc[unknown_predictions]),
            )

        prediction_frame = predictions.to_frame(name=prediction_column)
        aligned = _align(
            truth,
            submission,
            config,
            targets,
            prediction_frame,
        )
        return PreparedData(
            aligned[config.target_column].astype("string"),
            aligned[prediction_column].astype("string"),
        )


class TextGenerationAdapter(TaskAdapter):
    name = "text_generation"

    def validate_config(self, config: ProblemConfig) -> None:
        if len(config.prediction_columns) != 1:
            raise ValueError("text_generation requires exactly one prediction column")

    def prepare(self, truth, submission, config) -> PreparedData:
        _validate_schema_and_ids(truth, submission, config)
        references = truth[config.target_column]
        if references.str.strip().eq("").any():
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                "Text generation references must not be empty",
            )
        prediction_column = config.prediction_columns[0]
        text_predictions = submission[[prediction_column]].astype("string")
        aligned = _align(
            truth,
            submission,
            config,
            references.astype("string"),
            text_predictions,
        )
        return PreparedData(
            aligned[config.target_column].astype("string"),
            aligned[prediction_column].astype("string"),
        )


class MultilabelProbabilityAdapter(TaskAdapter):
    name = "multilabel_probability"

    def validate_config(self, config: ProblemConfig) -> None:
        if not config.target_columns:
            raise ValueError("multilabel_probability requires target_columns")
        if len(config.target_columns) != len(config.prediction_columns):
            raise ValueError(
                "multilabel target_columns and prediction_columns must have equal length"
            )

    def required_truth_columns(self, config: ProblemConfig) -> list[str]:
        return list(config.target_columns or [])

    def prepare(self, truth, submission, config) -> PreparedData:
        _validate_schema_and_ids(truth, submission, config)
        predictions = _numeric_frame(submission, config)
        outside = ((predictions < 0.0) | (predictions > 1.0)).any(axis=1)
        if outside.any():
            raise SubmissionError(
                "VALUE_OUT_OF_RANGE",
                "Multilabel probabilities must be between 0 and 1",
                _examples(submission.loc[outside, config.id_column]),
            )

        target_columns = list(config.target_columns or [])
        raw_targets = truth[target_columns]
        targets = raw_targets.apply(pd.to_numeric, errors="coerce")
        if targets.isna().any(axis=None) or not targets.isin([0, 1]).all(axis=None):
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                "Multilabel ground truth must contain only 0 and 1",
            )

        private = truth[[config.id_column]].copy()
        renamed_targets = {
            target: prediction
            for target, prediction in zip(
                target_columns,
                config.prediction_columns,
                strict=True,
            )
        }
        for target in target_columns:
            private[renamed_targets[target]] = targets[target].astype(int)
        prepared = submission[[config.id_column, *config.prediction_columns]].copy()
        for column in config.prediction_columns:
            prepared[column] = predictions[column]
        aligned_predictions = truth[[config.id_column]].merge(
            prepared,
            on=config.id_column,
            how="left",
            validate="one_to_one",
            sort=False,
        )
        return PreparedData(
            private[config.prediction_columns].astype(int),
            aligned_predictions[config.prediction_columns].astype(float),
        )


class RankingAdapter(TaskAdapter):
    name = "ranking"

    def validate_config(self, config: ProblemConfig) -> None:
        if not config.item_column:
            raise ValueError("ranking requires item_column")
        if len(config.prediction_columns) != 1:
            raise ValueError("ranking requires exactly one score column")

    def prepare(self, truth, submission, config) -> PreparedData:
        query = config.id_column
        item = config.item_column
        score_column = config.prediction_columns[0]
        assert item is not None

        expected_columns = {query, item, score_column}
        missing = sorted(expected_columns - set(submission.columns))
        if missing:
            raise SubmissionError(
                "MISSING_COLUMNS",
                f"Submission is missing required columns: {missing}",
                missing[:5],
            )
        extra = sorted(set(submission.columns) - expected_columns)
        if extra and not config.allow_extra_columns:
            raise SubmissionError(
                "EXTRA_COLUMNS",
                f"Submission contains unexpected columns: {extra}",
                extra[:5],
            )

        key_columns = [query, item]
        for frame, is_submission in ((truth, False), (submission, True)):
            if frame[key_columns].apply(lambda col: col.str.strip().eq("")).any(axis=None):
                error = SubmissionError if is_submission else JudgeInternalError
                code = "EMPTY_ID" if is_submission else "INVALID_GROUND_TRUTH"
                raise error(code, "Ranking query/item keys must not be empty")
            duplicates = frame.duplicated(key_columns, keep=False)
            if duplicates.any():
                if is_submission:
                    examples = (
                        frame.loc[duplicates, key_columns]
                        .head(5)
                        .astype(str)
                        .agg("/".join, axis=1)
                        .tolist()
                    )
                    raise SubmissionError(
                        "DUPLICATE_IDS",
                        "Submission contains duplicate query/item pairs",
                        examples,
                    )
                raise JudgeInternalError(
                    "INVALID_GROUND_TRUTH",
                    "Ground truth contains duplicate query/item pairs",
                )

        truth_keys = set(map(tuple, truth[key_columns].to_numpy()))
        submission_keys = set(map(tuple, submission[key_columns].to_numpy()))
        missing_keys = truth_keys - submission_keys
        unknown_keys = submission_keys - truth_keys
        if missing_keys:
            raise SubmissionError(
                "MISSING_IDS",
                f"Submission is missing {len(missing_keys)} query/item pairs",
                ["/".join(map(str, key)) for key in sorted(missing_keys)[:5]],
            )
        if unknown_keys:
            raise SubmissionError(
                "UNKNOWN_IDS",
                f"Submission contains {len(unknown_keys)} unknown query/item pairs",
                ["/".join(map(str, key)) for key in sorted(unknown_keys)[:5]],
            )

        scores = _numeric_frame(submission, config)
        relevance = pd.to_numeric(truth[config.target_column], errors="coerce")
        if relevance.isna().any() or (relevance < 0).any():
            raise JudgeInternalError(
                "INVALID_GROUND_TRUTH",
                "Ranking relevance must contain non-negative numbers",
            )
        private = truth[[query, item]].copy()
        private[config.target_column] = relevance.astype(float)
        prepared = submission[[query, item]].copy()
        prepared[score_column] = scores[score_column]
        aligned = private.merge(
            prepared,
            on=[query, item],
            how="left",
            validate="one_to_one",
            sort=False,
        )
        return PreparedData(
            aligned[config.target_column].astype(float),
            aligned[score_column].astype(float),
            aligned[[query, item]].copy(),
        )


TASK_ADAPTERS: dict[str, TaskAdapter] = {
    adapter.name: adapter
    for adapter in (
        RegressionAdapter(),
        BinaryProbabilityAdapter(),
        MulticlassProbabilityAdapter(),
        MulticlassLabelAdapter(),
        TextGenerationAdapter(),
        MultilabelProbabilityAdapter(),
        RankingAdapter(),
    )
}


def get_task_adapter(name: str) -> TaskAdapter:
    try:
        return TASK_ADAPTERS[name]
    except KeyError as exc:
        raise ValueError(f"unsupported task_type '{name}'") from exc
