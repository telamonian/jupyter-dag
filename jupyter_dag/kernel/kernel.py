"""DagKernel: IPythonKernel plus analyze_request, namespace_delete and namespace_delta."""

from __future__ import annotations

from typing import Any

from ipykernel.ipkernel import IPythonKernel
from ipykernel.kernelbase import Kernel as KernelBase
from IPython.core.interactiveshell import InteractiveShell

from .. import __version__
from ..analysis import analyze_cells
from ..protocol import ALL_FEATURES, ANALYZE_REPLY, ANALYZE_REQUEST, error_content
from .comm import DagCommTarget
from .namespace import compute_delta, delete_names, set_names, visible_names

# The message types this kernel adds; each goes on both the shell and the control channel.
DAG_MSG_TYPES = (ANALYZE_REQUEST,)


class DagKernel(IPythonKernel):
    """IPython kernel with the jupyter-dag protocol additions."""

    implementation = "jupyter-dag"
    implementation_version = __version__

    # Kernel.__init__ builds shell_handlers / control_handlers from these lists (kernelbase.py:311-313);
    # control_msg_types snapshots the BASE list, so the new types go on both.
    msg_types = [*KernelBase.msg_types, *DAG_MSG_TYPES]
    control_msg_types = [*KernelBase.control_msg_types, *DAG_MSG_TYPES]

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._init_dag()

    def _init_dag(self) -> None:
        """Per-instance setup; also run by load_ipython_extension on an already-running kernel."""
        self.dag_comm = DagCommTarget(self.comm_manager, self.shell)  # comm_manager is set at ipkernel.py:159

    @property
    def kernel_info(self) -> dict[str, Any]:  # a plain property in kernelbase.py:992; there is no hook to extend it
        info = super().kernel_info
        info["supported_features"] = [*info.get("supported_features", []), *ALL_FEATURES]
        return info

    async def analyze_request(self, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
        """Shell/control handler; modelled on is_complete_request (kernelbase.py:1113)."""
        if not self.session:
            return
        reply: dict[str, Any]
        try:
            reply = {"status": "ok", "cells": analyze_cells(parent["content"].get("cells", []))}
        except Exception as exc:  # noqa: BLE001 - a missing reply would hang the frontend future
            reply = error_content(exc)
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
        # namespace_delete / namespace_set are not forwarded as kwargs (kernelbase.py:76-88); read the parent.
        content = (self.get_parent() or {}).get("content", {})
        before = visible_names(self.shell)
        delete_names(self.shell, content.get("namespace_delete", []))
        set_names(self.shell, content.get("namespace_set", {}))
        reply = await super().do_execute(
            code, silent, store_history, user_expressions, allow_stdin, cell_meta=cell_meta, cell_id=cell_id
        )
        # The dict is sent verbatim as execute_reply content (kernelbase.py:852-861), to every client.
        reply["namespace_delta"] = compute_delta(before, visible_names(self.shell))
        return reply


# ---- runtime injection: `%load_ext jupyter_dag` on a stock kernel (after ipyflow kernel.py:137-150) ----


def load_ipython_extension(ipy: InteractiveShell) -> None:
    kernel = getattr(ipy, "kernel", None)
    if kernel is None or isinstance(kernel, DagKernel):
        return
    prev = type(kernel)

    class GeneratedDagKernel(DagKernel, prev):  # type: ignore[misc, valid-type]
        """DagKernel first in the MRO, then whatever class the running kernel had."""

    kernel.__class__ = GeneratedDagKernel
    kernel._dag_prev_class = prev
    kernel._init_dag()
    # The handler tables were built at construction time (kernelbase.py:311-313); add the new types by hand.
    for msg_type in DAG_MSG_TYPES:
        kernel.shell_handlers[msg_type] = kernel.control_handlers[msg_type] = getattr(kernel, msg_type)


def unload_ipython_extension(ipy: InteractiveShell) -> None:
    kernel = getattr(ipy, "kernel", None)
    prev = getattr(kernel, "_dag_prev_class", None)
    if prev is None:
        return
    for msg_type in DAG_MSG_TYPES:
        kernel.shell_handlers.pop(msg_type, None)
        kernel.control_handlers.pop(msg_type, None)
    kernel.__class__ = prev
    del kernel._dag_prev_class
