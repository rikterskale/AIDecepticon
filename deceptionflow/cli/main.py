import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

import typer
import uvicorn
import yaml
from rich.console import Console
from rich.table import Table

from deceptionflow.config import get_settings
from deceptionflow.correlation.engine import correlate_events
from deceptionflow.deployers.filesystem import FilesystemDeployer
from deceptionflow.reporting.markdown import build_markdown_report
from deceptionflow.schemas.exercise import ExerciseProfile
from deceptionflow.schemas.lure import Lure
from deceptionflow.storage.sqlite import EventStore

app = typer.Typer(no_args_is_help=True, help="AI-aware deception and purple-team validation.")
console = Console()


def _load_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise typer.BadParameter(f"Expected a YAML object in {path}")
    return data


def _store() -> EventStore:
    return EventStore(get_settings().database_path)


@app.command()
def init() -> None:
    """Initialize local data and report directories."""
    settings = get_settings()
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    Path("reports").mkdir(parents=True, exist_ok=True)
    EventStore(settings.database_path)
    console.print(f"[green]Initialized[/green] database at {settings.database_path}")


@app.command("serve")
def serve(
    host: str = typer.Option("127.0.0.1"),
    port: int = typer.Option(8080, min=1, max=65535),
    reload: bool = typer.Option(False, help="Development reload mode."),
) -> None:
    """Run the HTTP collector and event API."""
    uvicorn.run("deceptionflow.api.app:app", host=host, port=port, reload=reload)


@app.command("deploy-filesystem")
def deploy_filesystem(
    lure_file: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
    target: Annotated[Path, typer.Option(dir_okay=False)],
    callback_url: Annotated[str | None, typer.Option()] = None,
) -> None:
    """Deploy a safe, synthetic filesystem lure."""
    lure = Lure.model_validate(_load_yaml(lure_file))
    callback = callback_url or get_settings().public_base_url
    result = FilesystemDeployer().deploy(lure, target, callback)
    console.print(
        f"[green]Deployed[/green] {result.lure_id} to {result.target} "
        f"({result.bytes_written} bytes)"
    )


@app.command("validate-lure")
def validate_lure(
    lure_file: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
    target: Annotated[Path, typer.Option(dir_okay=False)],
) -> None:
    """Verify that the expected lure identifier is present at the target."""
    lure = Lure.model_validate(_load_yaml(lure_file))
    valid = FilesystemDeployer().validate(lure, target)
    if not valid:
        console.print("[red]Validation failed[/red]")
        raise typer.Exit(code=1)
    console.print("[green]Validation passed[/green]")


@app.command("events")
def events(
    limit: int = typer.Option(20, min=1, max=1000),
    as_json: bool = typer.Option(False, "--json", help="Print normalized JSON."),
) -> None:
    """Display recent deception events."""
    records = _store().list(limit)
    if as_json:
        console.print_json(json.dumps([event.model_dump(mode="json") for event in records]))
        return

    table = Table(title="Recent Deception Events")
    table.add_column("Timestamp")
    table.add_column("Lure")
    table.add_column("Type")
    table.add_column("Source")
    table.add_column("Correlation")
    for event in records:
        table.add_row(
            event.timestamp.isoformat(),
            event.lure_id,
            event.event_type.value,
            event.source_ip or "-",
            event.correlation_id or event.session_id or "-",
        )
    console.print(table)


@app.command("correlate")
def correlate(
    window_minutes: int = typer.Option(15, min=1, max=1440),
    lookback_hours: int = typer.Option(24, min=1, max=720),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """Correlate lure events using deterministic rules."""
    start = datetime.now(UTC) - timedelta(hours=lookback_hours)
    incidents = correlate_events(
        _store().since(start), window=timedelta(minutes=window_minutes)
    )
    if as_json:
        console.print_json(json.dumps([item.model_dump() for item in incidents]))
        return

    table = Table(title="Correlated Incidents")
    table.add_column("Key")
    table.add_column("Events", justify="right")
    table.add_column("Score", justify="right")
    table.add_column("Real target")
    table.add_column("Reasons")
    for item in incidents:
        table.add_row(
            item.key,
            str(item.event_count),
            str(item.score),
            "yes" if item.real_target_overlap else "no",
            "; ".join(item.reasons),
        )
    console.print(table)


@app.command("report")
def report(
    exercise_file: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
    output: Annotated[Path, typer.Option(dir_okay=False)] = Path(
        "reports/deceptionflow-report.md"
    ),
    lookback_hours: int = typer.Option(24, min=1, max=720),
    window_minutes: int = typer.Option(15, min=1, max=1440),
) -> None:
    """Build a Markdown purple-team evidence report."""
    exercise = ExerciseProfile.model_validate(_load_yaml(exercise_file))
    start = datetime.now(UTC) - timedelta(hours=lookback_hours)
    records = _store().since(start)
    incidents = correlate_events(records, window=timedelta(minutes=window_minutes))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(build_markdown_report(exercise, records, incidents), encoding="utf-8")
    console.print(f"[green]Report written[/green] to {output}")


if __name__ == "__main__":
    app()
