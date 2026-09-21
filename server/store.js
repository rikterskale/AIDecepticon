import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { seedState } from './seed.js';

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const resourcePattern = /^[a-z][a-zA-Z0-9]*$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertResource(key) {
  if (!resourcePattern.test(key)) throw new Error(`Invalid store resource ${key}`);
}

export class JsonStore {
  constructor(dataDirectory = process.env.DATA_DIR || './runtime-data') {
    this.mode = 'json';
    this.dataDir = path.resolve(dataDirectory);
    this.statePath = path.join(this.dataDir, 'state.json');
    this.state = this.load();
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
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.statePath);
  }

  async init() {}

  async read(key) {
    assertResource(key);
    return clone(this.state[key] || []);
  }

  async add(key, item) {
    assertResource(key);
    this.state[key] = [item, ...(this.state[key] || [])];
    this.persist();
    return clone(item);
  }

  async update(key, id, changes) {
    assertResource(key);
    const collection = this.state[key] || [];
    const index = collection.findIndex((item) => item.id === id);
    if (index === -1) return null;
    collection[index] = { ...collection[index], ...changes };
    this.persist();
    return clone(collection[index]);
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
    const existing = await client.query('SELECT COUNT(*)::integer AS count FROM control_plane_records');
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

  async read(key) {
    assertResource(key);
    const result = await this.pool.query(
      'SELECT payload FROM control_plane_records WHERE resource_type = $1 ORDER BY ordinal DESC',
      [key],
    );
    return result.rows.map((row) => row.payload);
  }

  async add(key, item) {
    assertResource(key);
    const result = await this.pool.query(
      `INSERT INTO control_plane_records (resource_type, record_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (resource_type, record_id)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
       RETURNING payload`,
      [key, item.id, JSON.stringify(item)],
    );
    return result.rows[0].payload;
  }

  async update(key, id, changes) {
    assertResource(key);
    const result = await this.pool.query(
      `UPDATE control_plane_records
       SET payload = payload || $3::jsonb, updated_at = NOW()
       WHERE resource_type = $1 AND record_id = $2
       RETURNING payload`,
      [key, id, JSON.stringify(changes)],
    );
    return result.rows[0]?.payload || null;
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
