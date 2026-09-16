from __future__ import annotations
import ast
import builtins
import symtable
from typing import Protocol
from IPython.core.inputtransformer2 import TransformerManager
from .protocol import AnalyzedCell, AnalyzedCellError, AnalyzedCellOk, AnalyzeCellInput

_BUILTIN_NAMES = frozenset(vars(builtins))
DYNAMIC_CALLS = frozenset({"exec", "eval", "globals", "locals", "vars", "__import__", "run_cell_magic"})


class CellTransformer(Protocol):
    """Anything with IPython's transform_cell: an InteractiveShell or a TransformerManager."""

    def transform_cell(self, cell: str) -> str: ...


_DEFAULT_TRANSFORMER: CellTransformer = TransformerManager()


def transform_cell(code: str, transformer: CellTransformer | None = None) -> str:
    """Apply IPython input transforms; fall back to raw source on failure (ipkernel.py:410-414 does the same)."""
    try:
        return (transformer or _DEFAULT_TRANSFORMER).transform_cell(code)
    except Exception:
        return code


def _is_dynamic(tree: ast.Module) -> bool:
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
    return {t.id for node in ast.walk(tree) if isinstance(node, ast.Delete) for t in node.targets if isinstance(t, ast.Name)}


def analyze_source(cell_id: str, src: str) -> AnalyzedCellOk:
    """Analyze already-transformed Python source. Raises SyntaxError."""
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
            if "." in name:  # 3.14 __annotate__ scopes expose e.g. '.format'
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


def analyze_cell(cell_id: str, code: str, transformer: CellTransformer | None = None) -> AnalyzedCell:
    if code.lstrip().startswith("%%"):
        # transform_cell collapses the body into one run_cell_magic('...') string literal
        return {"cell_id": cell_id, "status": "opaque", "defined": [], "referenced": [], "deleted": [], "dynamic": True}
    try:
        return analyze_source(cell_id, transform_cell(code, transformer))
    except SyntaxError as exc:
        error: AnalyzedCellError = {"cell_id": cell_id, "status": "error", "ename": type(exc).__name__, "evalue": str(exc)}
        return error


def analyze_cells(cells: list[AnalyzeCellInput], transformer: CellTransformer | None = None) -> list[AnalyzedCell]:
    results = [analyze_cell(c.get("cell_id", ""), c.get("code", ""), transformer) for c in cells]
    # Builtins are not wires unless some cell in this batch shadows them.
    defined_anywhere = {n for r in results if r["status"] != "error" for n in r["defined"]}
    for r in results:
        if r["status"] != "error":
            r["referenced"] = [n for n in r["referenced"] if n not in _BUILTIN_NAMES or n in defined_anywhere]
    return results
