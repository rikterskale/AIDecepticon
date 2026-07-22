from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from shutil import copyfileobj
from urllib.parse import urlsplit

from deceptionflow.schemas.lure import Lure, PlacementType


@dataclass(frozen=True)
class DeploymentResult:
    lure_id: str
    target: Path
    created: bool
    bytes_written: int
    backup_path: Path | None = None


class FilesystemDeployer:
    @staticmethod
    def validate_callback_url(callback_url: str) -> str:
        parsed = urlsplit(callback_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Callback URL must be an absolute HTTP or HTTPS URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("Callback URL must not contain embedded credentials")
        if parsed.query or parsed.fragment:
            raise ValueError("Callback URL must not contain a query string or fragment")
        return callback_url.rstrip("/")

    @staticmethod
    def render(lure: Lure, callback_url: str) -> str:
        callback_url = FilesystemDeployer.validate_callback_url(callback_url)
        return (
            lure.content.replace("{{LURE_ID}}", lure.id)
            .replace("{{CALLBACK_URL}}", callback_url)
            .replace("{{TRIGGER_URL}}", f"{callback_url}/t/{lure.id}")
        )

    def deploy(
        self, lure: Lure, target: str | Path, callback_url: str, overwrite: bool = False
    ) -> DeploymentResult:
        if lure.placement_type != PlacementType.FILESYSTEM:
            raise ValueError("FilesystemDeployer only accepts filesystem lures")
        if lure.operations.expires_at and lure.operations.expires_at <= datetime.now(UTC):
            raise ValueError(f"Lure {lure.id} expired at {lure.operations.expires_at.isoformat()}")

        target_path = Path(target)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        rendered = self.render(lure, callback_url)
        target_existed = target_path.exists()
        backup_path = None
        if overwrite and target_existed:
            backup_path = target_path.with_name(f"{target_path.name}.bak")
            with target_path.open("rb") as source, backup_path.open("xb") as backup:
                copyfileobj(source, backup)
        mode = "w" if overwrite else "x"
        with target_path.open(mode, encoding="utf-8") as handle:
            handle.write(rendered)
        return DeploymentResult(
            lure_id=lure.id,
            target=target_path,
            created=not target_existed,
            bytes_written=len(rendered.encode("utf-8")),
            backup_path=backup_path,
        )

    def validate(self, lure: Lure, target: str | Path, callback_url: str) -> bool:
        target_path = Path(target)
        if not target_path.is_file():
            return False
        content = target_path.read_text(encoding="utf-8")
        return content == self.render(lure, callback_url)

    def remove(self, target: str | Path) -> bool:
        target_path = Path(target)
        if not target_path.exists():
            return False
        target_path.unlink()
        return True
