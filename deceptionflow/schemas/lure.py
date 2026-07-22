from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    model_config = ConfigDict(extra="forbid", strict=True)

    authenticates_to_real_service: bool = False
    contains_real_data: bool = False
    permits_lateral_movement: bool = False
    callback_metadata_only: bool = True


class OperationsPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    owner: str = "purple-team"
    ttl_days: int = Field(default=30, ge=1, le=365)
    validation_interval_hours: int = Field(default=24, ge=1, le=168)
    cleanup_required: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def set_expiration(self) -> "OperationsPolicy":
        if self.created_at.tzinfo is None:
            raise ValueError("operations.created_at must include a timezone")
        if self.expires_at is None:
            self.expires_at = self.created_at + timedelta(days=self.ttl_days)
        elif self.expires_at.tzinfo is None:
            raise ValueError("operations.expires_at must include a timezone")
        return self


class TelemetryPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

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
    class_: LureClass = Field(alias="class", strict=False)
    placement_type: PlacementType = Field(strict=False)
    template: str
    trigger_type: str
    severity_on_trigger: Severity = Field(default=Severity.HIGH, strict=False)
    content: str
    safety: SafetyPolicy = Field(default_factory=SafetyPolicy)
    operations: OperationsPolicy = Field(default_factory=OperationsPolicy)
    telemetry: TelemetryPolicy = Field(default_factory=TelemetryPolicy)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(populate_by_name=True, extra="forbid", strict=True)

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
