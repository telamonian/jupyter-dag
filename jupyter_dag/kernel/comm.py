"""The no-protocol-change transport: a comm target carrying the analyze and namespace payloads.

Dispatch skeleton after ipyflow/comm_manager.py (BSD-3-Clause, Stephen Macke); ipyflow's handler
that exec()s comm-supplied source is deliberately omitted.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from comm.base_comm import BaseComm, CommManager

from ..protocol import ALL_FEATURES, COMM_TARGET, CommRequest

Handler = Callable[[CommRequest], dict[str, Any] | None]


class DagCommTarget:
    """Registers `jupyter-dag` on the kernel's CommManager and routes `{type: ...}` requests to handlers.

    A reply is sent through ``comm.send`` while the request is being handled, so ipykernel stamps it
    with the request as parent and the frontend's comm future receives it: no request ids needed.
    """

    def __init__(self, comm_manager: CommManager, handlers: Mapping[str, Handler]) -> None:
        self._handlers = dict(handlers)
        self._comms: list[BaseComm] = []
        comm_manager.register_target(COMM_TARGET, self._on_open)

    def broadcast(self, payload: dict[str, Any]) -> None:
        """Push a kernel-initiated message (namespace_delta) to every open comm."""
        for comm in list(self._comms):
            comm.send(payload)

    def _on_open(self, comm: BaseComm, open_msg: dict[str, Any]) -> None:
        self._comms.append(comm)
        comm.on_msg(lambda msg: self._on_msg(comm, msg))
        comm.on_close(lambda _msg: self._forget(comm))
        # A stock kernel that loaded the extension at runtime never updates kernel_info: advertise here too.
        comm.send({"type": "features", "supported_features": list(ALL_FEATURES)})

    def _forget(self, comm: BaseComm) -> None:
        if comm in self._comms:
            self._comms.remove(comm)

    def _on_msg(self, comm: BaseComm, msg: dict[str, Any]) -> None:
        request: CommRequest = msg["content"]["data"]
        msg_type = request.get("type", "")
        reply: dict[str, Any] = {"type": msg_type.replace("_request", "_reply"), "status": "ok"}
        handler = self._handlers.get(msg_type)
        if handler is None:
            reply.update(status="error", ename="UnknownRequest", evalue=msg_type)
        else:
            try:
                reply.update(handler(request) or {})
            except Exception as exc:  # noqa: BLE001 - surface to the frontend
                reply.update(status="error", ename=type(exc).__name__, evalue=str(exc))
        comm.send(reply)
