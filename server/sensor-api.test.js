// @vitest-environment node
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server;
let baseUrl;
let verifySensorCommand;
let assertSensorSecurityConfiguration;
let closeInfrastructure;
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-sensor-api-'));

async function request(route, { method = 'GET', token, body, organizationId } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { 'X-AIDecepticon-Organization': organizationId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = temporaryDataDir;
  process.env.SENSOR_COMMAND_SIGNING_KEY = 'test-signing-key-with-at-least-32-bytes';
  process.env.AUDIT_SIGNING_KEY = 'audit-test-key-with-at-least-32-bytes';
  process.env.BACKUP_SCHEDULE_INTERVAL_HOURS = '1';
  const [{ app, initializeInfrastructure, closeInfrastructure: close }, sensorApi] = await Promise.all([import('./index.js'), import('./sensor-api.js')]);
  verifySensorCommand = sensorApi.verifySensorCommand;
  assertSensorSecurityConfiguration = sensorApi.assertSensorSecurityConfiguration;
  closeInfrastructure = close;
  await initializeInfrastructure();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await closeInfrastructure();
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

describe('projection sensor control channel', () => {
  it('reports the active persistence and queue health', async () => {
    const health = await request('/api/v1/health');
    expect(health.response.status).toBe(200);
    expect(health.payload.status).toBe('ok');
    expect(health.payload.infrastructure.storage.mode).toBe(process.env.DATABASE_URL ? 'postgresql' : 'json');
    expect(health.payload.infrastructure.queue.mode).toBe(process.env.REDIS_URL ? 'redis' : 'store');
    expect(health.payload.infrastructure.scheduler).toMatchObject({ healthy: true, mode: 'scheduled', active: true });
    expect(health.payload.infrastructure.authentication).toMatchObject({ healthy: true, mode: 'disabled' });
    expect(health.payload.infrastructure.secrets).toMatchObject({ healthy: true, mode: 'local' });
    expect(health.payload.infrastructure.audit).toMatchObject({ healthy: true, mode: 'hmac-sha256-chain', valid: true });
    expect(health.payload.infrastructure.backups).toMatchObject({ healthy: true, scheduled: true, active: true });
    expect(health.payload.infrastructure.highAvailability).toMatchObject({ healthy: true, ready: true, mode: process.env.DATABASE_URL ? 'postgresql-advisory-lock' : 'single-instance' });
  });

  it('exposes probes and guides the current controller through drain and resume', async () => {
    const live = await request('/api/v1/health/live');
    expect(live.response.status).toBe(200);
    expect(live.payload.status).toBe('alive');
    const ready = await request('/api/v1/health/ready');
    expect(ready.response.status).toBe(200);
    expect(ready.payload.status).toBe('ready');

    const topology = await request('/api/v1/platform/instances');
    expect(topology.response.status).toBe(200);
    expect(topology.payload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ current: true, status: 'online' }),
    ]));

    const drained = await request('/api/v1/platform/instances/current/drain', { method: 'POST', body: {} });
    expect(drained.response.status).toBe(200);
    expect(drained.payload.current).toMatchObject({ ready: false, leader: false, state: 'draining' });
    const unavailable = await request('/api/v1/health/ready');
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.payload.status).toBe('not_ready');
    const drainedHealth = await request('/api/v1/health');
    expect(drainedHealth.payload.infrastructure.scheduler.active).toBe(false);
    expect(drainedHealth.payload.infrastructure.backups.active).toBe(false);

    const resumed = await request('/api/v1/platform/instances/current/resume', { method: 'POST', body: {} });
    expect(resumed.response.status).toBe(200);
    expect(resumed.payload.current).toMatchObject({ ready: true, leader: true, state: 'ready' });
    expect((await request('/api/v1/health/ready')).response.status).toBe(200);
    const resumedHealth = await request('/api/v1/health');
    expect(resumedHealth.payload.infrastructure.scheduler.active).toBe(true);
    expect(resumedHealth.payload.infrastructure.backups.active).toBe(true);
  });

  it('stores encrypted secrets and exposes only verified metadata', async () => {
    const value = `siem-secret-${crypto.randomUUID()}`;
    const created = await request('/api/v1/secrets', {
      method: 'POST',
      body: { name: 'Splunk HEC', type: 'integration', description: 'SOC export credential', value },
    });
    expect(created.response.status).toBe(201);
    expect(created.payload).toMatchObject({ name: 'Splunk HEC', provider: 'local', status: 'active' });
    expect(created.payload).not.toHaveProperty('envelope');
    expect(JSON.stringify(created.payload)).not.toContain(value);

    const verification = await request(`/api/v1/secrets/${created.payload.id}/verify`, { method: 'POST', body: {} });
    expect(verification.payload).toMatchObject({ verified: true, provider: 'local' });
    const listing = await request('/api/v1/secrets');
    expect(listing.payload.items.find((item) => item.id === created.payload.id)).not.toHaveProperty('envelope');

    const audit = await request('/api/v1/audit-events');
    expect(audit.payload.verification.valid).toBe(true);
    expect(audit.payload.items.some((event) => event.action === 'secret.create' && event.target.id === created.payload.id)).toBe(true);
    expect(JSON.stringify(audit.payload)).not.toContain(value);
  });

  it('keeps control-plane data and audit views isolated by organization', async () => {
    const organizations = await request('/api/v1/organizations');
    expect(organizations.payload.items.map((organization) => organization.id)).toEqual(expect.arrayContaining(['org-default', 'org-managed-lab']));

    const primaryName = `Primary ${crypto.randomUUID()}`;
    const managedName = `Managed ${crypto.randomUUID()}`;
    const primary = await request('/api/v1/secrets', {
      method: 'POST',
      organizationId: 'org-default',
      body: { name: primaryName, type: 'api', value: 'primary-tenant-secret' },
    });
    const managed = await request('/api/v1/secrets', {
      method: 'POST',
      organizationId: 'org-managed-lab',
      body: { name: managedName, type: 'api', value: 'managed-tenant-secret' },
    });
    expect(primary.response.status).toBe(201);
    expect(managed.response.status).toBe(201);

    const primaryList = await request('/api/v1/secrets', { organizationId: 'org-default' });
    const managedList = await request('/api/v1/secrets', { organizationId: 'org-managed-lab' });
    expect(primaryList.payload.items.some((secret) => secret.name === primaryName)).toBe(true);
    expect(primaryList.payload.items.some((secret) => secret.name === managedName)).toBe(false);
    expect(managedList.payload.items.some((secret) => secret.name === managedName)).toBe(true);
    expect(managedList.payload.items.some((secret) => secret.name === primaryName)).toBe(false);

    const crossTenantVerify = await request(`/api/v1/secrets/${managed.payload.id}/verify`, {
      method: 'POST',
      organizationId: 'org-default',
      body: {},
    });
    expect(crossTenantVerify.response.status).toBe(404);

    const primaryAudit = await request('/api/v1/audit-events', { organizationId: 'org-default' });
    expect(primaryAudit.payload.items.some((event) => event.target.id === managed.payload.id)).toBe(false);
  });

  it('refuses an undersized production command-signing key', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSigningKey = process.env.SENSOR_COMMAND_SIGNING_KEY;
    try {
      process.env.NODE_ENV = 'production';
      process.env.SENSOR_COMMAND_SIGNING_KEY = 'too-short';
      expect(() => assertSensorSecurityConfiguration()).toThrow(/at least 32 bytes/);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      process.env.SENSOR_COMMAND_SIGNING_KEY = previousSigningKey;
    }
  });

  it('enrolls, reports health, executes a signed command, and creates an incident', async () => {
    const sensorId = `sen-integration-${crypto.randomUUID().slice(0, 8)}`;
    const enrollmentResponse = await request('/api/v1/sensor-enrollment-tokens', {
      method: 'POST',
      body: { label: 'Integration test sensor', ttlMinutes: 10 },
    });
    expect(enrollmentResponse.response.status).toBe(201);

    const enrollment = await request('/api/v1/sensors/enroll', {
      method: 'POST',
      body: {
        enrollmentToken: enrollmentResponse.payload.token,
        sensorId,
        name: 'Integration test sensor',
        version: '0.1.0-test',
        platform: 'test',
        capabilities: ['http', 'ssh'],
      },
    });
    expect(enrollment.response.status).toBe(201);
    expect(enrollment.payload.accessToken).toBeTruthy();
    expect(enrollment.payload.sensor).not.toHaveProperty('accessTokenHash');

    const accessToken = enrollment.payload.accessToken;
    const heartbeat = await request(`/api/v1/sensors/${sensorId}/heartbeat`, {
      method: 'POST',
      token: accessToken,
      body: { health: 98, latency: 12, version: '0.1.0-test', decoys: [] },
    });
    expect(heartbeat.response.status).toBe(200);
    expect(heartbeat.payload.sensor.health).toBe(98);

    const queued = await request(`/api/v1/sensors/${sensorId}/commands`, {
      method: 'POST',
      body: {
        type: 'deploy_decoy',
        payload: { id: 'decoy-http-test', name: 'Finance portal', protocol: 'http', listen: '127.0.0.1:0' },
      },
    });
    expect(queued.response.status).toBe(201);
    expect(verifySensorCommand(queued.payload)).toBe(true);

    const commands = await request(`/api/v1/sensors/${sensorId}/commands`, { token: accessToken });
    expect(commands.payload.items).toHaveLength(1);

    const acknowledgement = await request(`/api/v1/sensors/${sensorId}/commands/${queued.payload.id}/ack`, {
      method: 'POST',
      token: accessToken,
      body: { status: 'acknowledged', output: { address: '127.0.0.1:49152' } },
    });
    expect(acknowledgement.payload.status).toBe('acknowledged');

    const event = await request(`/api/v1/sensors/${sensorId}/events`, {
      method: 'POST',
      token: accessToken,
      body: {
        decoyId: 'decoy-http-test',
        decoyName: 'Finance portal',
        protocol: 'http',
        source: '192.0.2.44:51820',
        destination: '10.0.0.20:8080',
        metadata: { method: 'GET', path: '/admin' },
      },
    });
    expect(event.response.status).toBe(201);
    expect(event.payload.incident.confidence).toBe(99);
    expect(event.payload.incident.technique).toBe('T1190');
  });

  it('dead-letters exhausted commands and supports guided recovery actions', async () => {
    const sensorId = `sen-recovery-${crypto.randomUUID().slice(0, 8)}`;
    const tokenResponse = await request('/api/v1/sensor-enrollment-tokens', {
      method: 'POST',
      body: { label: 'Recovery test sensor' },
    });
    const enrollment = await request('/api/v1/sensors/enroll', {
      method: 'POST',
      body: { enrollmentToken: tokenResponse.payload.token, sensorId, name: 'Recovery test sensor' },
    });
    const accessToken = enrollment.payload.accessToken;
    const queued = await request(`/api/v1/sensors/${sensorId}/commands`, {
      method: 'POST',
      body: { type: 'snapshot', maxAttempts: 1 },
    });

    const delivery = await request(`/api/v1/sensors/${sensorId}/commands`, { token: accessToken });
    expect(delivery.payload.items[0]).toMatchObject({ id: queued.payload.id, attempts: 1, status: 'dispatched' });
    const failed = await request(`/api/v1/sensors/${sensorId}/commands/${queued.payload.id}/ack`, {
      method: 'POST',
      token: accessToken,
      body: { status: 'failed', error: 'simulated sensor failure' },
    });
    expect(failed.payload).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'attempt_limit' });

    const deadLetters = await request('/api/v1/sensor-commands?status=dead_lettered');
    expect(deadLetters.payload.items.some((command) => command.id === queued.payload.id)).toBe(true);
    const retried = await request(`/api/v1/sensor-commands/${queued.payload.id}/retry`, { method: 'POST' });
    expect(retried.response.status).toBe(201);
    expect(retried.payload.id).not.toBe(queued.payload.id);

    const retryDelivery = await request(`/api/v1/sensors/${sensorId}/commands`, { token: accessToken });
    expect(retryDelivery.payload.items[0].id).toBe(retried.payload.id);
    await request(`/api/v1/sensors/${sensorId}/commands/${retried.payload.id}/ack`, {
      method: 'POST',
      token: accessToken,
      body: { status: 'failed', error: 'simulated repeat failure' },
    });
    const dismissed = await request(`/api/v1/sensor-commands/${retried.payload.id}/dismiss`, { method: 'POST' });
    expect(dismissed.payload.status).toBe('dismissed');
  });

  it('rejects reuse of an enrollment token and unauthenticated sensor requests', async () => {
    const enrollmentResponse = await request('/api/v1/sensor-enrollment-tokens', { method: 'POST', body: { label: 'One time' } });
    const body = { enrollmentToken: enrollmentResponse.payload.token, name: 'First sensor' };
    expect((await request('/api/v1/sensors/enroll', { method: 'POST', body })).response.status).toBe(201);
    expect((await request('/api/v1/sensors/enroll', { method: 'POST', body })).response.status).toBe(401);
    expect((await request('/api/v1/sensors/sen-integration-test/commands')).response.status).toBe(401);
  });
});
