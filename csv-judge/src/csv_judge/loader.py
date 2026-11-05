"""Load problem configuration and CSV files with bounded resource usage."""

import csv
from pathlib import Path

import pandas as pd
from pydantic import ValidationError

from csv_judge.adapters import get_task_adapter
from csv_judge.exceptions import JudgeInternalError, SubmissionError
from csv_judge.metric_registry import validate_metric_config
from csv_judge.models import ProblemConfig


def load_problem_config(problem_dir: Path) -> ProblemConfig:
    config_path = problem_dir / "config.json"
    try:
        raw = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise JudgeInternalError(
            "CONFIG_NOT_FOUND",
            f"Cannot read problem config: {config_path}",
        ) from exc

    try:
        config = ProblemConfig.model_validate_json(raw)
    except ValidationError as exc:
        raise JudgeInternalError("INVALID_CONFIG", str(exc)) from exc

    try:
        get_task_adapter(config.task_type).validate_config(config)
        validate_metric_config(config)
    except ValueError as exc:
        raise JudgeInternalError("INVALID_CONFIG", str(exc)) from exc
    return config


def _read_header(path: Path, *, submission: bool) -> list[str]:
    error_type = SubmissionError if submission else JudgeInternalError
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            header = next(csv.reader(handle), None)
    except (OSError, UnicodeError, csv.Error) as exc:
        code = "CSV_PARSE_ERROR" if submission else "INVALID_GROUND_TRUTH"
        raise error_type(code, f"Cannot read CSV header: {exc}") from exc

    if not header:
        code = "EMPTY_FILE" if submission else "INVALID_GROUND_TRUTH"
        raise error_type(code, "CSV file is empty or has no header")

    duplicates = sorted({name for name in header if header.count(name) > 1})
    if duplicates:
        code = "DUPLICATE_COLUMNS" if submission else "INVALID_GROUND_TRUTH"
        raise error_type(
            code,
            "CSV header contains duplicate columns",
            duplicates[:5],
        ) if submission else error_type(
            code,
            f"Ground truth contains duplicate columns: {duplicates[:5]}",
        )

    return header


def load_submission(path: Path, config: ProblemConfig) -> pd.DataFrame:
    if not path.is_file():
        raise SubmissionError("FILE_NOT_FOUND", "Submission file does not exist")

    max_bytes = config.max_file_size_mb * 1024 * 1024
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise SubmissionError("FILE_NOT_FOUND", "Cannot access submission file") from exc

    if size == 0:
        raise SubmissionError("EMPTY_FILE", "Submission file is empty")
    if size > max_bytes:
        raise SubmissionError(
            "FILE_TOO_LARGE",
            f"Submission exceeds the {config.max_file_size_mb} MB limit",
        )

    _read_header(path, submission=True)
    try:
        frame = pd.read_csv(
            path,
            dtype="string",
            keep_default_na=False,
            encoding="utf-8-sig",
            nrows=config.max_rows + 1,
        )
    except (OSError, UnicodeError, pd.errors.ParserError) as exc:
        raise SubmissionError("CSV_PARSE_ERROR", f"Cannot parse CSV: {exc}") from exc

    if len(frame) > config.max_rows:
        raise SubmissionError(
            "TOO_MANY_ROWS",
            f"Submission exceeds the {config.max_rows} row limit",
        )
    if frame.empty:
        raise SubmissionError("EMPTY_FILE", "Submission has no data rows")
    return frame


def load_ground_truth(problem_dir: Path, config: ProblemConfig) -> pd.DataFrame:
    path = problem_dir / "ground_truth.csv"
    if not path.is_file():
        raise JudgeInternalError(
            "GROUND_TRUTH_NOT_FOUND",
            f"Cannot find ground truth: {path}",
        )

    _read_header(path, submission=False)
    try:
        frame = pd.read_csv(
            path,
            dtype="string",
            keep_default_na=False,
            encoding="utf-8-sig",
        )
    except (OSError, UnicodeError, pd.errors.ParserError) as exc:
        raise JudgeInternalError(
            "INVALID_GROUND_TRUTH",
            f"Cannot parse ground truth: {exc}",
        ) from exc

    adapter = get_task_adapter(config.task_type)
    required = {
        config.id_column,
        *adapter.required_truth_columns(config),
    }
    if config.item_column:
        required.add(config.item_column)
    missing = sorted(required - set(frame.columns))
    if missing:
        raise JudgeInternalError(
            "INVALID_GROUND_TRUTH",
            f"Ground truth is missing columns: {missing}",
        )
    if frame.empty:
        raise JudgeInternalError("INVALID_GROUND_TRUTH", "Ground truth is empty")
    return frame
