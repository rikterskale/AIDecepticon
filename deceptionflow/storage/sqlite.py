from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path

from deceptionflow.schemas.event import DeceptionEvent


class DuplicateEventError(ValueError):
    pass


class EventStore:
    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    event_id TEXT PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    lure_id TEXT NOT NULL,
                    exercise_id TEXT,
                    event_type TEXT NOT NULL,
                    source_ip TEXT,
                    actor_id TEXT,
                    workload_identity TEXT,
                    session_id TEXT,
                    tool_call_id TEXT,
                    correlation_id TEXT,
                    target_type TEXT,
                    target_name TEXT,
                    user_agent TEXT,
                    request_method TEXT,
                    request_path TEXT,
                    metadata_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_events_lure_id ON events(lure_id)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_events_correlation_id ON events(correlation_id)"
            )
            connection.commit()

    def insert(self, event: DeceptionEvent) -> DeceptionEvent:
        payload = event.model_dump(mode="json")
        with closing(self._connect()) as connection:
            try:
                connection.execute(
                    """
                INSERT INTO events (
                    event_id, timestamp, lure_id, exercise_id, event_type,
                    source_ip, actor_id, workload_identity, session_id,
                    tool_call_id, correlation_id, target_type, target_name,
                    user_agent, request_method, request_path, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                    payload["event_id"], payload["timestamp"], payload["lure_id"],
                    payload["exercise_id"], payload["event_type"], payload["source_ip"],
                    payload["actor_id"], payload["workload_identity"], payload["session_id"],
                    payload["tool_call_id"], payload["correlation_id"], payload["target_type"],
                    payload["target_name"], payload["user_agent"], payload["request_method"],
                    payload["request_path"], json.dumps(payload["metadata"], sort_keys=True),
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise DuplicateEventError(f"Event {event.event_id} already exists") from error
            connection.commit()
        return event

    def list(self, limit: int = 100) -> list[DeceptionEvent]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM events ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._row_to_event(row) for row in rows]

    def since(self, start: datetime, limit: int = 5000) -> list[DeceptionEvent]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM events WHERE timestamp >= ? ORDER BY timestamp ASC LIMIT ?",
                (start.isoformat(), limit),
            ).fetchall()
        return [self._row_to_event(row) for row in rows]

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> DeceptionEvent:
        data = dict(row)
        data["timestamp"] = datetime.fromisoformat(data["timestamp"])
        data["metadata"] = json.loads(data.pop("metadata_json"))
        return DeceptionEvent.model_validate(data)
