from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, model_validator


class LureClass(StrEnum):
    HONEYTOKEN = "honeytoken"
    CANARY = "canary"
    BREADCRUMB = "breadcrumb"
    TRIPWIRE = "tripwire"


class PlacementType(StrEnum):
    FILESYSTEM = "filesystem"
    GIT = "git"
    WEB = "web"
    API = "api"
    IDENTITY = "identity"
    CLOUD = "cloud"
    COLLABORATION = "collaboration"
    AGENT_CONTEXT = "agent_context"


class Severity(StrEnum):
    INFORMATIONAL = "informational"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class SafetyPolicy(BaseModel):
    authenticates_to_real_service: bool = False
    contains_real_data: bool = False
    permits_lateral_movement: bool = False
    callback_metadata_only: bool = True


class OperationsPolicy(BaseModel):
    owner: str = "purple-team"
    ttl_days: int = Field(default=30, ge=1, le=365)
    validation_interval_hours: int = Field(default=24, ge=1, le=168)
    cleanup_required: bool = True
    expires_at: datetime | None = None


class TelemetryPolicy(BaseModel):
    required_fields: list[str] = Field(
        default_factory=lambda: [
            "lure_id",
            "timestamp",
            "event_type",
            "source_ip",
            "correlation_id",
        ]
    )


class Lure(BaseModel):
    id: str = Field(pattern=r"^DF-[A-Z]+-[0-9]{3,}$")
    name: str = Field(min_length=3, max_length=120)
    description: str = ""
    class_: LureClass = Field(alias="class")
    placement_type: PlacementType
    template: str
    trigger_type: str
    severity_on_trigger: Severity = Severity.HIGH
    content: str
    safety: SafetyPolicy = Field(default_factory=SafetyPolicy)
    operations: OperationsPolicy = Field(default_factory=OperationsPolicy)
    telemetry: TelemetryPolicy = Field(default_factory=TelemetryPolicy)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def enforce_safety_invariants(self) -> "Lure":
        unsafe = []
        if self.safety.authenticates_to_real_service:
            unsafe.append("authenticates_to_real_service")
        if self.safety.contains_real_data:
            unsafe.append("contains_real_data")
        if self.safety.permits_lateral_movement:
            unsafe.append("permits_lateral_movement")
        if not self.safety.callback_metadata_only:
            unsafe.append("callback_metadata_only=false")
        if unsafe:
            raise ValueError(f"Unsafe lure configuration: {', '.join(unsafe)}")
        return self
