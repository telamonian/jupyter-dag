"""Static analysis of cell source: which global names a cell defines, references and deletes.

This is what answers `analyze_request` (`jupyter_dag.kernel.kernel.DagKernel.analyze_request`) and
the comm request of the same name. Nothing here reads the kernel namespace or any other shell
state, so it is safe to run on ipykernel's control thread.

Cell source is not Python until IPython has rewritten it, so every cell goes through IPython's
input transformer first (`transform_cell`) and only then through the standard library: `ast` for
the tree and `symtable` for scope resolution. `symtable` resolves scopes because deciding whether
a name in a function body refers to a global is the compiler's job; redoing it over the AST would
mean reimplementing Python's scoping rules.

Each cell is analysed on its own, so builtins such as `print` stay in `referenced`; whoever turns
results into wires only draws one for a name another cell defines, which drops them for free.
"""

from __future__ import annotations

import ast
import symtable

from IPython.core.inputtransformer2 import TransformerManager

from .protocol import AnalyzeCellInput, AnalyzedCell, AnalyzedCellOk

DYNAMIC_CALLS = frozenset({"exec", "eval", "globals", "locals", "vars", "__import__", "run_cell_magic"})
"""Calls that can bind or read names static analysis cannot see; any of them sets `dynamic`."""

_TRANSFORMER = TransformerManager()
"""Stateless; shared by every caller."""


def transform_cell(code: str) -> str:
    """Rewrite IPython syntax into plain Python, falling back to the raw source if that fails.

    Parameters
    ----------
    code : str
        Cell source as the user wrote it.

    Returns
    -------
    str
        Python source. `%magic` lines become `get_ipython().run_line_magic(...)` calls
        (`IPython/core/inputtransformer2.py:501`, and `:376` for the `x = %magic` form), `!cmd`
        becomes `get_ipython().system(...)`, and so on; ordinary Python comes back unchanged.

    Notes
    -----
    `TransformerManager.transform_cell` (`inputtransformer2.py:765`) is the same entry point
    `InteractiveShell.run_cell` uses before compiling, minus the shell's user-registered
    transformers, which analysis does not see. The fallback mirrors ipykernel's own
    (`ipykernel/ipkernel.py:411-413`): when a transformer raises, the raw source goes to the
    parser, which reports whatever is wrong with it.
    """
    try:
        return _TRANSFORMER.transform_cell(code)
    except Exception:
        return code


def _is_dynamic(tree: ast.Module) -> bool:
    """Return True if the cell can change names in ways the symbol table cannot show.

    Parameters
    ----------
    tree : ast.Module
        The parsed cell.

    Returns
    -------
    bool
        True for a star import or a call to any of `DYNAMIC_CALLS`, by plain name or attribute.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
            return True
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name in DYNAMIC_CALLS:
                return True
    return False


def _deleted_names(tree: ast.Module) -> set[str]:
    """Return the plain names that appear as targets of `del` statements anywhere in the cell.

    Parameters
    ----------
    tree : ast.Module
        The parsed cell.

    Returns
    -------
    set of str
        Names such as `x` in `del x`; attribute and subscript targets (`del a.b`, `del d[k]`) are
        not names and are skipped.
    """
    return {t.id for node in ast.walk(tree) if isinstance(node, ast.Delete) for t in node.targets if isinstance(t, ast.Name)}


def analyze_source(cell_id: str, src: str) -> AnalyzedCellOk:
    """Analyze already-transformed Python source.

    Parameters
    ----------
    cell_id : str
        Echoed into the result.
    src : str
        Python source, normally the output of `transform_cell`.

    Returns
    -------
    AnalyzedCellOk
        With `status` `"ok"` and the four name lists sorted.

    Raises
    ------
    SyntaxError
        From `ast.parse` or `symtable.symtable` when the source does not parse.

    Notes
    -----
    At module scope a symbol counts as defined when the compiler marks it assigned or imported, and
    as referenced when it is only read. Inside nested scopes (functions, classes, comprehensions,
    and the annotation and type-parameter scopes newer Pythons add) a symbol matters only if it
    reaches the module: assigned under a `global` declaration means defined, read as a global means
    referenced; locals are the cell's own business. Names the compiler synthesises for those scopes
    (`.format`, `.defaults`, ...) are not identifiers and are skipped.

    `del x` is assigned in the symbol table, so deleted names are reported separately; a name the
    cell both reads and binds is only `defined`.

    The source is parsed twice, once by `ast` and once by `symtable`, because `symtable` only
    accepts text and the AST is still needed for `del` targets and the dynamic-call check.
    """
    tree = ast.parse(src)
    table = symtable.symtable(src, "<cell>", "exec")
    defined: set[str] = set()
    referenced: set[str] = set()
    for sym in table.get_symbols():
        if sym.is_assigned() or sym.is_imported():
            defined.add(sym.get_name())
        elif sym.is_referenced():
            referenced.add(sym.get_name())
    stack = list(table.get_children())
    while stack:
        child = stack.pop()
        for sym in child.get_symbols():
            name = sym.get_name()
            if not name.isidentifier():  # CPython's synthesised scope locals ('.format', '.defaults', ...)
                continue
            if sym.is_declared_global() and sym.is_assigned():
                defined.add(name)
            elif sym.is_global() and sym.is_referenced():
                referenced.add(name)
        stack.extend(child.get_children())
    deleted = _deleted_names(tree)
    defined -= deleted  # symtable marks `del x` as assigned; report it separately
    referenced -= defined
    return {"cell_id": cell_id, "status": "ok", "defined": sorted(defined), "referenced": sorted(referenced), "deleted": sorted(deleted), "dynamic": _is_dynamic(tree)}


def analyze_cell(cell_id: str, code: str) -> AnalyzedCell:
    """Analyze one cell as the user wrote it; never raises.

    Parameters
    ----------
    cell_id : str
        Echoed into the result.
    code : str
        Cell source, with IPython syntax.

    Returns
    -------
    AnalyzedCell
        An `AnalyzedCellOk` with `status` `"ok"`, or `"opaque"` for a cell magic; an
        `AnalyzedCellError` when the transformed source does not parse.

    Notes
    -----
    A `%%` cell magic is reported opaque without parsing: the transformer turns the whole body into
    one string argument of `get_ipython().run_cell_magic(...)` (`inputtransformer2.py:232`), so the
    names inside it are invisible anyway and whether they are code at all depends on the magic.
    """
    if code.lstrip().startswith("%%"):
        return {"cell_id": cell_id, "status": "opaque", "defined": [], "referenced": [], "deleted": [], "dynamic": True}
    try:
        return analyze_source(cell_id, transform_cell(code))
    except SyntaxError as exc:
        return {"cell_id": cell_id, "status": "error", "ename": type(exc).__name__, "evalue": str(exc)}


def analyze_cells(cells: list[AnalyzeCellInput]) -> list[AnalyzedCell]:
    """Analyze a batch of cells, one result per input in the same order.

    Parameters
    ----------
    cells : list of AnalyzeCellInput
        The `cells` list from an `analyze_request` or comm request.

    Returns
    -------
    list of AnalyzedCell
        One entry per input; a cell that fails to parse gets an error entry, the others are
        unaffected.

    Raises
    ------
    KeyError
        When an input lacks `cell_id` or `code`; the request handlers turn that into an error
        reply for the whole request, which is what a malformed request deserves.
    """
    return [analyze_cell(c["cell_id"], c["code"]) for c in cells]
