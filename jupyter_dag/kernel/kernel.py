"""DagKernel: the stock IPython kernel plus the three jupyter-dag protocol additions.

The frontend (`src/dag/protocol.ts`) sends messages over the kernel websocket; jupyter_server
relays them to the kernel process untouched; ipykernel's dispatch loop looks the message type up in
a handler table and awaits the handler. `DagKernel` adds one message type to that table and
extends two existing ones:

1. `analyze_request` (shell and control channels): "which names does each of these cells define
   and reference?" Answered by `jupyter_dag.analysis.analyze_cells` and sent back as
   `analyze_reply`.
2. `execute_request` gains two optional fields, `namespace_delete` (unbind these names before
   running) and `namespace_set` (bind these JSON values first), handled in `DagKernel.do_execute`.
3. `execute_reply` gains `namespace_delta` (`{"added": [...], "removed": [...]}`), the set
   difference of the user namespace before and after the cell ran.

The kernel advertises all of them as JEP 92 `supported_features` strings in `kernel_info_reply`
(`DagKernel.kernel_info`), so a frontend can feature-detect before sending anything new.

There are two ways to get this kernel. A kernelspec launches the stock `ipykernel_launcher` with
`--IPKernelApp.kernel_class=jupyter_dag.kernel.kernel.DagKernel`: `IPKernelApp.kernel_class` is
a configurable trait (`ipykernel/kernelapp.py:126`) and `init_kernel` instantiates whatever class
it names (`kernelapp.py:620-623`), so no launcher module of our own is needed. The wheel ships one
such spec and `jupyter_dag.kernel.install` writes one for any interpreter. The other way is
`%load_ext jupyter_dag` inside an already running stock kernel: `load_ipython_extension` at the
bottom of this file swaps the live kernel's class. That path exists so the prototype can be tried
without installing a kernelspec.

The same payloads are also reachable over a comm target (`jupyter_dag.kernel.comm`), which is the
no-protocol-change transport: it works on any frontend that can open a comm, at the price of not
being a real message type.
"""

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
    """IPython kernel with the jupyter-dag protocol additions.

    Constructed once per kernel process by `IPKernelApp.init_kernel` (`kernelapp.py:607`), or
    grafted onto a running kernel by `load_ipython_extension`. In both cases `_init_dag` performs
    the per-instance setup.

    Parameters
    ----------
    **kwargs
        Whatever `IPKernelApp.init_kernel` passes to the kernel class (parent app, session,
        sockets, threads; `kernelapp.py:622-632`). Forwarded untouched to `IPythonKernel`.

    Notes
    -----
    How a new message type gets a handler. `Kernel.__init__` (`ipykernel/kernelbase.py:312-317`)
    builds the two dispatch tables from class-level lists::

        for msg_type in self.msg_types:
            self.shell_handlers[msg_type] = getattr(self, msg_type)
        for msg_type in self.control_msg_types:
            self.control_handlers[msg_type] = getattr(self, msg_type)

    The tables are plain dicts and are never rebuilt, so `_init_dag` adds `analyze_request` to
    both of them directly, after construction. That is also how ipykernel itself adds the comm
    handlers (`ipykernel/ipkernel.py:163-165`), and it is the one mechanism that works both for a
    kernel constructed as this class and for a running kernel that `load_ipython_extension`
    converts, whose tables were filled by its old class.
    """

    implementation = "jupyter-dag"
    implementation_version = __version__

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._init_dag()

    def _init_dag(self) -> None:
        """Per-instance setup: the `analyze_request` handler entries and the comm target.

        Split out of `__init__` because `load_ipython_extension` swaps the class of a kernel that
        has already been constructed, so the `__init__` of this class never runs on that path; it
        calls this method instead.

        Notes
        -----
        `self.comm_manager` is the process-wide `CommManager` that `IPythonKernel.__init__`
        installs (`ipykernel/ipkernel.py:159`) and that ipywidgets and every other comm user share.
        Registering a target on it means "when a frontend opens a comm named `jupyter-dag`, call
        me": see `jupyter_dag.kernel.comm.DagCommTarget`.
        """
        self.shell_handlers[ANALYZE_REQUEST] = self.control_handlers[ANALYZE_REQUEST] = self.analyze_request
        self.dag_comm = DagCommTarget(self.comm_manager, self.shell)

    @property
    def kernel_info(self) -> dict[str, Any]:
        """dict: the `kernel_info_reply` content, with the jupyter-dag feature strings appended.

        `Kernel.kernel_info` (`ipykernel/kernelbase.py:992-1008`) is a plain property that
        assembles the reply and fills `supported_features` from hard-coded checks ("kernel
        subshells", "debugger"). There is no list to append to and no hook to call, so overriding
        the property and extending its result is the only way to advertise more features. The
        strings follow ipykernel's spelling convention, lower case and space separated:
        `jupyter_dag.protocol.ALL_FEATURES`.
        """
        info = super().kernel_info
        info["supported_features"].extend(ALL_FEATURES)
        return info

    async def analyze_request(self, stream: Any, ident: Any, parent: dict[str, Any]) -> None:
        """Handle `analyze_request`: static analysis of cells, answered with `analyze_reply`.

        Parameters
        ----------
        stream
            The ZMQ stream the request came in on (shell or control).
        ident
            ZMQ identities of the requesting client, passed through to the reply.
        parent : dict
            The `analyze_request` message; `parent["content"]["cells"]` is a list of
            `{"cell_id", "code"}` dicts (`jupyter_dag.protocol.AnalyzeCellInput`).

        Notes
        -----
        The signature is the one ipykernel calls every handler with: `dispatch_shell`
        (`kernelbase.py:398`) and `dispatch_control` (`kernelbase.py:344`) look the handler up
        by message type and await it (`kernelbase.py:476` and `:375`). All three arguments go back
        into `session.send` (`jupyter_client/session.py:760`): the reply's `parent_header` is
        copied from `parent`, which is how the frontend matches the reply to its pending request,
        and `ident` routes it to the right connected client. `is_complete_request`
        (`kernelbase.py:1113`) is the base-class handler this one is modelled on.

        On the control channel the handler runs on the control thread (`kernelbase.py:156`),
        possibly while the shell thread is inside a cell. That is safe because analysis touches no
        shell state: `jupyter_dag.analysis` parses the source with its own stateless
        `TransformerManager` and never reads the namespace.

        A reply is sent even when analysis raises. ipykernel only logs a handler's exception, and
        the frontend future resolves only after it has seen both the reply and the idle status
        (`@jupyterlab/services/lib/kernel/future.js:250-262`), so a missing reply would hang the
        caller forever.
        """
        if not self.session:
            return
        try:
            reply = {"status": "ok", "cells": analyze_cells(parent["content"]["cells"])}
        except Exception as exc:  # noqa: BLE001 - a missing reply would hang the frontend future
            reply = error_content(exc)
        self.session.send(stream, ANALYZE_REPLY, reply, parent, ident)

    async def do_execute(self, **kwargs: Any) -> dict[str, Any]:
        """Run a cell as `IPythonKernel` does, wrapped in the namespace operations.

        Order of events: snapshot the visible namespace, apply `namespace_delete` and
        `namespace_set` from the request, run the code, diff the namespace, attach the diff.

        Parameters
        ----------
        **kwargs
            As passed by `execute_request`: `code`, `silent`, `store_history`, `user_expressions`,
            `allow_stdin`, `cell_meta` and `cell_id`. See Notes.

        Returns
        -------
        dict
            The `execute_reply` content from `IPythonKernel`, plus `namespace_delta`.

        Notes
        -----
        Why the signature is `**kwargs`. `execute_request` (`kernelbase.py:786`) calls `do_execute`
        with keyword arguments only (`kernelbase.py:831`), and includes `cell_meta` and `cell_id`
        only when the signature accepts them; `kernelbase.py:76-88` treats `**kwargs` as accepting
        both. Forwarding them untouched to `IPythonKernel.do_execute` (`ipykernel/ipkernel.py:374`)
        means this method does not have to track ipykernel's parameter list.

        Why the extra request fields are read from the parent message. `execute_request` unpacks a
        fixed set of fields from the request content and ignores the rest, so `namespace_delete`
        and `namespace_set` are fetched from `self.get_parent()` (`kernelbase.py:694`), which
        returns the message currently being handled on this channel.

        Why the reply can simply carry `namespace_delta`. The dict this method returns is sent
        verbatim as the `execute_reply` content (`kernelbase.py:859`). Adding a key adds a field to
        the protocol message; clients that do not know it ignore it, and every connected client
        gets it, whichever of them sent the request. The frontend reads it off every
        `execute_reply` it sees, so there is no second delivery path.

        Examples
        --------
        A frontend that wants "purge these names, run nothing" sends::

            {"code": "", "silent": True, "store_history": False, "namespace_delete": ["df", "model"]}

        and gets back::

            {"status": "ok", ..., "namespace_delta": {"added": [], "removed": ["df", "model"]}}
        """
        content = (self.get_parent() or {}).get("content", {})
        before = visible_names(self.shell)
        delete_names(self.shell, content.get("namespace_delete", []))
        set_names(self.shell, content.get("namespace_set", {}))
        reply = await super().do_execute(**kwargs)
        reply["namespace_delta"] = compute_delta(before, visible_names(self.shell))
        return reply


# ---- runtime injection: `%load_ext jupyter_dag` on a stock kernel (after ipyflow kernel.py:137-150) ----


def load_ipython_extension(ipy: InteractiveShell) -> None:
    """Turn the running stock kernel into a DagKernel; the target of `%load_ext jupyter_dag`.

    `%load_ext` imports the named module and calls its `load_ipython_extension(shell)`
    (`IPython/core/extensions.py:53`). `jupyter_dag/__init__.py` forwards here lazily so that
    importing the package never imports ipykernel.

    Parameters
    ----------
    ipy : InteractiveShell
        The shell `%load_ext` passes in. Outside a kernel (plain IPython) it has no `kernel`
        attribute and this function does nothing.

    Notes
    -----
    How the swap works. The shell holds a reference to its kernel (`ZMQInteractiveShell.kernel`,
    `ipykernel/zmqshell.py:536`). Python allows reassigning `__class__` on an instance when the
    two classes share a compatible layout, which every `HasTraits` subclass without `__slots__`
    does. A subclass is created on the fly so that `DagKernel` precedes the kernel's existing
    class in the MRO: `class GeneratedDagKernel(DagKernel, prev)`. After the swap every method
    lookup finds the DagKernel overrides first (`do_execute`, `kernel_info`, `analyze_request`),
    and the base class's `__init__`-time state (session, sockets, comm manager) is untouched
    because no `__init__` runs. What `__init__` would have done is repeated by calling
    `DagKernel._init_dag`, which fills the handler tables and registers the comm target.

    The generated class also records the class it replaced, as `_dag_prev_class`, so
    `unload_ipython_extension` can put it back. Storing it on the class rather than in a module
    global keeps the fact with the swap: each `%load_ext` makes a fresh class with its own
    pointer, and once the swap is undone the attribute stops resolving by itself.

    Limitation. `kernel_info_reply` was answered when the frontend connected, before this ran, so
    the frontend's cached `supported_features` do not include the jupyter-dag strings. The
    frontend (`src/dag/protocol.ts`) therefore falls back to the comm transport, whose `features`
    message on open advertises them, until the kernel is restarted.

    References
    ----------
    The technique follows ipyflow (`ipyflow/kernel/kernel.py:137-150`, BSD-3-Clause, Stephen
    Macke), minus its MRO-inserting metaclass, which C3 linearisation makes unnecessary here.

    Examples
    --------
    In a notebook running the stock `python3` kernel::

        %load_ext jupyter_dag

    then, from the frontend, the comm transport can send `analyze_request` payloads.
    """
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
    """Undo `load_ipython_extension`; the target of `%unload_ext jupyter_dag`.

    Restores the class recorded at load time and removes the `analyze_request` entries from both
    handler tables.

    Parameters
    ----------
    ipy : InteractiveShell
        The shell `%unload_ext` passes in. Does nothing unless the kernel was swapped by
        `load_ipython_extension`.

    Notes
    -----
    The comm target stays registered on the shared `CommManager` (`unregister_target` exists,
    `comm/base_comm.py:229`, but `DagCommTarget` keeps no handle for it yet); comms already open
    keep their handlers regardless.
    """
    kernel = getattr(ipy, "kernel", None)
    prev = getattr(kernel, "_dag_prev_class", None)
    if prev is None:
        return
    kernel.shell_handlers.pop(ANALYZE_REQUEST, None)
    kernel.control_handlers.pop(ANALYZE_REQUEST, None)
    kernel.__class__ = prev
