import pytest
from jupyter_dag.analysis import analyze_cell, analyze_cells

@pytest.mark.parametrize(
    ("code", "defined", "referenced", "deleted"),
    [
        ("df = pd.read_csv(path)", ["df"], ["path", "pd"], []),
        ("import numpy as np\nfrom os import path", ["np", "path"], [], []),
        ("def f():\n    global counter\n    counter += y\n", ["counter", "f"], ["y"], []),
        ("x = 1\ndel z", ["x"], [], ["z"]),
    ],
)
def test_defined_referenced_deleted(code, defined, referenced, deleted):
    result = analyze_cell("c", code)
    assert result["status"] == "ok"
    assert result["defined"] == defined
    assert result["referenced"] == referenced
    assert result["deleted"] == deleted


def test_line_magic_is_transformed():
    assert analyze_cell("c", "x = %timeit -o pass")["defined"] == ["x"]


def test_cell_magic_is_opaque():
    assert analyze_cell("c", "%%time\nx = 1")["status"] == "opaque"


@pytest.mark.parametrize("code", ["from os import *", "exec(src)"])
def test_dynamic_flag(code):
    assert analyze_cell("c", code)["dynamic"] is True


def test_syntax_error_is_reported_per_cell():
    ok, bad = analyze_cells([{"cell_id": "a", "code": "a = 1"}, {"cell_id": "b", "code": "df.head("}])
    assert ok["status"] == "ok" and ok["cell_id"] == "a"
    assert bad["status"] == "error" and bad["ename"] == "SyntaxError" and bad["cell_id"] == "b"
