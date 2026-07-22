import pytest

from deceptionflow.schemas.lure import Lure


def safe_lure() -> dict:
    return {
        "id": "DF-CRED-001",
        "name": "Synthetic key",
        "class": "honeytoken",
        "placement_type": "filesystem",
        "template": "test",
        "trigger_type": "http_callback",
        "severity_on_trigger": "critical",
        "content": "{{LURE_ID}} {{TRIGGER_URL}}",
        "safety": {
            "authenticates_to_real_service": False,
            "contains_real_data": False,
            "permits_lateral_movement": False,
            "callback_metadata_only": True,
        },
    }


def test_safe_lure_is_accepted() -> None:
    lure = Lure.model_validate(safe_lure())
    assert lure.id == "DF-CRED-001"


def test_real_authentication_is_rejected() -> None:
    data = safe_lure()
    data["safety"]["authenticates_to_real_service"] = True
    with pytest.raises(ValueError, match="Unsafe lure configuration"):
        Lure.model_validate(data)


def test_unknown_lure_field_is_rejected() -> None:
    data = safe_lure()
    data["unexpected"] = True
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        Lure.model_validate(data)


def test_lure_does_not_coerce_policy_types() -> None:
    data = safe_lure()
    data["operations"] = {"ttl_days": "30"}
    with pytest.raises(ValueError, match="valid integer"):
        Lure.model_validate(data)
