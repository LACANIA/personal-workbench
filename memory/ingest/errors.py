"""Typed errors returned by the controlled document-ingestion boundary."""

from __future__ import annotations

from typing import Any


class IngestError(RuntimeError):
    """An ingestion failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.details = details

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}
