"""Kernelspec installer for the jupyter-dag kernel (after ipyflow/kernel/install.py, BSD-3-Clause, Stephen Macke).

Run it from the interpreter the kernel should use: like `python -m ipykernel install`, it records that
interpreter's `sys.executable` in argv, so the kernel works from a server in a different environment.
The copy shipped in the wheel (jupyter-config/kernels/jupyter-dag/kernel.json, installed by pip into
share/jupyter/kernels) has a bare `python` argv[0] instead, which jupyter_client resolves to the
*server's* interpreter (KernelManager.format_kernel_cmd), so it only works when server and kernel share an
environment. jupyter_dag/tests/test_protocol.py checks that the shipped copy equals `kernel_json("python")`.
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
    """The kernel.json contents; argv[0] is `executable`, by default the running interpreter."""
    spec = get_kernel_dict(
        extra_arguments=[f"--IPKernelApp.kernel_class={KERNEL_CLASS}"],
        python_arguments=["-Xfrozen_modules=off"],  # keeps debugpy usable, as ipykernel's installer does
    )
    if executable is not None:
        spec["argv"][0] = executable
    spec["display_name"] = DISPLAY_NAME
    return spec


def write_kernel_spec(directory: Path | str | None = None, executable: str | None = None) -> str:
    """Write kernel.json plus ipykernel's logos into `directory` (a fresh temporary one by default); returns it."""
    return _write_ipykernel_spec(directory, overrides=kernel_json(executable))


def install(user: bool = False, prefix: str | None = None) -> str:
    """Install the kernelspec through jupyter_client; returns the destination directory."""
    staged = write_kernel_spec()
    try:
        return KernelSpecManager().install_kernel_spec(staged, kernel_name=KERNEL_NAME, user=user, prefix=prefix)
    finally:
        shutil.rmtree(staged, ignore_errors=True)


def _is_root() -> bool:
    try:
        return os.geteuid() == 0
    except AttributeError:
        return False  # not an admin on non-Unix platforms


def main(argv: list[str] | None = None) -> int:
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
