"""The no-protocol-change transport: a comm target carrying the analyze and namespace payloads.

Dispatch skeleton after ipyflow/comm_manager.py (BSD-3-Clause, Stephen Macke); ipyflow's handler
that exec()s comm-supplied source is deliberately omitted.
"""

from __future__ import annotations

from typing import Any

from comm.base_comm import BaseComm, CommManager
from IPython.core.interactiveshell import InteractiveShell

from ..analysis import analyze_cells
from ..protocol import (
    ALL_FEATURES,
    ANALYZE_REQUEST,
    COMM_TARGET,
    CommRequest,
    error_content,
)
from .namespace import delete_names, set_names


class DagCommTarget:
    """Registers `jupyter-dag` on the kernel's CommManager and routes `{type: ...}` requests to handlers.

    A reply is sent through ``comm.send`` while the request is being handled, so ipykernel stamps it
    with the request as parent and the frontend's comm future receives it: no request ids needed.
    namespace_delta is not carried here: DagKernel attaches it to every execute_reply.
    """

    def __init__(self, comm_manager: CommManager, shell: InteractiveShell) -> None:
        self._shell = shell
        self._handlers = {
            ANALYZE_REQUEST: self._analyze,
            "namespace_delete": self._namespace_delete,
            "namespace_set": self._namespace_set,
        }
        comm_manager.register_target(COMM_TARGET, self._on_open)

    def _on_open(self, comm: BaseComm, open_msg: dict[str, Any]) -> None:
        comm.on_msg(lambda msg: self._on_msg(comm, msg))
        # A stock kernel that loaded the extension at runtime never updates kernel_info: advertise here too.
        comm.send({"type": "features", "supported_features": list(ALL_FEATURES)})

    def _on_msg(self, comm: BaseComm, msg: dict[str, Any]) -> None:
        request: CommRequest = msg["content"]["data"]
        try:
            reply = {"status": "ok", **self._handlers[request.get("type", "")](request)}
        except Exception as exc:  # noqa: BLE001 - surface to the frontend; an unknown type is a KeyError
            reply = error_content(exc)
        comm.send(reply)

    def _analyze(self, request: CommRequest) -> dict[str, Any]:
        return {"cells": analyze_cells(request["cells"])}

    def _namespace_delete(self, request: CommRequest) -> dict[str, Any]:
        return {"removed": delete_names(self._shell, request["names"])}

    def _namespace_set(self, request: CommRequest) -> dict[str, Any]:
        return {"set": set_names(self._shell, request["values"])}
