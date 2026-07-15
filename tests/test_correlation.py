from datetime import UTC, datetime, timedelta

from deceptionflow.correlation.engine import correlate_events
from deceptionflow.schemas.event import DeceptionEvent, EventType


def test_token_and_real_target_overlap_scores_critical() -> None:
    now = datetime.now(UTC)
    events = [
        DeceptionEvent(
            lure_id="DF-CRED-001",
            event_type=EventType.TOKEN_PRESENTED,
            correlation_id="run-1",
            timestamp=now,
        ),
        DeceptionEvent(
            lure_id="DF-PAIR-001",
            event_type=EventType.RESOURCE_ACCESSED,
            correlation_id="run-1",
            timestamp=now + timedelta(seconds=10),
            metadata={"synthetic": False},
        ),
    ]

    incidents = correlate_events(events)
    assert len(incidents) == 1
    assert incidents[0].real_target_overlap is True
    assert incidents[0].score >= 80
