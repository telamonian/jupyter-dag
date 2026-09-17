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
    return [{
        "src": "labextension",
        "dest": "@telamonian/jupyter-dag"
    }]


def _jupyter_server_extension_points():
    return [{
        "module": "jupyter_dag"
    }]


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    from .protocol import ANALYZE_REQUEST
    from .routes import setup_route_handlers

    setup_route_handlers(server_app.web_app)
    # jupyter_server relays kernel messages opaquely (ZMQChannelsWebsocketConnection), so a new message
    # type needs no server code; only deployments that restrict allowed_message_types must admit it.
    kernel_manager = server_app.kernel_manager
    allowed = list(kernel_manager.allowed_message_types)
    if allowed and ANALYZE_REQUEST not in allowed:
        kernel_manager.allowed_message_types = [*allowed, ANALYZE_REQUEST]
    server_app.log.info("Registered jupyter_dag server extension")


def load_ipython_extension(ipython):
    """Support `%load_ext jupyter_dag` on a stock kernel (lazy: no ipykernel import here)."""
    from .kernel.kernel import load_ipython_extension as _load

    _load(ipython)


def unload_ipython_extension(ipython):
    """Counterpart of :func:`load_ipython_extension`."""
    from .kernel.kernel import unload_ipython_extension as _unload

    _unload(ipython)
