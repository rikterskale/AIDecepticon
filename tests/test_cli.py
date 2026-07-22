from pathlib import Path

from typer.testing import CliRunner

from deceptionflow.cli.main import app
from deceptionflow.config import get_settings
from deceptionflow.schemas.event import DeceptionEvent, EventType
from deceptionflow.storage.sqlite import EventStore


def test_cli_filesystem_workflow(tmp_path: Path, monkeypatch) -> None:
    project_root = Path(__file__).resolve().parents[1]
    lure_file = project_root / "lure_templates" / "df-cred-001.yaml"
    exercise_file = (
        project_root / "exercise_profiles" / "df-ai-001-filesystem-recon.yaml"
    )
    database_path = tmp_path / "data" / "deceptionflow.db"
    lure_target = tmp_path / "lab" / "production-access.md"
    report_path = tmp_path / "reports" / "windows-smoke.md"

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DECEPTIONFLOW_DATABASE_PATH", str(database_path))
    get_settings.cache_clear()

    runner = CliRunner()

    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0, result.output
    assert database_path.is_file()

    result = runner.invoke(
        app,
        [
            "deploy-filesystem",
            "--lure-file",
            str(lure_file),
            "--target",
            str(lure_target),
            "--callback-url",
            "http://127.0.0.1:8080",
        ],
    )
    assert result.exit_code == 0, result.output
    assert lure_target.is_file()

    result = runner.invoke(
        app,
        [
            "deploy-filesystem",
            "--lure-file",
            str(lure_file),
            "--target",
            str(lure_target),
            "--callback-url",
            "http://127.0.0.1:8080",
        ],
    )
    assert result.exit_code == 1
    assert "Error:" in result.output

    result = runner.invoke(
        app,
        [
            "validate-lure",
            "--lure-file",
            str(lure_file),
            "--target",
            str(lure_target),
            "--callback-url",
            "http://127.0.0.1:8080",
        ],
    )
    assert result.exit_code == 0, result.output

    store = EventStore(database_path)
    store.insert(
        DeceptionEvent(
            lure_id="DF-CRED-001",
            exercise_id="DF-AI-001",
            event_type=EventType.TOKEN_PRESENTED,
        )
    )
    store.insert(
        DeceptionEvent(
            lure_id="DF|PIPE\nX",
            exercise_id="DF-AI-001",
            event_type=EventType.LURE_READ,
        )
    )
    store.insert(
        DeceptionEvent(
            lure_id="DF-OTHER-001",
            exercise_id="DF-AI-OTHER",
            event_type=EventType.TOKEN_PRESENTED,
        )
    )

    result = runner.invoke(
        app,
        [
            "report",
            "--exercise-file",
            str(exercise_file),
            "--output",
            str(report_path),
        ],
    )
    assert result.exit_code == 0, result.output
    assert report_path.is_file()
    report = report_path.read_text(encoding="utf-8")
    assert "DF-CRED-001" in report
    assert "DF-OTHER-001" not in report
    assert "DF\\|PIPE<br>X" in report
    assert "DeceptionFlow version" in report
    assert "Correlation window minutes" in report

    expected_lure = lure_target.read_text(encoding="utf-8")
    lure_target.write_text(f"{expected_lure}\ntampered", encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "remove-lure",
            "--lure-file",
            str(lure_file),
            "--target",
            str(lure_target),
            "--callback-url",
            "http://127.0.0.1:8080",
        ],
    )
    assert result.exit_code == 1
    assert lure_target.exists()
    lure_target.write_text(expected_lure, encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "remove-lure",
            "--lure-file",
            str(lure_file),
            "--target",
            str(lure_target),
            "--callback-url",
            "http://127.0.0.1:8080",
        ],
    )
    assert result.exit_code == 0, result.output
    assert not lure_target.exists()

    invalid_lure = tmp_path / "invalid-lure.yaml"
    invalid_lure.write_text("id: [unterminated", encoding="utf-8")
    result = runner.invoke(
        app,
        [
            "deploy-filesystem",
            "--lure-file",
            str(invalid_lure),
            "--target",
            str(lure_target),
        ],
    )
    assert result.exit_code == 1
    assert "Invalid YAML" in result.output
    assert "Traceback" not in result.output

    get_settings.cache_clear()
