from ipaddress import ip_network
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
    client = TestClient(
        create_app(store, trusted_proxy_ips=[ip_network("10.0.0.0/8")]),
        client=("198.51.100.20", 50000),
    )

    response = client.get(
        "/t/DF-CRED-001",
        headers={"x-forwarded-for": "192.0.2.25"},
    )

    assert response.status_code == 200
    assert store.list()[0].source_ip == "198.51.100.20"


def test_trigger_honors_forwarded_for_from_trusted_client(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "trusted-proxy.db")
    client = TestClient(
        create_app(store, trusted_proxy_ips=[ip_network("127.0.0.0/8")]),
        client=("127.0.0.1", 50000),
    )

    response = client.get(
        "/t/DF-CRED-001",
        headers={"x-forwarded-for": "192.0.2.25, 198.51.100.10"},
    )

    assert response.status_code == 200
    assert store.list()[0].source_ip == "192.0.2.25"


def test_trigger_rejects_invalid_forwarded_source_value(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "invalid-forwarded.db")
    client = TestClient(
        create_app(store, trusted_proxy_ips=[ip_network("127.0.0.0/8")]),
        client=("127.0.0.1", 50000),
    )

    response = client.get(
        "/t/DF-CRED-001",
        headers={"x-forwarded-for": "not-an-ip"},
    )

    assert response.status_code == 200
    assert store.list()[0].source_ip == "127.0.0.1"


def test_duplicate_event_is_rejected_with_conflict(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "duplicate.db")
    client = TestClient(create_app(store))
    event = {
        "event_id": "event-duplicate",
        "lure_id": "DF-CRED-001",
        "event_type": "token_presented",
    }

    assert client.post("/api/v1/events", json=event).status_code == 201
    response = client.post("/api/v1/events", json=event)

    assert response.status_code == 409
    assert response.json()["detail"] == "Event event-duplicate already exists"
