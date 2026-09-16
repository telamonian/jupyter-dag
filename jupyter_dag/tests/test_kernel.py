"""End-to-end tests against a real DagKernel started through jupyter_client."""

import pytest

from jupyter_dag.client import start_dag_kernel
from jupyter_dag.kernel.install import write_kernel_spec
from jupyter_dag.protocol import ALL_FEATURES, KERNEL_NAME

pytestmark = pytest.mark.timeout(120)


@pytest.fixture
def dag_client(tmp_path):
    write_kernel_spec(tmp_path / KERNEL_NAME)  # argv[0] is this interpreter
    km, kc = start_dag_kernel(kernel_dirs=[str(tmp_path)])
    try:
        yield kc
    finally:
        kc.stop_channels()
        km.shutdown_kernel(now=True)


def test_supported_features(dag_client):
    reply = dag_client.kernel_info(reply=True, timeout=30)
    assert set(ALL_FEATURES) <= set(reply["content"]["supported_features"])


def test_analyze_round_trip(dag_client):
    reply = dag_client.analyze(
        [{"cell_id": "a", "code": "df = pd.read_csv(path)"}, {"cell_id": "b", "code": "df.head("}],
        reply=True,
        timeout=30,
    )
    assert reply["header"]["msg_type"] == "analyze_reply"
    cells = reply["content"]["cells"]
    assert cells[0] == {
        "cell_id": "a",
        "status": "ok",
        "defined": ["df"],
        "referenced": ["path", "pd"],
        "deleted": [],
        "dynamic": False,
    }
    assert cells[1]["status"] == "error"


def test_namespace_delete_and_delta(dag_client):
    first = dag_client.execute("x = 1", reply=True, timeout=30)
    assert "x" in first["content"]["namespace_delta"]["added"]
    second = dag_client.namespace_delete(["x"], reply=True, timeout=30)
    assert second["content"]["namespace_delta"] == {"added": [], "removed": ["x"]}
