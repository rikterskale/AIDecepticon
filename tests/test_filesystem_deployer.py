from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from deceptionflow.deployers.filesystem import FilesystemDeployer
from deceptionflow.schemas.lure import Lure


def test_deploy_validate_and_remove(tmp_path: Path) -> None:
    lure = Lure.model_validate(
        {
            "id": "DF-CRED-001",
            "name": "Synthetic key",
            "class": "honeytoken",
            "placement_type": "filesystem",
            "template": "test",
            "trigger_type": "http_callback",
            "content": "id={{LURE_ID}} url={{TRIGGER_URL}}",
        }
    )
    target = tmp_path / "config" / "production-access.md"
    deployer = FilesystemDeployer()
    result = deployer.deploy(lure, target, "http://127.0.0.1:8080")

    assert result.created is True
    assert deployer.validate(lure, target, "http://127.0.0.1:8080") is True
    assert "http://127.0.0.1:8080/t/DF-CRED-001" in target.read_text()
    target.write_text(target.read_text() + "tampered", encoding="utf-8")
    assert deployer.validate(lure, target, "http://127.0.0.1:8080") is False
    assert deployer.remove(target) is True
    assert not target.exists()


def test_deploy_refuses_to_overwrite_existing_file(tmp_path: Path) -> None:
    lure = Lure.model_validate(
        {
            "id": "DF-CRED-001",
            "name": "Synthetic key",
            "class": "honeytoken",
            "placement_type": "filesystem",
            "template": "test",
            "trigger_type": "http_callback",
            "content": "id={{LURE_ID}} url={{TRIGGER_URL}}",
        }
    )
    target = tmp_path / "production-access.md"
    target.write_text("authentic configuration", encoding="utf-8")

    with pytest.raises(FileExistsError):
        FilesystemDeployer().deploy(lure, target, "http://127.0.0.1:8080")

    assert target.read_text(encoding="utf-8") == "authentic configuration"


def test_deploy_overwrite_creates_backup(tmp_path: Path) -> None:
    lure = Lure.model_validate(
        {
            "id": "DF-CRED-001",
            "name": "Synthetic key",
            "class": "honeytoken",
            "placement_type": "filesystem",
            "template": "test",
            "trigger_type": "http_callback",
            "content": "id={{LURE_ID}} url={{TRIGGER_URL}}",
        }
    )
    target = tmp_path / "production-access.md"
    target.write_text("authentic configuration", encoding="utf-8")

    result = FilesystemDeployer().deploy(
        lure, target, "https://collector.example", overwrite=True
    )

    assert result.backup_path is not None
    assert result.backup_path.read_text(encoding="utf-8") == "authentic configuration"
    assert "https://collector.example/t/DF-CRED-001" in target.read_text(encoding="utf-8")


def test_deploy_rejects_expired_lure(tmp_path: Path) -> None:
    lure = Lure.model_validate(
        {
            "id": "DF-CRED-001",
            "name": "Synthetic key",
            "class": "honeytoken",
            "placement_type": "filesystem",
            "template": "test",
            "trigger_type": "http_callback",
            "content": "id={{LURE_ID}}",
            "operations": {"expires_at": datetime.now(UTC) - timedelta(minutes=1)},
        }
    )

    with pytest.raises(ValueError, match="expired"):
        FilesystemDeployer().deploy(lure, tmp_path / "lure.txt", "https://collector.example")


@pytest.mark.parametrize(
    "callback_url",
    [
        "ftp://collector.example",
        "https://user:secret@collector.example",
        "https://collector.example?token=unsafe",
        "not-a-url",
    ],
)
def test_deploy_rejects_unsafe_callback_url(tmp_path: Path, callback_url: str) -> None:
    lure = Lure.model_validate(
        {
            "id": "DF-CRED-001",
            "name": "Synthetic key",
            "class": "honeytoken",
            "placement_type": "filesystem",
            "template": "test",
            "trigger_type": "http_callback",
            "content": "id={{LURE_ID}}",
        }
    )

    with pytest.raises(ValueError, match="Callback URL"):
        FilesystemDeployer().deploy(lure, tmp_path / "lure.txt", callback_url)
