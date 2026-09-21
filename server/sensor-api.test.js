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

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    expect(health.payload.infrastructure.scheduler).toMatchObject({ healthy: true, mode: 'scheduled' });
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
