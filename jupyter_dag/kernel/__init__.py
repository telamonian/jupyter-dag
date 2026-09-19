"""Kernel-side half of jupyter-dag; import `jupyter_dag.kernel.kernel.DagKernel` explicitly.

This package module stays ipykernel-free: ipyflow's eager `import ipyflow.kernel.kernel` is what
costs `import ipyflow` 0.2 s and 833 modules.
"""
