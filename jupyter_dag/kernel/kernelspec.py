"""The jupyter-dag kernelspec: the stock ``ipykernel_launcher`` with ``IPKernelApp.kernel_class`` pointed at DagKernel.

The copy shipped in the wheel, jupyter-config/kernels/jupyter-dag/kernel.json, is what pip installs into
share/jupyter/kernels; ``kernel_json()`` regenerates it from ipykernel's own kernelspec helpers so that
jupyter_dag/tests/test_protocol.py can tell when the shipped copy has gone stale.
"""

from __future__ import annotations

from typing import Any

from ipykernel.kernelspec import get_kernel_dict

from ..protocol import DISPLAY_NAME

KERNEL_CLASS = "jupyter_dag.kernel.kernel.DagKernel"


def kernel_json() -> dict[str, Any]:
    """The kernel.json contents.

    argv[0] is a bare ``python``, which jupyter_client replaces with the server's interpreter
    (KernelManager.format_kernel_cmd), exactly as ipykernel's own spec relies on.
    """
    spec = get_kernel_dict(
        extra_arguments=[f"--IPKernelApp.kernel_class={KERNEL_CLASS}"],
        python_arguments=["-Xfrozen_modules=off"],  # keeps debugpy usable, as ipykernel's installer does
    )
    spec["argv"][0] = "python"
    spec["display_name"] = DISPLAY_NAME
    return spec
