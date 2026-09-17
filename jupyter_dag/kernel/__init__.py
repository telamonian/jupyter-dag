"""The jupyter-dag kernel: an IPythonKernel subclass implementing analyze_request, namespace_delete and namespace_delta.

Import `jupyter_dag.kernel.kernel.DagKernel` explicitly; this package module stays ipykernel-free on purpose
(ipyflow's eager `import ipyflow.kernel.kernel` is what makes `import ipyflow` cost 0.2 s / 833 modules).
"""
