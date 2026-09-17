"""Namespace operations on the live IPython shell: namespace_delete and namespace_delta."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

from ..protocol import NamespaceDelta

_MISSING = object()


def visible_names(shell: InteractiveShell) -> set[str]:
    """User-visible global names, by ``%who_ls``'s rule (IPython/core/magics/namespace.py).

    No ``_`` prefix, and not one of the objects IPython injected itself (In, Out, get_ipython, exit, ...),
    which ``user_ns_hidden`` records; the identity test keeps a user's own rebinding of such a name visible.
    """
    hidden = shell.user_ns_hidden
    return {n for n, v in shell.user_ns.items() if not n.startswith("_") and hidden.get(n, _MISSING) is not v}


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
