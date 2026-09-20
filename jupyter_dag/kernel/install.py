"""Kernelspec installer for the jupyter-dag kernel, after ipyflow's `kernel/install.py` (BSD-3-Clause, Stephen Macke).

A kernelspec is a directory with a `kernel.json` whose `argv` tells jupyter_client how to start the
kernel. Ours starts the stock `ipykernel_launcher` and points `IPKernelApp.kernel_class` at
`DagKernel`, so there is no launcher module to write; everything else comes from ipykernel's own
kernelspec helpers.

Run the installer from the interpreter the kernel should use: like `python -m ipykernel install`,
it records that interpreter's `sys.executable` in `argv`, so the kernel works from a server in a
different environment. The copy shipped in the wheel (`jupyter-config/kernels/jupyter-dag/kernel.json`,
which pip installs into `share/jupyter/kernels`) has a bare `python` as `argv[0]` instead.
jupyter_client replaces that with the *server's* interpreter (`jupyter_client/manager.py:396-402`),
so the shipped copy only works when server and kernel share an environment.
`jupyter_dag/tests/test_protocol.py` checks that it equals `kernel_json("python")`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from ipykernel.kernelspec import get_kernel_dict
from ipykernel.kernelspec import write_kernel_spec as _write_ipykernel_spec
from jupyter_client.kernelspec import KernelSpecManager

from ..protocol import DISPLAY_NAME, KERNEL_NAME

KERNEL_CLASS = "jupyter_dag.kernel.kernel.DagKernel"


def kernel_json(executable: str | None = None) -> dict[str, Any]:
    """Build the `kernel.json` contents.

    Parameters
    ----------
    executable : str, optional
        What to put in `argv[0]`. By default the running interpreter, which is the point of
        running the installer from the right environment; `"python"` reproduces the shipped copy.

    Returns
    -------
    dict
        `argv`, `display_name`, `language`, `metadata` and `kernel_protocol_version`.

    Notes
    -----
    `get_kernel_dict` (`ipykernel/kernelspec.py:59-72`) is what ipykernel writes for its own
    `python3` spec: `argv` from `make_ipkernel_cmd` (`kernelspec.py:31`), which uses
    `sys.executable` unless told otherwise, plus the debugger and encryption metadata. Two
    arguments are added: `--IPKernelApp.kernel_class=...` selects this kernel, and
    `-Xfrozen_modules=off` keeps debugpy usable, which ipykernel's installer also adds by default
    (`kernelspec.py:178-180`).
    """
    spec = get_kernel_dict(
        extra_arguments=[f"--IPKernelApp.kernel_class={KERNEL_CLASS}"],
        python_arguments=["-Xfrozen_modules=off"],
    )
    if executable is not None:
        spec["argv"][0] = executable
    spec["display_name"] = DISPLAY_NAME
    return spec


def write_kernel_spec(directory: Path | str | None = None, executable: str | None = None) -> str:
    """Write a kernelspec directory: `kernel.json` plus ipykernel's logo files.

    Parameters
    ----------
    directory : Path or str, optional
        Where to write; must not exist yet. By default a fresh temporary directory.
    executable : str, optional
        Passed to `kernel_json`.

    Returns
    -------
    str
        The directory written.

    Notes
    -----
    Wraps ipykernel's `write_kernel_spec` (`ipykernel/kernelspec.py:74`), which copies its
    resource directory (the logos) and writes `kernel.json` with the given overrides applied on top
    of its own spec; here the overrides are the whole of `kernel_json`.
    """
    return _write_ipykernel_spec(directory, overrides=kernel_json(executable))


def install(user: bool = False, prefix: str | None = None) -> str:
    """Install the kernelspec where jupyter_client will find it.

    Parameters
    ----------
    user : bool, default False
        Install into the per-user kernels directory.
    prefix : str, optional
        Install under `<prefix>/share/jupyter/kernels` instead; `sys.prefix` targets the current
        environment. With neither, the install is system-wide and normally needs root.

    Returns
    -------
    str
        The directory the spec was installed into.

    Notes
    -----
    The spec is written to a temporary directory and handed to
    `KernelSpecManager.install_kernel_spec` (`jupyter_client/kernelspec.py:360`), which copies it
    under the chosen location as `jupyter-dag`, the same way `jupyter kernelspec install` does.
    """
    staged = write_kernel_spec()
    try:
        return KernelSpecManager().install_kernel_spec(staged, kernel_name=KERNEL_NAME, user=user, prefix=prefix)
    finally:
        shutil.rmtree(staged, ignore_errors=True)


def _is_root() -> bool:
    """Return True when running as root, so the default install can go system-wide.

    Returns
    -------
    bool
        False on platforms without `os.geteuid`, which are treated as non-admin.
    """
    try:
        return os.geteuid() == 0
    except AttributeError:
        return False


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point: `jupyter-dag-kernel` or `python -m jupyter_dag.kernel.install`.

    Parameters
    ----------
    argv : list of str, optional
        Arguments to parse instead of `sys.argv[1:]`: one of `--user`, `--sys-prefix`,
        `--prefix PREFIX`, or nothing.

    Returns
    -------
    int
        Process exit status, always 0; errors raise.

    Notes
    -----
    With no option the spec goes to the user directory unless the process is root, in which case
    it goes system-wide; this is ipyflow's default and matches `python -m ipykernel install`.
    """
    parser = argparse.ArgumentParser(
        prog="jupyter-dag-kernel",
        description=f"Install the {KERNEL_NAME} kernelspec for this interpreter ({sys.executable}).",
    )
    where = parser.add_mutually_exclusive_group()
    where.add_argument("--user", action="store_true", help="install into the user kernel directory (the default unless root)")
    where.add_argument("--sys-prefix", action="store_true", help="install into sys.prefix (a conda env or virtualenv)")
    where.add_argument("--prefix", help="install under this prefix")
    args = parser.parse_args(argv)
    if args.sys_prefix:
        dest = install(prefix=sys.prefix)
    elif args.prefix:
        dest = install(prefix=args.prefix)
    else:
        dest = install(user=args.user or not _is_root())
    print(f"Installed kernelspec {KERNEL_NAME} in {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
