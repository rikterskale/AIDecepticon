from fastapi import FastAPI, Request

from deceptionflow import __version__
from deceptionflow.collectors.http import build_http_event
from deceptionflow.config import get_settings
from deceptionflow.schemas.event import DeceptionEvent
from deceptionflow.storage.sqlite import EventStore


def create_app(store: EventStore | None = None) -> FastAPI:
    settings = get_settings()
    event_store = store or EventStore(settings.database_path)
    application = FastAPI(
        title="DeceptionFlow Collector",
        version=__version__,
        description="Metadata-only deception telemetry collector for authorized environments.",
    )
    application.state.event_store = event_store

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @application.api_route(
        "/t/{lure_id}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    )
    async def trigger(lure_id: str, request: Request) -> dict[str, str]:
        event = build_http_event(lure_id, request)
        event_store.insert(event)
        return {"status": "recorded", "event_id": event.event_id}

    @application.post("/api/v1/events", response_model=DeceptionEvent, status_code=201)
    def ingest_event(event: DeceptionEvent) -> DeceptionEvent:
        return event_store.insert(event)

    @application.get("/api/v1/events", response_model=list[DeceptionEvent])
    def list_events(limit: int = 100) -> list[DeceptionEvent]:
        safe_limit = max(1, min(limit, 1000))
        return event_store.list(safe_limit)

    return application


app = create_app()
