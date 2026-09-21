CREATE TABLE control_plane_records (
  ordinal BIGSERIAL NOT NULL,
  resource_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (resource_type, record_id)
);

CREATE INDEX control_plane_records_resource_order
  ON control_plane_records (resource_type, ordinal DESC);

CREATE INDEX control_plane_records_payload_gin
  ON control_plane_records USING GIN (payload);
