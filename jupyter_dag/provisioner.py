"""Import point for the heavier snapshot/restore tier of the design; a stub until that tier is built.

A kernel provisioner is jupyter_client's hook around the kernel process: `KernelManager` asks it to
launch, poll, and clean up the process instead of doing so itself. A kernelspec selects one with
`metadata.kernel_provisioner.provisioner_name`, and jupyter_client finds the class through the
`jupyter_client.kernel_provisioners` entry-point group (`jupyter_client/provisioning/factory.py:32`),
loaded only when a kernel using it starts (`factory.py:73`). `pyproject.toml` registers this class
under `jupyter-dag-provisioner`.
"""

from __future__ import annotations

from jupyter_client.provisioning import LocalProvisioner

PROVISIONER_NAME = "jupyter-dag-provisioner"


class DagKernelProvisioner(LocalProvisioner):
    """Behaves like `LocalProvisioner` until the snapshot tier is built.

    Notes
    -----
    `LocalProvisioner` (`jupyter_client/provisioning/local_provisioner.py:20`) is the default
    provisioner: a local subprocess. The hooks the snapshot tier would fill in are `pre_launch`,
    `launch_kernel` and `cleanup` (`provisioner_base.py:138`, `:105`, `:115`) for process-level
    checkpointing with CRIU or DMTCP, and `get_provisioner_info` / `load_provisioner_info`
    (`provisioner_base.py:172`, `:187`) for persisting where a snapshot lives.
    """
