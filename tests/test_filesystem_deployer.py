from pathlib import Path

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
    assert deployer.validate(lure, target) is True
    assert "http://127.0.0.1:8080/t/DF-CRED-001" in target.read_text()
    assert deployer.remove(target) is True
    assert not target.exists()
