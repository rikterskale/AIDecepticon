from collections import defaultdict
from datetime import timedelta

from pydantic import BaseModel, Field

from deceptionflow.schemas.event import DeceptionEvent, EventType


class CorrelatedIncident(BaseModel):
    key: str
    event_ids: list[str]
    lure_ids: list[str]
    event_types: list[str]
    first_seen: str
    last_seen: str
    event_count: int
    real_target_overlap: bool
    score: int = Field(ge=0, le=100)
    reasons: list[str]


def _event_identities(event: DeceptionEvent) -> list[str]:
    values = [
        ("correlation", event.correlation_id),
        ("session", event.session_id),
        ("tool_call", event.tool_call_id),
        ("workload", event.workload_identity),
        ("actor", event.actor_id),
        ("source", event.source_ip),
    ]
    return [f"{identity_type}:{value}" for identity_type, value in values if value]


def _event_key(event: DeceptionEvent) -> str:
    return (
        event.correlation_id
        or event.session_id
        or event.tool_call_id
        or event.workload_identity
        or event.actor_id
        or event.source_ip
        or event.event_id
    )


def correlate_events(
    events: list[DeceptionEvent], window: timedelta = timedelta(minutes=15)
) -> list[CorrelatedIncident]:
    ordered = sorted(events, key=lambda item: item.timestamp)
    parents = list(range(len(ordered)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    identity_owner: dict[str, int] = {}
    for index, event in enumerate(ordered):
        for identity in _event_identities(event):
            if identity in identity_owner:
                union(index, identity_owner[identity])
            else:
                identity_owner[identity] = index

    grouped: dict[int, list[DeceptionEvent]] = defaultdict(list)
    for index, event in enumerate(ordered):
        grouped[find(index)].append(event)

    incidents: list[CorrelatedIncident] = []
    for group in grouped.values():
        key = _event_key(group[0])
        current: list[DeceptionEvent] = []
        for event in group:
            if current and event.timestamp - current[-1].timestamp > window:
                incidents.append(_build_incident(key, current))
                current = []
            current.append(event)
        if current:
            incidents.append(_build_incident(key, current))

    return sorted(incidents, key=lambda incident: incident.last_seen, reverse=True)


def _build_incident(key: str, events: list[DeceptionEvent]) -> CorrelatedIncident:
    event_types = {event.event_type for event in events}
    lure_ids = sorted({event.lure_id for event in events})
    real_target_overlap = any(
        event.event_type == EventType.RESOURCE_ACCESSED
        and event.metadata.get("synthetic") is False
        for event in events
    )

    score = 10
    reasons = ["Deception telemetry observed"]
    if EventType.TOKEN_PRESENTED in event_types:
        score += 40
        reasons.append("Honeytoken or callback token was presented")
    if EventType.AUTH_ATTEMPT in event_types:
        score += 35
        reasons.append("Authentication was attempted against a canary identity")
    if len(lure_ids) > 1:
        score += 15
        reasons.append("Multiple lure identifiers were touched")
    if len(event_types) > 1:
        score += 10
        reasons.append("Multiple interaction stages were observed")
    if real_target_overlap:
        score += 30
        reasons.append("Authentic target activity overlapped the lure interaction")

    return CorrelatedIncident(
        key=key,
        event_ids=[event.event_id for event in events],
        lure_ids=lure_ids,
        event_types=sorted(event_type.value for event_type in event_types),
        first_seen=events[0].timestamp.isoformat(),
        last_seen=events[-1].timestamp.isoformat(),
        event_count=len(events),
        real_target_overlap=real_target_overlap,
        score=min(score, 100),
        reasons=reasons,
    )
