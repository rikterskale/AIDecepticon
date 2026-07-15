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
