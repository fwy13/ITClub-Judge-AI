"""Stable result returned by the judge and CLI."""

from dataclasses import asdict, dataclass, field
from typing import Literal


@dataclass(frozen=True, slots=True)
class JudgeResult:
    status: Literal["accepted", "rejected", "failed"]
    score: float | None = None
    metric: str | None = None
    rows: int | None = None
    error_code: str | None = None
    message: str | None = None
    examples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return asdict(self)
