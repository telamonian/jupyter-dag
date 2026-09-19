"""The no-protocol-change transport: a comm target carrying the analyze and namespace payloads.

Comms are the protocol's escape hatch for kernel-side code that wants to talk to the frontend
without a message type of its own. The frontend opens one with a `comm_open` naming a target;
ipykernel's `CommManager` looks the target up and calls the registered callback with the new comm
and the message (`comm/base_comm.py:263-281`). Each later `comm_msg` on that comm reaches
`BaseComm.handle_msg` (`base_comm.py:179`), which calls whatever `on_msg` registered. Anything the
kernel sends with `comm.send` goes out as a `comm_msg` on iopub.

Request-reply therefore needs no request ids: ipykernel's `publish_msg`
(`ipykernel/comm/comm.py:24-42`) sends on iopub with `parent=self.kernel.get_parent()`, the
message being handled right now. A reply sent from inside the handler therefore carries the
request's header as its parent, and the frontend future for that request receives it.

References
----------
The dispatch skeleton follows ipyflow's `comm_manager.py` (BSD-3-Clause, Stephen Macke); its
handler that `exec()`s comm-supplied source has no twin here.
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
    """The `jupyter-dag` comm target: routes `{"type": ...}` requests to handlers and replies in place.

    Parameters
    ----------
    comm_manager : CommManager
        The kernel's comm manager (`IPythonKernel.comm_manager`); the target is registered on it
        with `register_target` (`comm/base_comm.py:202`).
    shell : InteractiveShell
        The kernel's shell, for the namespace handlers.

    Notes
    -----
    `namespace_delta` is not carried here; `DagKernel.do_execute` attaches it to every
    `execute_reply`.
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
        """Attach the message handler to a newly opened comm and advertise the features.

        Parameters
        ----------
        comm : BaseComm
            The comm the frontend just opened.
        open_msg : dict
            The `comm_open` message; unused, but `CommManager.comm_open` passes it
            (`base_comm.py:281`).

        Notes
        -----
        The `features` message is how the frontend learns the feature strings after `%load_ext`
        on a stock kernel, whose `kernel_info_reply` had already gone out
        (`jupyter_dag.kernel.kernel.load_ipython_extension`).
        """
        comm.on_msg(lambda msg: self._on_msg(comm, msg))
        comm.send({"type": "features", "supported_features": list(ALL_FEATURES)})

    def _on_msg(self, comm: BaseComm, msg: dict[str, Any]) -> None:
        """Dispatch one `comm_msg` to the handler named by its `type` and send the reply.

        Parameters
        ----------
        comm : BaseComm
            The comm the message arrived on; the reply goes back through it.
        msg : dict
            The full `comm_msg`; `msg["content"]["data"]` is the `CommRequest`.

        Notes
        -----
        The reply is `{"status": "ok", ...handler result...}`, or `error_content` of whatever the
        handler raised; an unknown `type` is a `KeyError` on the handler table and takes the same
        path.
        """
        request: CommRequest = msg["content"]["data"]
        try:
            reply = {"status": "ok", **self._handlers[request.get("type", "")](request)}
        except Exception as exc:  # noqa: BLE001 - surface to the frontend; an unknown type is a KeyError
            reply = error_content(exc)
        comm.send(reply)

    def _analyze(self, request: CommRequest) -> dict[str, Any]:
        """Comm twin of `analyze_request`.

        Parameters
        ----------
        request : CommRequest
            `{"type": "analyze_request", "cells": [...]}`.

        Returns
        -------
        dict
            `{"cells": [...]}`, the list `jupyter_dag.analysis.analyze_cells` returns.
        """
        return {"cells": analyze_cells(request["cells"])}

    def _namespace_delete(self, request: CommRequest) -> dict[str, Any]:
        """Comm twin of the `namespace_delete` field of `execute_request`.

        Parameters
        ----------
        request : CommRequest
            `{"type": "namespace_delete", "names": [...]}`.

        Returns
        -------
        dict
            `{"removed": [...]}`, the names that were bound and got unbound.
        """
        return {"removed": delete_names(self._shell, request["names"])}

    def _namespace_set(self, request: CommRequest) -> dict[str, Any]:
        """Comm twin of the `namespace_set` field of `execute_request`.

        Parameters
        ----------
        request : CommRequest
            `{"type": "namespace_set", "values": {name: json, ...}}`.

        Returns
        -------
        dict
            `{"set": [...]}`, the names bound, sorted.
        """
        return {"set": set_names(self._shell, request["values"])}
