"""Wire format of the jupyter-dag kernel-protocol additions.

Everything here is a name or a shape that crosses the kernel boundary, so it has a twin on the
frontend: the string constants must match `src/dag/protocol.ts` verbatim, and
`jupyter_dag/tests/test_protocol.py` reads that file to check that they do. The TypedDicts describe
message payloads for readers and type checkers; nothing enforces them at runtime.

Three things travel over the wire. `analyze_request` and `analyze_reply` are a message type of
their own on the shell and control channels, carrying `AnalyzeCellInput` in and `AnalyzedCell` out.
`namespace_delete` and `namespace_set` are extra fields on `execute_request` content, and
`namespace_delta` (`NamespaceDelta`) is an extra field on `execute_reply` content. The same
payloads can ride as `comm_msg` data on the `jupyter-dag` comm target (`CommRequest`).

The feature strings are JEP 92 `supported_features` entries, spelled like ipykernel's own
("kernel subshells", "debugger": `ipykernel/kernelbase.py:997-999`), lower case and space separated.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

KERNEL_NAME = "jupyter-dag"
DISPLAY_NAME = "Python 3 (jupyter-dag)"
COMM_TARGET = "jupyter-dag"

FEATURE_ANALYZE = "cell analysis"
FEATURE_NAMESPACE_DELETE = "namespace delete"
FEATURE_NAMESPACE_SET = "namespace set"
FEATURE_NAMESPACE_DELTA = "namespace delta"
ALL_FEATURES: tuple[str, ...] = (FEATURE_ANALYZE, FEATURE_NAMESPACE_DELETE, FEATURE_NAMESPACE_SET, FEATURE_NAMESPACE_DELTA)

ANALYZE_REQUEST = "analyze_request"
ANALYZE_REPLY = "analyze_reply"


class AnalyzeCellInput(TypedDict):
    """One cell to analyze, as listed under `cells` in `analyze_request` content.

    Attributes
    ----------
    cell_id : str
        The notebook cell id, echoed in the result so it can be matched to the cell.
    code : str
        The cell source as the user wrote it; IPython syntax such as `%timeit` is fine.
    """

    cell_id: str
    code: str


class AnalyzedCellOk(TypedDict):
    """Analysis result for a cell that parsed, or that was a cell magic and got no analysis.

    The derivation rules are in `jupyter_dag.analysis.analyze_source`.

    Attributes
    ----------
    cell_id : str
        The id from the matching `AnalyzeCellInput`.
    status : {"ok", "opaque"}
        `"ok"` for analysed source; `"opaque"` for a `%%` cell magic, whose name lists are empty.
    defined : list of str
        Global names the cell binds. Sorted.
    referenced : list of str
        Global names the cell reads without defining them, including builtins. Sorted.
    deleted : list of str
        Names in `del` statements. Sorted.
    dynamic : bool
        True when the cell can change names in ways static analysis cannot see: a star import or
        a call to any of `jupyter_dag.analysis.DYNAMIC_CALLS`.
    """

    cell_id: str
    status: Literal["ok", "opaque"]
    defined: list[str]
    referenced: list[str]
    deleted: list[str]
    dynamic: bool


class AnalyzedCellError(TypedDict):
    """Analysis result for a cell whose source did not parse.

    Attributes
    ----------
    cell_id : str
        The id from the matching `AnalyzeCellInput`.
    status : {"error"}
        Always `"error"`.
    ename : str
        The exception class name: `SyntaxError` or a subclass such as `IndentationError`.
    evalue : str
        The exception message.
    """

    cell_id: str
    status: Literal["error"]
    ename: str
    evalue: str


AnalyzedCell = AnalyzedCellOk | AnalyzedCellError
"""One entry of the `cells` list in `analyze_reply` content; discriminate on `status`."""


class NamespaceDelta(TypedDict):
    """The `namespace_delta` field of `execute_reply` content.

    A set difference of the visible names before and after the cell ran, so a name rebound to a
    new value appears in neither list.

    Attributes
    ----------
    added : list of str
        Visible names bound after the cell ran that were not bound before. Sorted.
    removed : list of str
        Visible names bound before the cell ran that are gone afterwards. Sorted.

    Examples
    --------
    A frontend that wants "purge these names, run nothing" sends an `execute_request` with::

        {"code": "", "silent": True, "store_history": False, "namespace_delete": ["df", "model"]}

    and gets back::

        {"status": "ok", ..., "namespace_delta": {"added": [], "removed": ["df", "model"]}}
    """

    added: list[str]
    removed: list[str]


def error_content(exc: BaseException) -> dict[str, Any]:
    """Build the error form of a reply, spelled like an `execute_reply` error.

    Parameters
    ----------
    exc : BaseException
        The exception that stopped the handler.

    Returns
    -------
    dict
        `{"status": "error", "ename": ..., "evalue": ..., "traceback": []}`; `ename` is the
        exception class name and `evalue` its message, the same fields ipykernel fills at
        `ipykernel/ipkernel.py:478`. The frontend only checks `status`.
    """
    return {"status": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": []}


class CommRequest(TypedDict, total=False):
    """Payload of a `comm_msg` on the `jupyter-dag` target; `type` selects the handler.

    Attributes
    ----------
    type : str
        `"analyze_request"`, `"namespace_delete"` or `"namespace_set"`.
    cells : list of AnalyzeCellInput
        For `analyze_request`.
    names : list of str
        For `namespace_delete`.
    values : dict
        For `namespace_set`: name to JSON value.
    """

    type: str
    cells: list[AnalyzeCellInput]
    names: list[str]
    values: dict[str, Any]
