"""Wire format of the jupyter-dag kernel-protocol additions.

The string constants must match src/dag/protocol.ts verbatim; jupyter_dag/tests/test_protocol.py checks.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

KERNEL_NAME = "jupyter-dag"
DISPLAY_NAME = "Python 3 (jupyter-dag)"
COMM_TARGET = "jupyter-dag"

# JEP 92 supported_features strings, spelled like ipykernel's own ("kernel subshells", "debugger").
FEATURE_ANALYZE = "cell analysis"
FEATURE_NAMESPACE_DELETE = "namespace delete"
FEATURE_NAMESPACE_DELTA = "namespace delta"
ALL_FEATURES: tuple[str, ...] = (FEATURE_ANALYZE, FEATURE_NAMESPACE_DELETE, FEATURE_NAMESPACE_DELTA)

ANALYZE_REQUEST = "analyze_request"
ANALYZE_REPLY = "analyze_reply"


class AnalyzeCellInput(TypedDict):
    cell_id: str
    code: str


class AnalyzedCellOk(TypedDict):
    cell_id: str
    status: Literal["ok", "opaque"]
    defined: list[str]
    referenced: list[str]
    deleted: list[str]
    dynamic: bool


class AnalyzedCellError(TypedDict):
    cell_id: str
    status: Literal["error"]
    ename: str
    evalue: str


AnalyzedCell = AnalyzedCellOk | AnalyzedCellError


class NamespaceDelta(TypedDict):
    added: list[str]
    removed: list[str]


def error_content(exc: BaseException) -> dict[str, Any]:
    """The error form of a reply, spelled like execute_reply's."""
    return {"status": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": []}


class CommRequest(TypedDict, total=False):
    """Payload of a comm_msg on the `jupyter-dag` target; `type` selects the handler."""

    type: str
    cells: list[AnalyzeCellInput]
    names: list[str]
    values: dict[str, Any]
