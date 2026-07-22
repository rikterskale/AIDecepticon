from pathlib import Path

from fastapi.testclient import TestClient

from deceptionflow.api.app import create_app
from deceptionflow.storage.sqlite import EventStore


def test_trigger_records_event(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "api.db")
    client = TestClient(create_app(store))

    response = client.get(
        "/t/DF-CRED-001?exercise_id=DF-AI-001&correlation_id=run-1",
        headers={"user-agent": "test-agent"},
    )

    assert response.status_code == 200
    events = store.list()
    assert len(events) == 1
    assert events[0].lure_id == "DF-CRED-001"
    assert events[0].correlation_id == "run-1"


def test_trigger_ignores_forwarded_for_from_untrusted_client(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "untrusted-proxy.db")
    client = TestClient(create_app(store, trusted_proxy_ips=set()))

    response = client.get(
        "/t/DF-CRED-001",
        headers={"x-forwarded-for": "192.0.2.25"},
    )

    assert response.status_code == 200
    assert store.list()[0].source_ip == "testclient"


def test_trigger_honors_forwarded_for_from_trusted_client(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "trusted-proxy.db")
    client = TestClient(create_app(store, trusted_proxy_ips={"testclient"}))

    response = client.get(
        "/t/DF-CRED-001",
        headers={"x-forwarded-for": "192.0.2.25, 198.51.100.10"},
    )

    assert response.status_code == 200
    assert store.list()[0].source_ip == "192.0.2.25"
