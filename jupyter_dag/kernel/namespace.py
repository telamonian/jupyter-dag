"""Namespace operations on the live IPython shell: namespace_delete and namespace_delta."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

from ..protocol import NamespaceDelta


def visible_names(shell: InteractiveShell) -> set[str]:
    """User-visible global names.

    IPython already hides its own injections (In, Out, _, _i1, get_ipython, exit, ...) through
    ``user_ns_hidden`` (init_user_ns, and the history and displayhook pushes with interactive=False),
    so the difference of the two key sets is the visible namespace.
    """
    return {n for n in shell.user_ns.keys() - shell.user_ns_hidden.keys() if not n.startswith("_")}


def delete_names(shell: InteractiveShell, names: Iterable[str]) -> list[str]:
    """Unbind `names` from every user namespace; returns the names that were bound."""
    removed: list[str] = []
    for name in names:
        if name not in shell.user_ns:
            continue
        try:
            shell.del_var(name, by_name=True)  # also clears user_global_ns and the __main__ module cache
        except ValueError:  # IPython refuses to delete __builtins__
            continue
        removed.append(name)
    return removed


def set_names(shell: InteractiveShell, values: Mapping[str, Any]) -> list[str]:
    """Bind JSON values as user-namespace names (inputs / parameters); returns the names bound."""
    shell.push(dict(values), interactive=True)
    return sorted(values)


def compute_delta(before: set[str], after: set[str]) -> NamespaceDelta:
    return {"added": sorted(after - before), "removed": sorted(before - after)}
