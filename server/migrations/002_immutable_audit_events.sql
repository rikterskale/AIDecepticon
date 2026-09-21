CREATE TABLE administrative_audit_events (
  sequence BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  previous_hash CHAR(64) NOT NULL,
  event_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX administrative_audit_events_occurred_at
  ON administrative_audit_events (occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'administrative audit events are append-only';
END;
$$;

CREATE TRIGGER administrative_audit_events_no_row_mutation
BEFORE UPDATE OR DELETE ON administrative_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TRIGGER administrative_audit_events_no_truncate
BEFORE TRUNCATE ON administrative_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation();
