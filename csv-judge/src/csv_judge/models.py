"""Validated, task-agnostic problem configuration models."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ProblemConfig(BaseModel):
    """Configuration shared by every registered task and metric."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    id_column: str = "id"
    target_column: str = "label"
    target_columns: list[str] | None = None
    item_column: str | None = None
    prediction_columns: list[str] = Field(min_length=1)
    task_type: str = Field(min_length=1)
    metric: str = Field(min_length=1)
    greater_is_better: bool = False
    max_file_size_mb: int = Field(default=20, gt=0, le=1024)
    max_rows: int = Field(default=100_000, gt=0)
    allow_extra_columns: bool = False
    probability_tolerance: float = Field(default=1e-6, gt=0, le=0.1)
    binary_threshold: float = Field(default=0.5, ge=0, le=1)
    metric_options: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_task_configuration(self) -> "ProblemConfig":
        all_columns = [
            self.id_column,
            self.target_column,
            *self.prediction_columns,
        ]
        if self.target_columns:
            all_columns.extend(self.target_columns)
        if self.item_column:
            all_columns.append(self.item_column)
        if len(all_columns) != len(set(all_columns)):
            raise ValueError("id, target and prediction columns must be distinct")

        return self
