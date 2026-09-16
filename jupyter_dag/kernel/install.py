"""Kernelspec writer and installer for the jupyter-dag kernel (after ipyflow/kernel/install.py, BSD-3-Clause).

The spec launches the stock ``ipykernel_launcher`` with ``IPKernelApp.kernel_class`` pointed at DagKernel,
so no launcher module of our own is needed. The copy shipped in the wheel,
jupyter-config/kernels/jupyter-dag/kernel.json, must equal ``kernel_json("python")``;
jupyter_dag/tests/test_protocol.py checks that.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from ipykernel.kernelspec import get_kernel_dict, make_ipkernel_cmd
from ipykernel.kernelspec import write_kernel_spec as _write_ipykernel_spec
from jupyter_client.kernelspec import KernelSpecManager

from ..protocol import DISPLAY_NAME, KERNEL_NAME

KERNEL_CLASS = "jupyter_dag.kernel.kernel.DagKernel"
_EXTRA_ARGUMENTS = [f"--IPKernelApp.kernel_class={KERNEL_CLASS}"]
# Keep debugpy usable, as ipykernel's own installer does (kernelspec.py:176-180).
_PYTHON_ARGUMENTS = ["-Xfrozen_modules=off"] if sys.version_info >= (3, 11) else None


def kernel_json(executable: str | None = None) -> dict[str, object]:
    """The kernel.json contents; `executable` defaults to the running interpreter."""
    spec = get_kernel_dict(extra_arguments=_EXTRA_ARGUMENTS, python_arguments=_PYTHON_ARGUMENTS)
    spec["argv"] = make_ipkernel_cmd(
        executable=executable, extra_arguments=_EXTRA_ARGUMENTS, python_arguments=_PYTHON_ARGUMENTS
    )
    spec["display_name"] = DISPLAY_NAME
    return spec


def write_kernel_spec(directory: Path, executable: str | None = None) -> Path:
    """Write kernel.json plus ipykernel's logos into `directory` (which must not exist yet)."""
    _write_ipykernel_spec(directory, overrides=kernel_json(executable))
    return directory / "kernel.json"


def install(user: bool = False, prefix: str | None = None) -> str:
    """Install the kernelspec through jupyter_client; returns the destination directory."""
    staged = _write_ipykernel_spec(overrides=kernel_json())  # a fresh temporary directory
    try:
        return KernelSpecManager().install_kernel_spec(staged, kernel_name=KERNEL_NAME, user=user, prefix=prefix)
    finally:
        shutil.rmtree(staged, ignore_errors=True)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="jupyter-dag-kernel", description="Install the jupyter-dag kernelspec")
    sub = parser.add_subparsers(dest="cmd", required=True)
    ins = sub.add_parser("install")
    group = ins.add_mutually_exclusive_group()
    group.add_argument("--user", action="store_true", help="install for the current user")
    group.add_argument(
        "--sys-prefix", action="store_const", const=sys.prefix, dest="prefix", help="install into sys.prefix"
    )
    group.add_argument("--prefix", help="install under this prefix")
    args = parser.parse_args(argv)
    print(install(user=args.user, prefix=args.prefix))


if __name__ == "__main__":
    main()
