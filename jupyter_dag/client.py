"""A blocking jupyter_client client that speaks the jupyter-dag additions, for tests and scripts.

`jupyter_client` builds its request methods from small send-functions: `reqrep`
(`jupyter_client/client.py:42`) takes a function that builds and sends one message and returns its
`msg_id`, and wraps it into a method with `reply` and `timeout` keyword arguments that can also
wait for the reply. `wrapped` (`jupyter_client/blocking/client.py:19`) is the blocking flavour of
that waiter. The two functions below are such send-functions; the class attaches them the way
`BlockingKernelClient` attaches its own. `reqrep` builds the wrapped method's documentation by
splitting the send-function's docstring at its `Returns` section, so that section stays last in
both.
"""

from __future__ import annotations

from jupyter_client.blocking.client import BlockingKernelClient, wrapped
from jupyter_client.client import KernelClient, reqrep
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.manager import KernelManager

from .protocol import ANALYZE_REQUEST, KERNEL_NAME, AnalyzeCellInput


def _analyze(self: KernelClient, cells: list[AnalyzeCellInput]) -> str:
    """Send an `analyze_request` on the shell channel.

    Modelled on `KernelClient.is_complete` (`jupyter_client/client.py:807`).

    Parameters
    ----------
    cells : list of AnalyzeCellInput
        The cells to analyze.

    Returns
    -------
    str
        The `msg_id` of the message sent.
    """
    msg = self.session.msg(ANALYZE_REQUEST, {"cells": list(cells)})
    self.shell_channel.send(msg)
    return msg["header"]["msg_id"]


def _namespace_delete(self: KernelClient, names: list[str]) -> str:
    """Send a silent, empty `execute_request` carrying `namespace_delete`: purge without running.

    `KernelClient.execute` builds its content from a fixed set of arguments
    (`jupyter_client/client.py:662-669`) with no way to add a field, so the message is built by
    hand. Only the fields the kernel reads are sent; ipykernel defaults the rest.

    Parameters
    ----------
    names : list of str
        Names to unbind before the (empty) code runs.

    Returns
    -------
    str
        The `msg_id` of the message sent.
    """
    content = {"code": "", "silent": True, "store_history": False, "namespace_delete": list(names)}
    msg = self.session.msg("execute_request", content)
    self.shell_channel.send(msg)
    return msg["header"]["msg_id"]


class DagBlockingKernelClient(BlockingKernelClient):
    """`BlockingKernelClient` with `analyze` and `namespace_delete` request methods.

    Both take `reply=True, timeout=...` like the other request methods and then return the reply
    message; `namespace_delete`'s reply is an `execute_reply` carrying `namespace_delta`.
    """

    analyze = reqrep(wrapped, _analyze)
    namespace_delete = reqrep(wrapped, _namespace_delete)


def start_dag_kernel(kernel_dirs: list[str]) -> tuple[KernelManager, DagBlockingKernelClient]:
    """Start the DAG kernel from a kernelspec directory and return a ready client.

    Parameters
    ----------
    kernel_dirs : list of str
        Directories to search for the `jupyter-dag` kernelspec, instead of the usual Jupyter paths;
        a test writes one with `jupyter_dag.kernel.install.write_kernel_spec`.

    Returns
    -------
    KernelManager
        Owns the kernel process; call `shutdown_kernel` when done.
    DagBlockingKernelClient
        Connected, channels started, and past `wait_for_ready`, so its first request will be answered.

    Notes
    -----
    `KernelManager` builds clients from its `client_class` trait
    (`jupyter_client/manager.py:157`), which is why the class is passed as a dotted name.
    """
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
