from dataclasses import dataclass
from pathlib import Path

from deceptionflow.schemas.lure import Lure, PlacementType


@dataclass(frozen=True)
class DeploymentResult:
    lure_id: str
    target: Path
    created: bool
    bytes_written: int


class FilesystemDeployer:
    def deploy(self, lure: Lure, target: str | Path, callback_url: str) -> DeploymentResult:
        if lure.placement_type != PlacementType.FILESYSTEM:
            raise ValueError("FilesystemDeployer only accepts filesystem lures")

        target_path = Path(target)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        rendered = (
            lure.content.replace("{{LURE_ID}}", lure.id)
            .replace("{{CALLBACK_URL}}", callback_url.rstrip("/"))
            .replace("{{TRIGGER_URL}}", f"{callback_url.rstrip('/')}/t/{lure.id}")
        )
        target_path.write_text(rendered, encoding="utf-8")
        return DeploymentResult(
            lure_id=lure.id,
            target=target_path,
            created=True,
            bytes_written=len(rendered.encode("utf-8")),
        )

    def validate(self, lure: Lure, target: str | Path) -> bool:
        target_path = Path(target)
        if not target_path.is_file():
            return False
        content = target_path.read_text(encoding="utf-8")
        return lure.id in content

    def remove(self, target: str | Path) -> bool:
        target_path = Path(target)
        if not target_path.exists():
            return False
        target_path.unlink()
        return True
