import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { defaultOrganizationId, seedState } from './seed.js';

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const resourcePattern = /^[a-z][a-zA-Z0-9]*$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function assertResource(key) {
  if (!resourcePattern.test(key)) throw new Error(`Invalid store resource ${key}`);
}

function tenantRecord(item, organizationId) {
  if (!organizationId) return item;
  if (item.organizationId && item.organizationId !== organizationId) {
    throw new Error('Record organization does not match the active organization');
  }
  return { ...item, organizationId };
}

function inOrganization(item, organizationId) {
  return !organizationId || item.organizationId === organizationId;
}

function normalizeJsonState(state) {
  let changed = false;
  const normalized = { ...state };
  const knownOrganizations = new Map((state.organizations || []).map((organization) => [organization.id, organization]));
  for (const organization of seedState.organizations) {
    if (!knownOrganizations.has(organization.id)) {
      knownOrganizations.set(organization.id, clone(organization));
      changed = true;
    }
  }
  normalized.organizations = [...knownOrganizations.values()];
  for (const [resource, items] of Object.entries(normalized)) {
    if (resource === 'organizations' || !Array.isArray(items)) continue;
    normalized[resource] = items.map((item) => {
      if (item.organizationId) return item;
      changed = true;
      return { ...item, organizationId: defaultOrganizationId };
    });
  }
  return { state: normalized, changed };
}

export class JsonStore {
  constructor(dataDirectory = process.env.DATA_DIR || './runtime-data') {
    this.mode = 'json';
    this.dataDir = path.resolve(dataDirectory);
    this.statePath = path.join(this.dataDir, 'state.json');
    this.auditPath = path.join(this.dataDir, 'audit.ndjson');
    this.auditAppendQueue = Promise.resolve();
    const loaded = normalizeJsonState(this.load());
    this.state = loaded.state;
    if (loaded.changed) this.persist();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return clone(seedState);
      throw new Error(`Unable to load JSON state from ${this.statePath}: ${error.message}`);
    }
  }

  persist() {
    atomicWrite(this.statePath, JSON.stringify(this.state, null, 2));
  }

  async init() {}

  async read(key, options = {}) {
    assertResource(key);
    return clone((this.state[key] || []).filter((item) => inOrganization(item, options.organizationId)));
  }

  async add(key, item, options = {}) {
    assertResource(key);
    const record = tenantRecord(item, options.organizationId);
    const existing = (this.state[key] || []).find((candidate) => candidate.id === record.id);
    if (existing && !inOrganization(existing, options.organizationId)) {
      throw new Error('Record ID is already assigned to another organization');
    }
    this.state[key] = [record, ...(this.state[key] || [])];
    this.persist();
    return clone(record);
  }

  async update(key, id, changes, options = {}) {
    assertResource(key);
    const collection = this.state[key] || [];
    const index = collection.findIndex((item) => item.id === id && inOrganization(item, options.organizationId));
    if (index === -1) return null;
    if (changes.organizationId && changes.organizationId !== collection[index].organizationId) {
      throw new Error('A record cannot be moved between organizations');
    }
    collection[index] = tenantRecord({ ...collection[index], ...changes }, options.organizationId);
    this.persist();
    return clone(collection[index]);
  }

  async updateIfStatus(key, id, expectedStatuses, changes, options = {}) {
    assertResource(key);
    const collection = this.state[key] || [];
    const index = collection.findIndex((item) => item.id === id && inOrganization(item, options.organizationId));
    if (index === -1 || !expectedStatuses.includes(collection[index].status)) return null;
    if (changes.organizationId && changes.organizationId !== collection[index].organizationId) {
      throw new Error('A record cannot be moved between organizations');
    }
    collection[index] = tenantRecord({ ...collection[index], ...changes }, options.organizationId);
    this.persist();
    return clone(collection[index]);
  }

  async claimSensorCommands(sensorId, statuses, predicate, changesFactory) {
    const claimed = [];
    const collection = this.state.sensorCommands || [];
    for (let index = 0; index < collection.length; index += 1) {
      const command = collection[index];
      if (command.sensorId !== sensorId || !statuses.includes(command.status) || !predicate(command)) continue;
      collection[index] = { ...command, ...changesFactory(command) };
      claimed.push(clone(collection[index]));
    }
    if (claimed.length) this.persist();
    return claimed;
  }

  async appendAudit(factory) {
    const operation = async () => {
      const previous = (await this.readAudit(1))[0] || null;
      const event = await factory(previous);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      return clone(event);
    };
    this.auditAppendQueue = this.auditAppendQueue.then(operation, operation);
    return this.auditAppendQueue;
  }

  async readAudit(limit = 100, options = {}) {
    try {
      const lines = fs.readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.reverse()
        .map((line) => JSON.parse(line))
        .filter((event) => !options.organizationId || event.organizationId === options.organizationId)
        .slice(0, limit);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Unable to load audit events from ${this.auditPath}: ${error.message}`);
    }
  }

  async exportSnapshot() {
    await this.auditAppendQueue;
    const auditEvents = [...await this.readAudit(10_000_000)].reverse();
    return { resources: clone(this.state), auditEvents };
  }

  async importSnapshot(snapshot) {
    await this.auditAppendQueue;
    const previousState = clone(this.state);
    const previousAudit = fs.existsSync(this.auditPath) ? fs.readFileSync(this.auditPath, 'utf8') : '';
    const nextState = clone(snapshot.resources);
    const nextAudit = snapshot.auditEvents.length ? `${snapshot.auditEvents.map((event) => JSON.stringify(event)).join('\n')}\n` : '';
    try {
      atomicWrite(this.statePath, JSON.stringify(nextState, null, 2));
      atomicWrite(this.auditPath, nextAudit);
      this.state = nextState;
    } catch (error) {
      atomicWrite(this.statePath, JSON.stringify(previousState, null, 2));
      atomicWrite(this.auditPath, previousAudit);
      this.state = previousState;
      throw error;
    }
  }

  async health() {
    return { healthy: true, mode: this.mode };
  }

  async close() {}
}

export class PostgresStore {
  constructor(connectionString, options = {}) {
    this.mode = 'postgresql';
    this.migrationsDir = options.migrationsDir || path.join(here, 'migrations');
    const sslMode = options.sslMode ?? process.env.DATABASE_SSL;
    this.pool = options.pool || new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslMode === 'require' ? { rejectUnauthorized: true } : undefined,
    });
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(84632017)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS aidecepticon_schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const migrations = fs.readdirSync(this.migrationsDir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
      for (const file of migrations) {
        const version = Number(file.split('_', 1)[0]);
        const applied = await client.query('SELECT 1 FROM aidecepticon_schema_migrations WHERE version = $1', [version]);
        if (applied.rowCount) continue;
        await client.query('BEGIN');
        try {
          await client.query(fs.readFileSync(path.join(this.migrationsDir, file), 'utf8'));
          await client.query('INSERT INTO aidecepticon_schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      await this.seed(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(84632017)').catch(() => {});
      client.release();
    }
  }

  async seed(client) {
    const existing = await client.query("SELECT COUNT(*)::integer AS count FROM control_plane_records WHERE resource_type <> 'organizations'");
    if (existing.rows[0].count > 0) return;
    await client.query('BEGIN');
    try {
      for (const [resource, items] of Object.entries(seedState)) {
        for (const item of [...items].reverse()) {
          await client.query(
            'INSERT INTO control_plane_records (resource_type, record_id, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING',
            [resource, item.id, JSON.stringify(item)],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async read(key, options = {}) {
    assertResource(key);
    const result = await this.pool.query(
      `SELECT payload FROM control_plane_records
       WHERE resource_type = $1
         AND ($2::text IS NULL OR payload->>'organizationId' = $2)
       ORDER BY ordinal DESC`,
      [key, options.organizationId || null],
    );
    return result.rows.map((row) => row.payload);
  }

  async add(key, item, options = {}) {
    assertResource(key);
    const record = tenantRecord(item, options.organizationId);
    const result = await this.pool.query(
      `INSERT INTO control_plane_records (resource_type, record_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (resource_type, record_id)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
       WHERE $4::text IS NULL OR control_plane_records.payload->>'organizationId' = $4
       RETURNING payload`,
      [key, record.id, JSON.stringify(record), options.organizationId || null],
    );
    if (!result.rows[0]) throw new Error('Record ID is already assigned to another organization');
    return result.rows[0].payload;
  }

  async update(key, id, changes, options = {}) {
    assertResource(key);
    if (changes.organizationId && changes.organizationId !== options.organizationId) {
      throw new Error('A record cannot be moved between organizations');
    }
    const result = await this.pool.query(
      `UPDATE control_plane_records
       SET payload = payload || $3::jsonb, updated_at = NOW()
       WHERE resource_type = $1 AND record_id = $2
         AND ($4::text IS NULL OR payload->>'organizationId' = $4)
       RETURNING payload`,
      [key, id, JSON.stringify(changes), options.organizationId || null],
    );
    return result.rows[0]?.payload || null;
  }

  async updateIfStatus(key, id, expectedStatuses, changes, options = {}) {
    assertResource(key);
    if (changes.organizationId && changes.organizationId !== options.organizationId) {
      throw new Error('A record cannot be moved between organizations');
    }
    const result = await this.pool.query(
      `UPDATE control_plane_records
       SET payload = payload || $3::jsonb, updated_at = NOW()
       WHERE resource_type = $1 AND record_id = $2
         AND ($4::text IS NULL OR payload->>'organizationId' = $4)
         AND payload->>'status' = ANY($5::text[])
       RETURNING payload`,
      [key, id, JSON.stringify(changes), options.organizationId || null, expectedStatuses],
    );
    return result.rows[0]?.payload || null;
  }

  async claimSensorCommands(sensorId, statuses, predicate, changesFactory) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query(
        `SELECT record_id, payload FROM control_plane_records
         WHERE resource_type = 'sensorCommands'
           AND payload->>'sensorId' = $1
           AND payload->>'status' = ANY($2::text[])
         ORDER BY ordinal ASC
         FOR UPDATE SKIP LOCKED`,
        [sensorId, statuses],
      );
      const claimed = [];
      for (const row of candidates.rows) {
        if (!predicate(row.payload)) continue;
        const updated = await client.query(
          `UPDATE control_plane_records
           SET payload = payload || $2::jsonb, updated_at = NOW()
           WHERE resource_type = 'sensorCommands' AND record_id = $1
           RETURNING payload`,
          [row.record_id, JSON.stringify(changesFactory(row.payload))],
        );
        if (updated.rows[0]) claimed.push(updated.rows[0].payload);
      }
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAudit(factory) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(84632018)');
      const latest = await client.query('SELECT payload FROM administrative_audit_events ORDER BY sequence DESC LIMIT 1');
      const event = await factory(latest.rows[0]?.payload || null);
      await client.query(
        `INSERT INTO administrative_audit_events (event_id, occurred_at, payload, previous_hash, event_hash)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [event.id.replace(/^aud-/, ''), event.occurredAt, JSON.stringify(event), event.previousHash, event.hash],
      );
      await client.query('COMMIT');
      return event;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async readAudit(limit = 100, options = {}) {
    const result = await this.pool.query(
      `SELECT payload FROM administrative_audit_events
       WHERE ($2::text IS NULL OR payload->>'organizationId' = $2)
       ORDER BY sequence DESC LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 100, 1), 10_000), options.organizationId || null],
    );
    return result.rows.map((row) => row.payload);
  }

  async exportSnapshot() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const [records, audit] = await Promise.all([
        client.query('SELECT resource_type, payload FROM control_plane_records ORDER BY resource_type, ordinal DESC'),
        client.query('SELECT payload FROM administrative_audit_events ORDER BY sequence ASC'),
      ]);
      const resources = {};
      for (const row of records.rows) {
        resources[row.resource_type] ||= [];
        resources[row.resource_type].push(row.payload);
      }
      await client.query('COMMIT');
      return { resources, auditEvents: audit.rows.map((row) => row.payload) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async importSnapshot(snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(84632019)');
      await client.query('LOCK TABLE control_plane_records IN ACCESS EXCLUSIVE MODE');
      await client.query('LOCK TABLE administrative_audit_events IN ACCESS EXCLUSIVE MODE');
      await client.query("SET LOCAL aidecepticon.restore_mode = 'on'");
      await client.query('DELETE FROM administrative_audit_events');
      await client.query('DELETE FROM control_plane_records');
      for (const [resource, items] of Object.entries(snapshot.resources)) {
        assertResource(resource);
        for (const item of [...items].reverse()) {
          await client.query(
            'INSERT INTO control_plane_records (resource_type, record_id, payload) VALUES ($1, $2, $3::jsonb)',
            [resource, item.id, JSON.stringify(item)],
          );
        }
      }
      for (const event of snapshot.auditEvents) {
        await client.query(
          `INSERT INTO administrative_audit_events (event_id, occurred_at, payload, previous_hash, event_hash)
           VALUES ($1, $2, $3::jsonb, $4, $5)`,
          [event.id.replace(/^aud-/, ''), event.occurredAt, JSON.stringify(event), event.previousHash, event.hash],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    try {
      await this.pool.query('SELECT 1');
      return { healthy: true, mode: this.mode };
    } catch (error) {
      return { healthy: false, mode: this.mode, error: error.message };
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function createStore(environment = process.env) {
  return environment.DATABASE_URL
    ? new PostgresStore(environment.DATABASE_URL, { sslMode: environment.DATABASE_SSL })
    : new JsonStore(environment.DATA_DIR);
}

export const store = createStore();
