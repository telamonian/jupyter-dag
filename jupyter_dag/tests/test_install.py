"""The installer records the interpreter that runs it, so a server elsewhere still launches this environment."""

import json
import sys
from pathlib import Path

from jupyter_dag.kernel.install import install
from jupyter_dag.protocol import KERNEL_NAME


def test_install_records_this_interpreter(tmp_path):
    dest = Path(install(prefix=str(tmp_path)))
    assert dest == tmp_path / "share" / "jupyter" / "kernels" / KERNEL_NAME
    spec = json.loads((dest / "kernel.json").read_text())
    assert spec["argv"][0] == sys.executable
    assert (dest / "logo-64x64.png").exists()
