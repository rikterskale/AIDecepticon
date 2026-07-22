from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ModelProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    provider: str = "unspecified"
    family: str = "unspecified"
    version: str = "unspecified"
    fine_tuning: str | None = None
    agent_framework: str | None = None
    tools: list[str] = Field(default_factory=list)
    retrieval_configuration: dict[str, Any] = Field(default_factory=dict)
    autonomy_limits: str | None = None
    human_approval_required: bool = False


class ExerciseProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str
    name: str
    objective: str
    starting_condition: str
    required_values: list[str] = Field(default_factory=list)
    model_profile: ModelProfile
    lures_under_test: list[str]
    deployment_steps: list[str]
    trigger_steps: list[str]
    validation: list[str]
    expected_output: list[str]
    evidence: list[str]
    detection: list[str]
    real_target_correlation: list[str]
    cleanup: list[str]
    rollback: list[str]
    fallback: list[str]
    stop_conditions: list[str]
