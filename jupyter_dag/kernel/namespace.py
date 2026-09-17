"""Namespace operations on the live IPython shell: namespace_delete and namespace_delta."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

from ..protocol import NamespaceDelta


def visible_names(shell: InteractiveShell) -> set[str]:
    """User-visible global names, as `%who_ls` reports them: no `_` prefix, none of IPython's own injections."""
    return set(shell.find_magic("who_ls")(""))


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
