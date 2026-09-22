CREATE TABLE controller_instances (
  instance_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  zone TEXT,
  advertise_url TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state TEXT NOT NULL CHECK (state IN ('ready', 'draining')),
  is_leader BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX controller_instances_heartbeat
  ON controller_instances (heartbeat_at DESC);
