"""Errors raised by the judge pipeline."""


class SubmissionError(Exception):
    """A problem in a contestant-provided submission."""

    def __init__(
        self,
        code: str,
        message: str,
        examples: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.examples = examples or []


class JudgeInternalError(Exception):
    """A problem in judge configuration or private problem data."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
