"""Import point for the heavier snapshot/restore tier of the design.

A kernelspec selects it with ``metadata.kernel_provisioner.provisioner_name == "jupyter-dag-provisioner"``
(entry point group ``jupyter_client.kernel_provisioners`` in pyproject.toml). The hooks to fill in are
``pre_launch`` / ``launch_kernel`` / ``cleanup`` for process-level checkpointing (CRIU or DMTCP) and
``get_provisioner_info`` / ``load_provisioner_info`` for persisting where a snapshot lives.
"""

from __future__ import annotations

from jupyter_client.provisioning import LocalProvisioner

PROVISIONER_NAME = "jupyter-dag-provisioner"


class DagKernelProvisioner(LocalProvisioner):
    """Behaves exactly like LocalProvisioner until the snapshot tier is built."""
