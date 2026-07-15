from fastapi import Request

from deceptionflow.schemas.event import DeceptionEvent, EventType


def build_http_event(lure_id: str, request: Request) -> DeceptionEvent:
    query = request.query_params
    forwarded_for = request.headers.get("x-forwarded-for")
    source_ip = forwarded_for.split(",")[0].strip() if forwarded_for else None
    if source_ip is None and request.client:
        source_ip = request.client.host

    reserved = {
        "exercise_id",
        "actor_id",
        "workload_identity",
        "session_id",
        "tool_call_id",
        "correlation_id",
    }
    metadata = {key: value for key, value in query.items() if key not in reserved}

    return DeceptionEvent(
        lure_id=lure_id,
        exercise_id=query.get("exercise_id"),
        event_type=EventType.TOKEN_PRESENTED,
        source_ip=source_ip,
        actor_id=query.get("actor_id"),
        workload_identity=query.get("workload_identity"),
        session_id=query.get("session_id"),
        tool_call_id=query.get("tool_call_id"),
        correlation_id=query.get("correlation_id"),
        target_type="http_callback",
        target_name="deceptionflow_collector",
        user_agent=request.headers.get("user-agent"),
        request_method=request.method,
        request_path=request.url.path,
        metadata=metadata,
    )
