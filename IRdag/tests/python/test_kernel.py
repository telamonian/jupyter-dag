"""End-to-end tests against a real IRdag kernel, driven through jupyter_client.

Run from the jupyter-dag environment with ``pytest IRdag/tests/python``. Needs ``R`` on the path
with the IRdag package installed in one of its libraries, or in the library named by the
``IRDAG_R_LIBS`` environment variable, which is passed to the kernel as ``R_LIBS``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from jupyter_client.blocking.client import BlockingKernelClient
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.manager import KernelManager

pytestmark = pytest.mark.timeout(180)

KERNEL_NAME = "jupyter-dag-r"
FEATURES = {"cell analysis", "namespace delete", "namespace set", "namespace delta"}
TIMEOUT = 60


def _r_env() -> dict[str, str]:
    env = dict(os.environ)
    if os.environ.get("IRDAG_R_LIBS"):
        env["R_LIBS"] = os.environ["IRDAG_R_LIBS"]
    return env


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    r = shutil.which("R")
    if r is None:
        pytest.skip("R is not on the path")
    probe = subprocess.run([r, "--no-echo", "-e", 'invisible(loadNamespace("IRdag"))'], env=_r_env(), capture_output=True)
    if probe.returncode != 0:
        pytest.skip("the IRdag package is not installed: " + probe.stderr.decode(errors="replace"))
    kernels = tmp_path_factory.mktemp("kernels")
    spec_dir = kernels / KERNEL_NAME
    spec_dir.mkdir()
    spec = {
        "argv": [r, "--no-echo", "-e", "IRdag::main()", "--args", "{connection_file}"],
        "display_name": "R (jupyter-dag)",
        "language": "R",
    }
    if os.environ.get("IRDAG_R_LIBS"):
        spec["env"] = {"R_LIBS": os.environ["IRDAG_R_LIBS"]}
    (spec_dir / "kernel.json").write_text(json.dumps(spec))
    km = KernelManager(kernel_name=KERNEL_NAME, kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(kernels)]))
    km.start_kernel()
    kc: BlockingKernelClient = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=TIMEOUT)
    try:
        yield kc
    finally:
        kc.stop_channels()
        km.shutdown_kernel(now=True)


def _request(kc: BlockingKernelClient, msg_type: str, content: dict, channel: str = "shell") -> dict:
    """Send a message by hand on ``channel`` and return the matching reply."""
    msg = kc.session.msg(msg_type, content)
    send = kc.control_channel.send if channel == "control" else kc.shell_channel.send
    receive = kc.get_control_msg if channel == "control" else kc.get_shell_msg
    send(msg)
    while True:
        reply = receive(timeout=TIMEOUT)
        if reply["parent_header"].get("msg_id") == msg["header"]["msg_id"]:
            return reply


def _execute(kc: BlockingKernelClient, code: str, **extra) -> dict:
    content = {"code": code, "silent": False, "store_history": True, "user_expressions": {}, "allow_stdin": False, "stop_on_error": True}
    content.update(extra)
    return _request(kc, "execute_request", content)


def test_supported_features(client):
    reply = client.kernel_info(reply=True, timeout=TIMEOUT)
    assert FEATURES <= set(reply["content"]["supported_features"])
    assert reply["content"]["implementation"] == "IRdag"
    assert reply["content"]["language_info"]["name"] == "R"


@pytest.mark.parametrize("channel", ["shell", "control"])
def test_analyze_round_trip(client, channel):
    cells = [{"cell_id": "a", "code": "df <- read.csv(path)"}, {"cell_id": "b", "code": "df$x["}, {"cell_id": "c", "code": "y <- 1"}]
    reply = _request(client, "analyze_request", {"cells": cells}, channel=channel)
    assert reply["header"]["msg_type"] == "analyze_reply"
    assert reply["content"]["status"] == "ok"
    got = reply["content"]["cells"]
    assert got[0] == {"cell_id": "a", "status": "ok", "defined": ["df"], "referenced": ["path", "read.csv"], "deleted": [], "dynamic": False}
    assert got[1]["status"] == "error"
    assert got[2]["defined"] == ["y"]


def test_analyze_empty_and_malformed(client):
    assert _request(client, "analyze_request", {"cells": []})["content"] == {"status": "ok", "cells": []}
    bad = _request(client, "analyze_request", {"cells": [{"code": "x"}]})["content"]
    assert bad["status"] == "error"


def test_namespace_delta_delete_and_set(client):
    first = _execute(client, "x <- 1; y <- 2")
    assert first["content"]["status"] == "ok"
    assert {"x", "y"} <= set(first["content"]["namespace_delta"]["added"])
    purge = _execute(client, "", silent=True, store_history=False, namespace_delete=["x"])
    assert purge["content"]["namespace_delta"] == {"added": [], "removed": ["x"]}
    bound = _execute(client, "z <- n * 2", namespace_set={"n": 21})
    assert bound["content"]["status"] == "ok"
    assert set(bound["content"]["namespace_delta"]["added"]) == {"n", "z"}
    check = _execute(client, "stopifnot(identical(z, 42))")
    assert check["content"]["status"] == "ok"
    assert check["content"]["namespace_delta"] == {"added": [], "removed": []}


def test_error_reply_still_carries_delta(client):
    reply = _execute(client, "w <- 1; stop('boom')")
    assert reply["content"]["status"] == "error"
    assert reply["content"]["namespace_delta"]["added"] == ["w"]


def test_comm_fallback(client):
    comm_id = "test-comm-1234"
    client.shell_channel.send(client.session.msg("comm_open", {"comm_id": comm_id, "target_name": "jupyter-dag", "data": {}}))
    features = _comm_reply(client, comm_id)
    assert features["type"] == "features"
    assert FEATURES <= set(features["supported_features"])
    client.shell_channel.send(client.session.msg("comm_msg", {"comm_id": comm_id, "data": {"type": "analyze_request", "cells": [{"cell_id": "a", "code": "q <- 1"}]}}))
    analysed = _comm_reply(client, comm_id)
    assert analysed["status"] == "ok"
    assert analysed["cells"][0]["defined"] == ["q"]
    client.shell_channel.send(client.session.msg("comm_msg", {"comm_id": comm_id, "data": {"type": "namespace_set", "values": {"p": [1, 2, 3]}}}))
    assert _comm_reply(client, comm_id) == {"status": "ok", "set": ["p"]}
    client.shell_channel.send(client.session.msg("comm_msg", {"comm_id": comm_id, "data": {"type": "namespace_delete", "names": ["p", "missing"]}}))
    assert _comm_reply(client, comm_id) == {"status": "ok", "removed": ["p"]}
    client.shell_channel.send(client.session.msg("comm_msg", {"comm_id": comm_id, "data": {"type": "bogus"}}))
    assert _comm_reply(client, comm_id)["status"] == "error"


def _comm_reply(kc: BlockingKernelClient, comm_id: str) -> dict:
    while True:
        msg = kc.get_iopub_msg(timeout=TIMEOUT)
        if msg["header"]["msg_type"] == "comm_msg" and msg["content"]["comm_id"] == comm_id:
            return msg["content"]["data"]
