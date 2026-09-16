"""jupyter_client helpers for tests and scripts: a blocking client that speaks the jupyter-dag additions."""

from __future__ import annotations

from jupyter_client.blocking.client import BlockingKernelClient, wrapped
from jupyter_client.client import KernelClient, reqrep
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.manager import KernelManager

from .protocol import ANALYZE_REQUEST, KERNEL_NAME, AnalyzeCellInput


def _analyze(self: KernelClient, cells: list[AnalyzeCellInput]) -> str:
    """Send analyze_request (template: KernelClient.is_complete, client.py:807-816).

    Returns
    -------
    The msg_id of the message sent.
    """
    msg = self.session.msg(ANALYZE_REQUEST, {"cells": list(cells)})
    self.shell_channel.send(msg)
    return msg["header"]["msg_id"]


def _namespace_delete(self: KernelClient, names: list[str]) -> str:
    """Silent, empty execute_request carrying namespace_delete: purge without running anything.

    Returns
    -------
    The msg_id of the message sent.
    """
    content = {
        "code": "",
        "silent": True,
        "store_history": False,
        "user_expressions": {},
        "allow_stdin": False,
        "stop_on_error": True,
        "namespace_delete": list(names),
    }
    msg = self.session.msg("execute_request", content)
    self.shell_channel.send(msg)
    return msg["header"]["msg_id"]


class DagBlockingKernelClient(BlockingKernelClient):
    """BlockingKernelClient with `analyze` and `namespace_delete` request methods."""

    analyze = reqrep(wrapped, _analyze)
    namespace_delete = reqrep(wrapped, _namespace_delete)


def start_dag_kernel(kernel_dirs: list[str]) -> tuple[KernelManager, DagBlockingKernelClient]:
    """Start the DAG kernel from a kernelspec in `kernel_dirs` and return a ready client."""
    ksm = KernelSpecManager(kernel_dirs=kernel_dirs)
    km = KernelManager(
        kernel_name=KERNEL_NAME,
        kernel_spec_manager=ksm,
        client_class="jupyter_dag.client.DagBlockingKernelClient",
    )
    km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready()
    return km, kc
