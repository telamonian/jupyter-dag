"""Parity checks between the hand-mirrored halves of the protocol."""

import json
import re
from pathlib import Path

import jupyter_dag.protocol as protocol
from jupyter_dag.kernel.kernelspec import kernel_json

ROOT = Path(__file__).resolve().parents[2]
MIRRORED = (
    "KERNEL_NAME",
    "COMM_TARGET",
    "FEATURE_ANALYZE",
    "FEATURE_NAMESPACE_DELETE",
    "FEATURE_NAMESPACE_DELTA",
    "ANALYZE_REQUEST",
    "ANALYZE_REPLY",
)


def test_constants_match_typescript():
    source = (ROOT / "src" / "dag" / "protocol.ts").read_text()
    ts = dict(re.findall(r"export const ([A-Z_]+) = '([^']*)';", source))
    for name in MIRRORED:
        assert ts[name] == getattr(protocol, name), name


def test_shipped_kernelspec_matches_generator():
    shipped = json.loads((ROOT / "jupyter-config" / "kernels" / "jupyter-dag" / "kernel.json").read_text())
    assert shipped == kernel_json()
