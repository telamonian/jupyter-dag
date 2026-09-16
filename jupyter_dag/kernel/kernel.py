"""DagKernel: IPythonKernel plus analyze_request, namespace_delete and namespace_delta."""

from __future__ import annotations

from typing import Any

from ipykernel.ipkernel import IPythonKernel
from ipykernel.kernelbase import Kernel as KernelBase
from IPython.core.interactiveshell import InteractiveShell
from traitlets import Bool

from .. import __version__
from ..analysis import analyze_cells
from ..protocol import ALL_FEATURES, ANALYZE_REPLY, ANALYZE_REQUEST, AnalyzeReplyContent, CommRequest, NamespaceDelta
from .comm import DagCommTarget
from .namespace import compute_delta, delete_names, set_names, visible_names


class DagKernel(IPythonKernel):
    """IPython kernel with the jupyter-dag protocol additions."""

    implementation = "jupyter-dag"
    implementation_version = __version__

    # Kernel.__init__ builds shell_handlers / control_handlers from these lists (kernelbase.py:311-313);
    # control_msg_types snapshots the BASE list, so the new type goes on both.
    msg_types = [*KernelBase.msg_types, ANALYZE_REQUEST]
    control_msg_types = [*KernelBase.control_msg_types, ANALYZE_REQUEST]

    emit_namespace_delta = Bool(True, help="Attach namespace_delta to every execute_reply.").tag(config=True)

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._init_dag()

    def _init_dag(self) -> None:
        """Per-instance setup; also run by load_ipython_extension on an already-running kernel."""
        self.dag_comm = DagCommTarget(
            self.comm_manager,  # set at ipkernel.py:159
            {
                ANALYZE_REQUEST: self._comm_analyze,
                "namespace_delete": self._comm_namespace_delete,
                "namespace_set": self._comm_namespace_set,
            },
        )

    @property
    def kernel_info(self) -> dict[str, Any]:  # a plain property in kernelbase.py:992; there is no hook to extend it
        info = super().kernel_info
        info["supported_features"] = [*info.get("supported_features", []), *ALL_FEATURES]
        return info

    async def analyze_request(self, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
        """Shell/control handler; modelled on is_complete_request (kernelbase.py:1113)."""
        if not self.session:
            return
        # On the control channel stay off the shell thread's InteractiveShell: use the plain transformer,
        # so user-registered input transformers are honoured on the shell channel only.
        transformer = None if stream is self.control_stream else self.shell
        reply: dict[str, Any]
        try:
            cells = parent["content"].get("cells", [])
            ok: AnalyzeReplyContent = {"status": "ok", "cells": analyze_cells(cells, transformer)}
            reply = dict(ok)
        except Exception as exc:  # noqa: BLE001 - a missing reply would hang the frontend future
            reply = {"status": "error", "ename": type(exc).__name__, "evalue": str(exc), "traceback": []}
        self.session.send(stream, ANALYZE_REPLY, reply, parent, ident)

    async def do_execute(
        self,
        code: str,
        silent: bool,
        store_history: bool = True,
        user_expressions: dict[str, Any] | None = None,
        allow_stdin: bool = False,
        *,
        cell_meta: dict[str, Any] | None = None,
        cell_id: str | None = None,
    ) -> dict[str, Any]:
        parent = self.get_parent() or {}
        before = visible_names(self.shell) if self.emit_namespace_delta else None
        # namespace_delete / namespace_set are not forwarded as kwargs (kernelbase.py:76-88); read the parent.
        content = parent.get("content", {})
        delete_names(self.shell, content.get("namespace_delete", []))
        set_names(self.shell, content.get("namespace_set", {}))
        reply = await super().do_execute(
            code, silent, store_history, user_expressions, allow_stdin, cell_meta=cell_meta, cell_id=cell_id
        )
        if before is not None:
            delta: NamespaceDelta = compute_delta(before, visible_names(self.shell))
            reply["namespace_delta"] = delta  # sent verbatim as execute_reply content (kernelbase.py:852-861)
            self.dag_comm.broadcast({"type": "namespace_delta", "cell_id": cell_id, **delta})
        return reply

    def _comm_analyze(self, request: CommRequest) -> dict[str, Any]:
        return {"cells": analyze_cells(request.get("cells", []), self.shell)}

    def _comm_namespace_delete(self, request: CommRequest) -> dict[str, Any]:
        return {"removed": delete_names(self.shell, request.get("names", []))}

    def _comm_namespace_set(self, request: CommRequest) -> dict[str, Any]:
        return {"set": set_names(self.shell, request.get("values", {}))}


# ---- runtime injection: `%load_ext jupyter_dag` on a stock kernel (after ipyflow kernel.py:137-150) ----

_prev_kernel_class: type | None = None


def load_ipython_extension(ipy: InteractiveShell) -> None:
    global _prev_kernel_class
    kernel = getattr(ipy, "kernel", None)
    if kernel is None or isinstance(kernel, DagKernel):
        return
    prev = type(kernel)

    class GeneratedDagKernel(DagKernel, prev):  # type: ignore[misc, valid-type]
        """DagKernel first in the MRO, then whatever class the running kernel had."""

    kernel.__class__ = GeneratedDagKernel
    _prev_kernel_class = prev
    kernel._init_dag()
    # The handler tables were built at construction time; extend them from the class lists.
    for msg_type in DagKernel.msg_types:
        kernel.shell_handlers.setdefault(msg_type, getattr(kernel, msg_type))
    for msg_type in DagKernel.control_msg_types:
        kernel.control_handlers.setdefault(msg_type, getattr(kernel, msg_type))


def unload_ipython_extension(ipy: InteractiveShell) -> None:
    global _prev_kernel_class
    kernel = getattr(ipy, "kernel", None)
    if kernel is None or _prev_kernel_class is None:
        return
    for msg_type in set(DagKernel.msg_types) - set(_prev_kernel_class.msg_types):
        kernel.shell_handlers.pop(msg_type, None)
    for msg_type in set(DagKernel.control_msg_types) - set(_prev_kernel_class.control_msg_types):
        kernel.control_handlers.pop(msg_type, None)
    kernel.__class__ = _prev_kernel_class
    _prev_kernel_class = None
