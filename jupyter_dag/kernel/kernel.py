"""DagKernel: IPythonKernel plus analyze_request, namespace_delete and namespace_delta."""

from __future__ import annotations

from typing import Any

from ipykernel.ipkernel import IPythonKernel
from IPython.core.interactiveshell import InteractiveShell

from .. import __version__
from ..analysis import analyze_cells
from ..protocol import ALL_FEATURES, ANALYZE_REPLY, ANALYZE_REQUEST, error_content
from .comm import DagCommTarget
from .namespace import compute_delta, delete_names, set_names, visible_names


class DagKernel(IPythonKernel):
    """IPython kernel with the jupyter-dag protocol additions."""

    implementation = "jupyter-dag"
    implementation_version = __version__

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._init_dag()

    def _init_dag(self) -> None:
        """Per-instance setup; also run by load_ipython_extension on an already-running kernel.

        Kernel.__init__ has already built the handler tables from its msg_types lists (kernelbase.py:311-317),
        so the new type goes into both tables here, the way ipkernel.py:163-165 adds the comm handlers.
        """
        self.shell_handlers[ANALYZE_REQUEST] = self.control_handlers[ANALYZE_REQUEST] = self.analyze_request
        self.dag_comm = DagCommTarget(self.comm_manager, self.shell)

    @property
    def kernel_info(self) -> dict[str, Any]:  # a plain property in kernelbase.py:992; there is no hook to extend it
        info = super().kernel_info
        info["supported_features"].extend(ALL_FEATURES)
        return info

    async def analyze_request(self, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
        """Shell/control handler; modelled on is_complete_request (kernelbase.py:1113)."""
        if not self.session:
            return
        try:
            reply = {"status": "ok", "cells": analyze_cells(parent["content"]["cells"])}
        except Exception as exc:  # noqa: BLE001 - a missing reply would hang the frontend future
            reply = error_content(exc)
        self.session.send(stream, ANALYZE_REPLY, reply, parent, ident)

    async def do_execute(self, **kwargs: Any) -> dict[str, Any]:
        # ipykernel calls do_execute with keywords only (kernelbase.py:831); namespace_delete / namespace_set
        # are not among them (kernelbase.py:76-88), so read them from the parent message.
        content = (self.get_parent() or {}).get("content", {})
        before = visible_names(self.shell)
        delete_names(self.shell, content.get("namespace_delete", []))
        set_names(self.shell, content.get("namespace_set", {}))
        reply = await super().do_execute(**kwargs)
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

        _dag_prev_class = prev

    kernel.__class__ = GeneratedDagKernel
    kernel._init_dag()


def unload_ipython_extension(ipy: InteractiveShell) -> None:
    kernel = getattr(ipy, "kernel", None)
    prev = getattr(kernel, "_dag_prev_class", None)
    if prev is None:
        return
    kernel.shell_handlers.pop(ANALYZE_REQUEST, None)
    kernel.control_handlers.pop(ANALYZE_REQUEST, None)
    kernel.__class__ = prev
