INSERT INTO control_plane_records (resource_type, record_id, payload)
VALUES
  ('organizations', 'org-default', '{"id":"org-default","name":"AIDecepticon Demo","slug":"aidecepticon-demo","status":"active","plan":"enterprise","createdAt":"2026-09-21T12:00:00.000Z"}'::jsonb),
  ('organizations', 'org-managed-lab', '{"id":"org-managed-lab","name":"Managed Customer Lab","slug":"managed-customer-lab","status":"active","plan":"managed","createdAt":"2026-09-21T12:00:00.000Z"}'::jsonb)
ON CONFLICT (resource_type, record_id) DO NOTHING;

UPDATE control_plane_records
SET payload = payload || jsonb_build_object('organizationId', 'org-default'),
    updated_at = NOW()
WHERE resource_type <> 'organizations'
  AND NOT payload ? 'organizationId';

CREATE INDEX control_plane_records_tenant_order
  ON control_plane_records (resource_type, (payload->>'organizationId'), ordinal DESC);

CREATE OR REPLACE FUNCTION enforce_control_plane_record_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.resource_type <> 'organizations' AND COALESCE(NEW.payload->>'organizationId', '') = '' THEN
    RAISE EXCEPTION 'organizationId is required for tenant-owned records';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.resource_type <> 'organizations'
     AND OLD.payload->>'organizationId' IS DISTINCT FROM NEW.payload->>'organizationId' THEN
    RAISE EXCEPTION 'tenant-owned records cannot move between organizations';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER control_plane_records_tenant_guard
BEFORE INSERT OR UPDATE ON control_plane_records
FOR EACH ROW
EXECUTE FUNCTION enforce_control_plane_record_tenant();
