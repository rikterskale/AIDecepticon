import crypto from 'node:crypto';
import os from 'node:os';

const defaultLeaderLockId = 84632020;
const instanceIdPattern = /^[a-zA-Z0-9._:-]{1,128}$/;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), minimum), maximum) : fallback;
}

function defaultInstanceId() {
  const hostname = os.hostname().replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 80) || 'controller';
  return `${hostname}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

export class HaCoordinator {
  constructor(store, environment = process.env, options = {}) {
    this.store = store;
    this.logger = options.logger || console;
    this.instanceId = String(environment.CONTROLLER_INSTANCE_ID || defaultInstanceId());
    if (!instanceIdPattern.test(this.instanceId)) throw new Error('CONTROLLER_INSTANCE_ID contains unsupported characters or exceeds 128 characters');
    this.version = String(environment.APP_VERSION || '0.1.0').slice(0, 64);
    this.zone = String(environment.CONTROLLER_ZONE || '').slice(0, 128);
    this.advertiseUrl = String(environment.CONTROLLER_ADVERTISE_URL || environment.PUBLIC_BASE_URL || '').slice(0, 500);
    this.heartbeatIntervalMs = boundedInteger(environment.HA_HEARTBEAT_INTERVAL_MS, 5_000, 1_000, 60_000);
    this.staleAfterMs = boundedInteger(environment.HA_STALE_AFTER_MS, 20_000, this.heartbeatIntervalMs * 2, 300_000);
    this.leaderLockId = boundedInteger(environment.HA_LEADER_LOCK_ID, defaultLeaderLockId, 1, 2_147_483_647);
    this.mode = store.mode === 'postgresql' ? 'postgresql-advisory-lock' : 'single-instance';
    this.startedAt = new Date().toISOString();
    this.lastHeartbeatAt = null;
    this.lastError = null;
    this.memberCount = 1;
    this.initialized = false;
    this.draining = false;
    this.leader = false;
    this.closed = false;
    this.running = false;
    this.timer = null;
    this.leaderClient = null;
    this.leaderErrorListener = null;
    this.listeners = new Set();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(this.health()); } catch (error) { this.logger.error(`HA state listener failed: ${error.message}`); }
    }
  }

  setLeader(value) {
    const next = Boolean(value);
    if (this.leader === next) return;
    this.leader = next;
    this.notify();
  }

  async init() {
    if (this.initialized) return;
    this.closed = false;
    this.draining = false;
    this.startedAt = new Date().toISOString();
    this.initialized = true;
    if (this.mode === 'single-instance') {
      this.lastHeartbeatAt = new Date().toISOString();
      this.setLeader(true);
    } else {
      await this.runOnce();
    }
    this.timer = setInterval(() => void this.runOnce(), this.heartbeatIntervalMs);
    this.timer.unref?.();
    this.notify();
  }

  async register() {
    const state = this.draining ? 'draining' : 'ready';
    await this.store.pool.query(
      `INSERT INTO controller_instances
        (instance_id, version, zone, advertise_url, started_at, heartbeat_at, state, is_leader)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
       ON CONFLICT (instance_id) DO UPDATE SET
         version = EXCLUDED.version,
         zone = EXCLUDED.zone,
         advertise_url = EXCLUDED.advertise_url,
         heartbeat_at = NOW(),
         state = EXCLUDED.state,
         is_leader = EXCLUDED.is_leader`,
      [this.instanceId, this.version, this.zone || null, this.advertiseUrl || null, this.startedAt, state, this.leader],
    );
    this.lastHeartbeatAt = new Date().toISOString();
  }

  async tryLeadership() {
    if (this.mode !== 'postgresql-advisory-lock' || this.draining || this.leader || this.closed) return;
    const client = await this.store.pool.connect();
    let retained = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [this.leaderLockId]);
      if (!result.rows[0]?.acquired) return;
      retained = true;
      this.leaderClient = client;
      this.leaderErrorListener = (error) => {
        if (this.leaderClient !== client) return;
        this.leaderClient = null;
        this.leaderErrorListener = null;
        this.lastError = `Leader connection lost: ${error.message}`;
        this.setLeader(false);
        client.release(error);
      };
      client.once('error', this.leaderErrorListener);
      await this.store.pool.query('UPDATE controller_instances SET is_leader = FALSE WHERE instance_id <> $1', [this.instanceId]);
      this.setLeader(true);
    } finally {
      if (!retained) client.release();
    }
  }

  async releaseLeadership() {
    const client = this.leaderClient;
    const errorListener = this.leaderErrorListener;
    this.leaderClient = null;
    this.leaderErrorListener = null;
    this.setLeader(false);
    if (client) {
      if (errorListener) client.off('error', errorListener);
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [this.leaderLockId]);
      } catch (error) {
        this.logger.error(`Unable to release controller leadership: ${error.message}`);
      } finally {
        client.release();
      }
    }
    if (this.mode === 'postgresql-advisory-lock') {
      await this.store.pool.query('UPDATE controller_instances SET is_leader = FALSE WHERE instance_id = $1', [this.instanceId]).catch(() => {});
    }
  }

  async runOnce() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      if (this.mode === 'single-instance') {
        this.lastHeartbeatAt = new Date().toISOString();
        this.lastError = null;
        return;
      }
      if (this.leaderClient) await this.leaderClient.query('SELECT 1');
      if (!this.leader && !this.draining) await this.tryLeadership();
      await this.register();
      const count = await this.store.pool.query(
        "SELECT COUNT(*)::integer AS count FROM controller_instances WHERE heartbeat_at >= NOW() - ($1::integer * INTERVAL '1 millisecond')",
        [this.staleAfterMs],
      );
      this.memberCount = count.rows[0]?.count || 1;
      if (this.leader) {
        await this.store.pool.query(
          "DELETE FROM controller_instances WHERE instance_id <> $1 AND heartbeat_at < NOW() - ($2::integer * INTERVAL '1 millisecond')",
          [this.instanceId, this.staleAfterMs * 3],
        );
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      if (this.leaderClient) await this.releaseLeadership();
      this.logger.error(`HA coordination failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  async setDraining(value) {
    const next = Boolean(value);
    if (this.draining === next) return;
    this.draining = next;
    if (next) await this.releaseLeadership();
    else if (this.mode === 'single-instance') this.setLeader(true);
    else await this.tryLeadership();
    if (this.mode === 'postgresql-advisory-lock') await this.register();
    this.lastError = null;
    this.notify();
  }

  async topology() {
    if (this.mode === 'single-instance') {
      return [{
        instanceId: this.instanceId,
        version: this.version,
        zone: this.zone,
        advertiseUrl: this.advertiseUrl,
        startedAt: this.startedAt,
        heartbeatAt: this.lastHeartbeatAt,
        state: this.draining ? 'draining' : 'ready',
        status: this.draining ? 'draining' : 'online',
        leader: this.leader,
        current: true,
      }];
    }
    const result = await this.store.pool.query(
      `SELECT instance_id, version, zone, advertise_url, started_at, heartbeat_at, state, is_leader,
              heartbeat_at >= NOW() - ($1::integer * INTERVAL '1 millisecond') AS online
       FROM controller_instances ORDER BY is_leader DESC, started_at ASC`,
      [this.staleAfterMs],
    );
    return result.rows.map((row) => ({
      instanceId: row.instance_id,
      version: row.version,
      zone: row.zone || '',
      advertiseUrl: row.advertise_url || '',
      startedAt: new Date(row.started_at).toISOString(),
      heartbeatAt: new Date(row.heartbeat_at).toISOString(),
      state: row.state,
      status: row.online ? (row.state === 'draining' ? 'draining' : 'online') : 'stale',
      leader: Boolean(row.is_leader && row.online),
      current: row.instance_id === this.instanceId,
    }));
  }

  health() {
    return {
      healthy: this.initialized && !this.lastError,
      ready: this.initialized && !this.draining && !this.lastError,
      mode: this.mode,
      instanceId: this.instanceId,
      leader: this.leader,
      state: this.draining ? 'draining' : 'ready',
      memberCount: this.memberCount,
      heartbeatAt: this.lastHeartbeatAt,
      ...(this.zone ? { zone: this.zone } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.draining = true;
    await this.releaseLeadership();
    if (this.mode === 'postgresql-advisory-lock') {
      await this.store.pool.query('DELETE FROM controller_instances WHERE instance_id = $1', [this.instanceId]).catch(() => {});
    }
    this.initialized = false;
    this.notify();
  }
}

export function createHaCoordinator(store, environment = process.env, options = {}) {
  return new HaCoordinator(store, environment, options);
}
