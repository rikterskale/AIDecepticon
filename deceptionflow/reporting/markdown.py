from datetime import UTC, datetime

from deceptionflow.correlation.engine import CorrelatedIncident
from deceptionflow.schemas.event import DeceptionEvent
from deceptionflow.schemas.exercise import ExerciseProfile


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items) if items else "- None recorded"


def build_markdown_report(
    exercise: ExerciseProfile,
    events: list[DeceptionEvent],
    incidents: list[CorrelatedIncident],
) -> str:
    generated = datetime.now(UTC).isoformat()
    model_identity = (
        f"{exercise.model_profile.provider} / {exercise.model_profile.family} / "
        f"{exercise.model_profile.version}"
    )
    event_rows = [
        f"| {event.timestamp.isoformat()} | {event.lure_id} | {event.event_type.value} | "
        f"{event.source_ip or '-'} | {event.correlation_id or event.session_id or '-'} |"
        for event in events
    ]
    incident_rows = [
        f"| {incident.key} | {incident.event_count} | {incident.score} | "
        f"{'Yes' if incident.real_target_overlap else 'No'} | {', '.join(incident.reasons)} |"
        for incident in incidents
    ]

    return f"""# {exercise.id}: {exercise.name}

**Generated:** {generated}  
**Model profile:** {exercise.model_profile.name}  
**Provider/family/version:** {model_identity}

## Objective

{exercise.objective}

## Starting condition

{exercise.starting_condition}

## Lures under test

{_bullets(exercise.lures_under_test)}

## Deployment steps

{_bullets(exercise.deployment_steps)}

## Trigger steps

{_bullets(exercise.trigger_steps)}

## Validation

{_bullets(exercise.validation)}

## Event evidence

| Timestamp | Lure | Event type | Source | Correlation/session |
|---|---|---|---|---|
{chr(10).join(event_rows) if event_rows else '| - | - | No events | - | - |'}

## Correlated incidents

| Key | Events | Score | Real-target overlap | Reasons |
|---|---:|---:|---|---|
{chr(10).join(incident_rows) if incident_rows else '| - | 0 | 0 | No | No incidents |'}

## Expected output

{_bullets(exercise.expected_output)}

## Detection

{_bullets(exercise.detection)}

## Real-target correlation

{_bullets(exercise.real_target_correlation)}

## Cleanup

{_bullets(exercise.cleanup)}

## Rollback

{_bullets(exercise.rollback)}

## Fallback

{_bullets(exercise.fallback)}

## Stop conditions

{_bullets(exercise.stop_conditions)}
"""
