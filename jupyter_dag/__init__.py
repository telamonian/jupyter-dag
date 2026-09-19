"""The jupyter-dag package: a DAG view over the notebook, backed by small additions to the kernel protocol.

The Python side is the kernel half. `protocol` holds the wire format; `analysis` and
`kernel.namespace` are the pure mechanisms (which names a cell defines and references, and the
namespace operations); `kernel.kernel` and `kernel.comm` are the two transports that expose them,
a message type of its own and a comm target; `kernel.install`, `provisioner`, `client` and
`routes` are packaging, tooling and the extension template's leftovers.

This module itself is three discovery hooks and nothing else at import time. Three different hosts
import the package and look for a function by name. JupyterLab's extension tooling calls
`_jupyter_labextension_paths` to find the built frontend. jupyter_server calls
`_jupyter_server_extension_points` and then `_load_jupyter_server_extension`
(`jupyter_server/extension/utils.py:54-76` and `:25-32`). IPython's `%load_ext jupyter_dag` calls
`load_ipython_extension` (`IPython/core/extensions.py:128`). The server never needs ipykernel and
the kernel never needs the server, so everything heavier than these shims is imported inside the
function that needs it.
"""

try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyter_dag' outside a proper installation.")
    __version__ = "dev"


def _jupyter_labextension_paths():
    """Tell JupyterLab where the built frontend lives and under which npm name to serve it.

    Returns
    -------
    list of dict
        One entry: `src` is the directory inside the package that `jlpm build` fills, `dest`
        the npm package name from `package.json`.
    """
    return [{
        "src": "labextension",
        "dest": "@telamonian/jupyter-dag"
    }]


def _jupyter_server_extension_points():
    """Tell jupyter_server which module holds `_load_jupyter_server_extension`.

    Returns
    -------
    list of dict
        One entry naming this package; jupyter_server imports the module and looks the loader up
        by name (`jupyter_server/extension/utils.py:25-32`).
    """
    return [{
        "module": "jupyter_dag"
    }]


def _load_jupyter_server_extension(server_app):
    """Register the template's REST route and admit `analyze_request` on the kernel websocket.

    Parameters
    ----------
    server_app : jupyterlab.labapp.LabApp
        JupyterLab application instance.

    Notes
    -----
    jupyter_server relays kernel messages opaquely, so a new message type needs no server code.
    The one exception is a deployment that restricts `MappingKernelManager.allowed_message_types`
    (`jupyter_server/services/kernels/kernelmanager.py:184`, enforced at
    `services/kernels/connection/channels.py:543`); the list is empty by default, meaning
    everything is allowed, and is only extended here when an operator has set it.
    """
    from .protocol import ANALYZE_REQUEST
    from .routes import setup_route_handlers

    setup_route_handlers(server_app.web_app)
    kernel_manager = server_app.kernel_manager
    allowed = list(kernel_manager.allowed_message_types)
    if allowed and ANALYZE_REQUEST not in allowed:
        kernel_manager.allowed_message_types = [*allowed, ANALYZE_REQUEST]
    server_app.log.info("Registered jupyter_dag server extension")


def load_ipython_extension(ipython):
    """Support `%load_ext jupyter_dag` on a stock kernel; see `jupyter_dag.kernel.kernel`.

    Parameters
    ----------
    ipython : IPython.core.interactiveshell.InteractiveShell
        The shell `%load_ext` passes in.
    """
    from .kernel.kernel import load_ipython_extension as _load

    _load(ipython)


def unload_ipython_extension(ipython):
    """Counterpart of `load_ipython_extension`, for `%unload_ext jupyter_dag`.

    Parameters
    ----------
    ipython : IPython.core.interactiveshell.InteractiveShell
        The shell `%unload_ext` passes in.
    """
    from .kernel.kernel import unload_ipython_extension as _unload

    _unload(ipython)
