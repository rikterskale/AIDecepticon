from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class EventType(StrEnum):
    LURE_DISCOVERED = "lure_discovered"
    LURE_READ = "lure_read"
    TOKEN_PRESENTED = "token_presented"
    AUTH_ATTEMPT = "authentication_attempt"
    RESOURCE_ACCESSED = "resource_accessed"
    CONTENT_PROPAGATED = "content_propagated"
    VALIDATION = "validation"
    OTHER = "other"


class DeceptionEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    event_id: str = Field(default_factory=lambda: str(uuid4()))
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    lure_id: str
    exercise_id: str | None = None
    event_type: EventType = Field(strict=False)
    source_ip: str | None = None
    actor_id: str | None = None
    workload_identity: str | None = None
    session_id: str | None = None
    tool_call_id: str | None = None
    correlation_id: str | None = None
    target_type: str | None = None
    target_name: str | None = None
    user_agent: str | None = None
    request_method: str | None = None
    request_path: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
