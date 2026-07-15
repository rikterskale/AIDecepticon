from pathlib import Path

from deceptionflow.schemas.event import DeceptionEvent, EventType
from deceptionflow.storage.sqlite import EventStore


def test_insert_and_list(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "events.db")
    event = DeceptionEvent(
        lure_id="DF-CRED-001",
        event_type=EventType.TOKEN_PRESENTED,
        source_ip="192.0.2.10",
        correlation_id="exercise-1",
    )
    store.insert(event)
    events = store.list()

    assert len(events) == 1
    assert events[0].event_id == event.event_id
    assert events[0].source_ip == "192.0.2.10"
