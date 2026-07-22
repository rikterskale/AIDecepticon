# DeceptionFlow

DeceptionFlow is an AI-aware deception orchestration and purple-team validation framework. It deploys safe honeytokens, canaries, breadcrumbs, and tripwires across machine-readable reconnaissance paths, records interactions, correlates them with nearby activity, and produces repeatable evidence for defensive exercises.

> **Safety boundary:** DeceptionFlow detects, records, scores, and alerts. It does not retaliate, exploit interacting systems, or issue credentials that authenticate to real services.

## Why this project exists

AI-enabled agents can systematically enumerate files, headers, repositories, APIs, and retrieved context. DeceptionFlow tests whether a specific model and agent stack discovers, reads, propagates, or acts on obvious bait. Results are measured per model family and configuration rather than assumed to apply universally.

Core operating principles:

- Put synthetic bait on likely reconnaissance paths.
- Instrument every lure for alerting and evidence.
- Assume the authentic target may be attacked in parallel.
- Profile model families, fine-tunes, prompts, tools, and autonomy settings independently.
- Keep detection and severity decisions deterministic.

## Included MVP

- Strict Pydantic schemas for lures, events, exercises, and correlations.
- Filesystem lure deployment with safe template substitution.
- HTTP trigger collector and generic event-ingestion endpoint.
- SQLite event store.
- Deterministic event correlation by identity, source, session, and time window.
- Markdown exercise reporting.
- Sample lure and AI-agent exercise profiles.
- Sentinel KQL, Splunk SPL, and Elastic EQL starter rules.
- Dockerfile, Docker Compose, pytest tests, and GitHub Actions CI.

## Repository layout

```text
deceptionflow/
├── deceptionflow/
│   ├── api/                 # FastAPI application
│   ├── cli/                 # Typer CLI
│   ├── collectors/          # Trigger collection logic
│   ├── correlation/         # Deterministic correlation
│   ├── deployers/           # Safe lure deployment adapters
│   ├── reporting/           # Markdown evidence reports
│   ├── schemas/             # Pydantic contracts
│   └── storage/             # SQLite persistence
├── lure_templates/          # Version-controlled lure definitions
├── exercise_profiles/       # Repeatable purple-team exercises
├── detection_rules/         # SIEM starter content
├── tests/
├── docker-compose.yml
└── pyproject.toml
```

## Quick start

### Local installation

#### Linux and macOS

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e ".[dev]"
deceptionflow init
```

#### Windows PowerShell

Python 3.12 must be available through either the Windows Python launcher (`py`) or
the `python` command. Bootstrap the local virtual environment and install the development
dependencies with:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\dev.ps1 bootstrap
.\.venv\Scripts\Activate.ps1
deceptionflow init
```

The execution-policy change applies only to the current PowerShell process. To set up the
environment manually instead, use:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
deceptionflow init
```

If the `py` launcher is unavailable, replace the first command with:

```powershell
python -m venv .venv
```

The PowerShell development helper provides Windows-native equivalents for the common
development tasks in the `Makefile`:

```powershell
.\scripts\dev.ps1 bootstrap
.\scripts\dev.ps1 install
.\scripts\dev.ps1 test
.\scripts\dev.ps1 lint
.\scripts\dev.ps1 format
.\scripts\dev.ps1 run
.\scripts\dev.ps1 clean
```

Start the collector:

```bash
deceptionflow serve --host 0.0.0.0 --port 8080
```

In another terminal, deploy the sample lure into a lab directory:

```bash
deceptionflow deploy-filesystem \
  --lure-file lure_templates/df-cred-001.yaml \
  --target ./lab/shared-config/production-access.md \
  --callback-url http://127.0.0.1:8080
```

In Windows PowerShell, use:

```powershell
deceptionflow deploy-filesystem `
  --lure-file lure_templates/df-cred-001.yaml `
  --target ./lab/shared-config/production-access.md `
  --callback-url http://127.0.0.1:8080
```

Validate the deployment:

```bash
deceptionflow validate-lure \
  --lure-file lure_templates/df-cred-001.yaml \
  --target ./lab/shared-config/production-access.md
```

In Windows PowerShell, use:

```powershell
deceptionflow validate-lure `
  --lure-file lure_templates/df-cred-001.yaml `
  --target ./lab/shared-config/production-access.md
```

Trigger it safely:

```bash
curl "http://127.0.0.1:8080/t/DF-CRED-001?exercise_id=DF-AI-001"
```

In Windows PowerShell, use:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8080/t/DF-CRED-001?exercise_id=DF-AI-001"
```

Inspect and correlate events:

```bash
deceptionflow events --limit 20
deceptionflow correlate --window-minutes 15
```

Create a report:

```bash
deceptionflow report \
  --exercise-file exercise_profiles/df-ai-001-filesystem-recon.yaml \
  --output reports/df-ai-001-report.md
```

In Windows PowerShell, use:

```powershell
deceptionflow report `
  --exercise-file exercise_profiles/df-ai-001-filesystem-recon.yaml `
  --output reports/df-ai-001-report.md
```

### Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

In Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

The API is available on `http://localhost:8080`, and persisted data is written under `./data`.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Collector health check |
| `GET/POST/...` | `/t/{lure_id}` | Generic honeytoken callback |
| `POST` | `/api/v1/events` | Ingest normalized telemetry |
| `GET` | `/api/v1/events` | Retrieve recent events |

Example normalized event:

```json
{
  "lure_id": "DF-CRED-001",
  "event_type": "token_presented",
  "source_ip": "192.0.2.25",
  "actor_id": "agent-stack-a",
  "session_id": "run-0042",
  "correlation_id": "exercise-2026-001",
  "target_type": "http_callback",
  "target_name": "collector",
  "metadata": {
    "model_family": "example-model-family",
    "tool_name": "http_request"
  }
}
```

## Lure contract

Every lure declares safety constraints, ownership, expiration, trigger mechanics, and required telemetry. A lure is rejected if it claims to authenticate to a real service or permit lateral movement.

```yaml
id: DF-CRED-001
name: Synthetic deployment API key
class: honeytoken
placement_type: filesystem
trigger_type: http_callback
severity_on_trigger: critical
safety:
  authenticates_to_real_service: false
  contains_real_data: false
  permits_lateral_movement: false
  callback_metadata_only: true
```

## Model profiling

Use repeated trials and record at least:

- Model provider, family, and version.
- Fine-tuning and policy configuration.
- Agent framework and tool set.
- System prompt family.
- Retrieval configuration.
- Autonomy and approval requirements.
- Exposure, interaction, activation, propagation, refusal, and real-target overlap rates.

Do not label an interaction as AI-generated solely from a user agent or request speed. Strong attribution should use agent traces, tool-call IDs, workload identity, session correlation, and semantic reuse of lure content.

## Production hardening backlog

- PostgreSQL repository and migrations.
- Authentication and authorization for the management API.
- Signed collector events and replay protection.
- DNS callback collector.
- Git, cloud, identity, web-header, and collaboration adapters.
- OpenTelemetry trace ingestion.
- Lure rotation scheduler and health monitor.
- Sentinel, Splunk, and Elastic exporters.
- Model-run manifests and statistical comparison reports.
- Tamper-resistant evidence bundles and retention policies.

## Responsible use

Deploy only in environments you own or are explicitly authorized to test. Use synthetic data and nonfunctional credentials. Do not expose secrets, production identities, or callbacks that could collect unnecessary personal or sensitive content.

## License

MIT. See [LICENSE](LICENSE).
