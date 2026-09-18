"""Namespace operations on the live IPython shell, behind `namespace_delete`, `namespace_set` and `namespace_delta`.

The kernel's user namespace is `InteractiveShell.user_ns`, a plain dict that doubles as the
`__main__` module's namespace. Everything here goes through the shell's own methods rather than
poking that dict, so IPython's bookkeeping (the hidden-names table, the `__main__` module cache)
stays consistent.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

from ..protocol import NamespaceDelta


def visible_names(shell: InteractiveShell) -> set[str]:
    """Return the user-visible global names, exactly as `%who_ls` reports them.

    Parameters
    ----------
    shell : InteractiveShell
        The kernel's shell.

    Returns
    -------
    set of str
        Names in `user_ns` without a leading underscore that are not IPython's own injections.

    Notes
    -----
    IPython records what it injected itself (`In`, `Out`, `get_ipython`, `exit`, ...) in
    `user_ns_hidden` (`IPython/core/interactiveshell.py:1327`), and `%who_ls`
    (`IPython/core/magics/namespace.py:247`) hides a name only while it is still bound to that very
    object, so a user who rebinds `exit` sees it. Calling the magic keeps that rule in one place.
    `find_magic` (`interactiveshell.py:2667`) returns the bound method, which skips the argument
    expansion `run_line_magic` would do.
    """
    return set(shell.find_magic("who_ls")(""))


def delete_names(shell: InteractiveShell, names: Iterable[str]) -> list[str]:
    """Unbind `names` from the user namespace.

    Parameters
    ----------
    shell : InteractiveShell
        The kernel's shell.
    names : iterable of str
        Names to unbind; unknown names are ignored.

    Returns
    -------
    list of str
        The names that were bound and got unbound, in input order.

    Notes
    -----
    `InteractiveShell.del_var` (`interactiveshell.py:1562`) with `by_name=True` removes the name
    from `user_ns` and `user_global_ns` and from the `__main__` module cache it keeps for pickling,
    so the object can actually be collected. It raises `ValueError` for `__builtins__`, which is
    the one name this skips.
    """
    removed: list[str] = []
    for name in names:
        if name not in shell.user_ns:
            continue
        try:
            shell.del_var(name, by_name=True)
        except ValueError:
            continue
        removed.append(name)
    return removed


def set_names(shell: InteractiveShell, values: Mapping[str, Any]) -> list[str]:
    """Bind JSON values as user-namespace names; the "inputs" half of the design.

    Parameters
    ----------
    shell : InteractiveShell
        The kernel's shell.
    values : mapping of str to Any
        Name to value, as decoded from the message.

    Returns
    -------
    list of str
        The names bound, sorted.

    Notes
    -----
    `InteractiveShell.push` (`interactiveshell.py:1630`) with `interactive=True` updates `user_ns`
    and drops the names from `user_ns_hidden`, so they count as visible to `visible_names` and to
    `%who`, unlike names IPython injects for itself.
    """
    shell.push(dict(values), interactive=True)
    return sorted(values)


def compute_delta(before: set[str], after: set[str]) -> NamespaceDelta:
    """Compute the `namespace_delta` between two snapshots of `visible_names`.

    Parameters
    ----------
    before : set of str
        Visible names before the cell ran.
    after : set of str
        Visible names after it ran.

    Returns
    -------
    NamespaceDelta
        `added` and `removed`, both sorted.

    Notes
    -----
    A set difference cannot see a name rebound to a new value: `x = 1` after `x = 0` yields an
    empty delta. Staleness from rebinding is the frontend's job, through the analysis results.
    """
    return {"added": sorted(after - before), "removed": sorted(before - after)}
