# The Python side, by function

The Python package is the kernel half of jupyter-dag plus the packaging around it. About 1400
lines, organised so that the pure mechanisms have no dependency on ipykernel and the transports
are thin.

## Wire format

`jupyter_dag/protocol.py` holds every name and shape that crosses the kernel boundary: the
kernelspec and comm-target names, the four JEP 92 feature strings, the two message types, and
TypedDicts for the payloads (`AnalyzeCellInput`, `AnalyzedCellOk`, `AnalyzedCellError`,
`NamespaceDelta`, `CommRequest`). It also has `error_content`, which turns an exception into the
protocol's standard `{status: "error", ename, evalue, traceback}` reply. The TypedDicts document
and type-check; nothing enforces them at runtime. The string constants have twins in
`src/dag/protocol.ts`, and a test reads that file to check they match.

## Static analysis

`jupyter_dag/analysis.py` answers "which global names does this cell define, reference and
delete?" without touching the kernel namespace. Each cell goes through IPython's input transformer
first, so `%timeit x` and `y = !ls` become Python; then `ast` gives the tree and `symtable` gives
scope resolution. At module scope a symbol that the compiler marks assigned or imported is
`defined`, one that is only read is `referenced`; inside functions and classes a symbol counts only
if it reaches the module (`global` assignments define, global reads reference). `del` targets are
reported separately. A cell that calls `exec`, `eval`, `globals()` or friends, or star-imports, is
flagged `dynamic`; a `%%` cell magic is reported `opaque` without parsing; a syntax error becomes a
per-cell error result rather than a failed request. Builtins stay in `referenced`, since a
consumer only draws a wire for a name some other cell defines.

## Namespace operations

`jupyter_dag/kernel/namespace.py` implements delete, set and delta on the live shell through
IPython's own methods, so its bookkeeping stays consistent: the visible names are what `%who_ls`
reports (IPython's hidden names excluded), deletion is `del_var(by_name=True)` (which also clears
the `__main__` cache so objects can be collected), setting is `push(interactive=True)` (so the
new names count as visible), and the delta is a set difference of two snapshots.

## The kernel

`jupyter_dag/kernel/kernel.py` is `DagKernel`, an `IPythonKernel` subclass. It registers an
`analyze_request` handler in both of ipykernel's handler tables (shell and control), overrides
`kernel_info` to append the feature strings, and wraps `do_execute`: snapshot the visible names,
apply `namespace_delete` and `namespace_set` read off the request content, run the cell as usual,
then attach `namespace_delta` to the reply dict, which ipykernel sends verbatim as the
`execute_reply` content. The handler replies even when analysis raises, because a frontend future
resolves only after it sees a reply.

The same file has `load_ipython_extension`, the target of `%load_ext jupyter_dag`: it swaps the
running kernel's class for a generated subclass with `DagKernel` first in the method resolution
order and runs the per-instance setup, so a stock `python3` kernel gains the additions without a
restart. Its limitation is that the frontend's cached `kernel_info_reply` predates it, which is
why the comm transport exists. `%unload_ext` restores the previous class.

## The comm fallback

`jupyter_dag/kernel/comm.py` registers the `jupyter-dag` comm target and routes each `comm_msg` by
its `type` (`analyze_request`, `namespace_delete`, `namespace_set`) to a handler, replying on the
same comm. No request ids are needed: ipykernel stamps a reply sent from inside a handler with the
request as its parent, so the frontend's future for that request receives it. On open it sends a
`features` message listing the feature strings. `namespace_delta` is not carried here; it rides on
every `execute_reply` regardless of transport.

## Packaging and discovery

`jupyter_dag/__init__.py` is three discovery hooks and imports nothing heavy at import time:
JupyterLab's tooling asks it where the built frontend lives, jupyter_server asks it for the server
extension (which registers the template's example route and, only where an operator restricted
`allowed_message_types`, admits `analyze_request`), and IPython's `%load_ext` asks it for the
extension loader, which it forwards to the kernel module lazily.

`jupyter_dag/kernel/install.py` writes and installs the kernelspec, after ipyflow's installer. The
copy shipped in the wheel has a bare `python` in `argv`, which jupyter_client resolves to the
server's interpreter; running `jupyter-dag-kernel` (the `[project.scripts]` entry) from another
interpreter records that interpreter's `sys.executable` instead, with `--user`, `--sys-prefix` and
`--prefix` like `ipykernel install`. The spec starts the stock `ipykernel_launcher` with
`kernel_class` pointing at `DagKernel`, so there is no launcher module.

`jupyter_dag/provisioner.py` is the import point for the snapshot/restore tier: a
`LocalProvisioner` subclass registered under the `jupyter_client.kernel_provisioners` entry-point
group that does nothing extra yet. `jupyter_dag/routes.py` is the extension template's hello route,
kept as the place a server endpoint would go.

## Tests and tooling

`jupyter_dag/client.py` extends `BlockingKernelClient` with `analyze` and `namespace_delete`
request methods, built with jupyter_client's own `reqrep` helper, and `start_dag_kernel` starts a
kernel from a kernelspec directory for tests. `jupyter_dag/tests/` covers the analysis rules
(parametrised), a kernel round trip over a real kernel process (features advertised, analysis,
delete plus delta), the installer recording the interpreter, the constants matching the
TypeScript file, the shipped kernelspec matching the installer's output, and the template route.
Docstrings are numpydoc and linted with `python -m numpydoc lint` under the configuration in
`pyproject.toml`; `ruff` and `pytest` run under the project venv.
