"""Parity checks between the hand-mirrored halves of the protocol."""

import json
import re
from pathlib import Path

from jupyter_dag import protocol
from jupyter_dag.kernel.install import kernel_json

ROOT = Path(__file__).resolve().parents[2]
MIRRORED = (
    "KERNEL_NAME",
    "COMM_TARGET",
    "FEATURE_ANALYZE",
    "FEATURE_NAMESPACE_DELETE",
    "FEATURE_NAMESPACE_SET",
    "FEATURE_NAMESPACE_DELTA",
    "ANALYZE_REQUEST",
    "ANALYZE_REPLY",
)


def test_constants_match_typescript():
    source = (ROOT / "src" / "dag" / "protocol.ts").read_text()
    ts = dict(re.findall(r"export const ([A-Z_]+) = '([^']*)';", source))
    for name in MIRRORED:
        assert ts[name] == getattr(protocol, name), name


def test_shipped_kernelspec_matches_installer():
    """The wheel's copy is the installer's spec with a bare `python` argv[0] (see kernel/install.py)."""
    shipped = json.loads((ROOT / "jupyter-config" / "kernels" / "jupyter-dag" / "kernel.json").read_text())
    assert shipped == kernel_json("python")
