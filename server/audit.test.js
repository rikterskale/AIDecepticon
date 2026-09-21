// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditTrail } from './audit.js';
import { JsonStore, PostgresStore } from './store.js';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createTrail() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-audit-'));
  temporaryDirectories.push(directory);
  const store = new JsonStore(directory);
  const trail = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY: 'audit-test-key-with-at-least-32-bytes' });
  return { directory, store, trail };
}

describe('administrative audit trail', () => {
  it('fails closed without a production audit signing key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-audit-production-'));
    temporaryDirectories.push(directory);
    expect(() => new AuditTrail(new JsonStore(directory), { NODE_ENV: 'production' })).toThrow(/AUDIT_SIGNING_KEYS is required/);
  });

  it('builds and verifies an append-only HMAC chain', async () => {
    const { directory, trail } = createTrail();
    await trail.append({ actor: { id: 'admin' }, action: 'deployment.create', target: { type: 'deployment', id: 'dep-1' }, outcome: 'success', request: { id: 'req-1' } });
    await trail.append({ actor: { id: 'analyst' }, action: 'incident.update', target: { type: 'incident', id: 'INC-1' }, outcome: 'success', request: { id: 'req-2' } });

    const events = await trail.list();
    expect(events).toHaveLength(2);
    expect(events[0].previousHash).toBe(events[1].hash);
    expect(await trail.verify()).toMatchObject({ valid: true, checked: 2 });

    const lines = fs.readFileSync(path.join(directory, 'audit.ndjson'), 'utf8').trim().split(/\r?\n/);
    const tampered = { ...JSON.parse(lines[0]), action: 'deployment.delete' };
    fs.writeFileSync(path.join(directory, 'audit.ndjson'), `${JSON.stringify(tampered)}\n${lines[1]}\n`);
    expect(await trail.verify()).toMatchObject({ valid: false, failedEventId: tampered.id });
  });

  it('redacts secret material captured by the HTTP middleware', async () => {
    const { trail } = createTrail();
    const app = express();
    app.use(express.json());
    app.use(trail.middleware());
    app.use((request, _response, next) => {
      request.user = { id: 'admin', displayName: 'Admin', role: 'platform_admin', provider: 'test', mfa: true };
      next();
    });
    app.post('/api/v1/secrets', (_request, response) => response.status(201).json({ id: 'sec-1' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      await fetch(`http://127.0.0.1:${address.port}/api/v1/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SIEM token', value: 'must-never-appear', apiKey: 'also-secret', SAMLResponse: 'signed-identity-assertion' }),
      });
      await trail.flush();
      const event = (await trail.list())[0];
      expect(event.actor.id).toBe('admin');
      expect(event.details).toEqual({ name: 'SIEM token', value: '[REDACTED]', apiKey: '[REDACTED]', SAMLResponse: '[REDACTED]' });
      expect(JSON.stringify(event)).not.toContain('must-never-appear');
      expect(JSON.stringify(event)).not.toContain('also-secret');
      expect(JSON.stringify(event)).not.toContain('signed-identity-assertion');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('verifies historical events after audit signing-key rotation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-audit-rotation-'));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    const oldTrail = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY_ID: 'old', AUDIT_SIGNING_KEYS: JSON.stringify({ old: Buffer.alloc(32, 3).toString('base64') }) });
    await oldTrail.append({ actor: { id: 'admin' }, action: 'before.rotation', target: { type: 'test', id: 'old' }, outcome: 'success', request: { id: 'old' } });
    const rotatedTrail = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY_ID: 'current', AUDIT_SIGNING_KEYS: JSON.stringify({ current: Buffer.alloc(32, 4).toString('base64'), old: Buffer.alloc(32, 3).toString('base64') }) });
    await rotatedTrail.append({ actor: { id: 'admin' }, action: 'after.rotation', target: { type: 'test', id: 'new' }, outcome: 'success', request: { id: 'new' } });

    expect(await rotatedTrail.verify()).toMatchObject({ valid: true, checked: 2 });
    expect((await rotatedTrail.list())[0].signingKeyId).toBe('current');
  });

  it.skipIf(!process.env.DATABASE_URL)('enforces PostgreSQL audit immutability at the database layer', async () => {
    const store = new PostgresStore(process.env.DATABASE_URL, { sslMode: process.env.DATABASE_SSL });
    await store.init();
    const trail = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY: 'audit-test-key-with-at-least-32-bytes' });
    const event = await trail.append({ actor: { id: 'admin' }, action: 'test.append', target: { type: 'test', id: '1' }, outcome: 'success', request: { id: 'postgres-test' } });
    await expect(store.pool.query("UPDATE administrative_audit_events SET payload = payload || '{\"tampered\":true}'::jsonb WHERE event_id = $1", [event.id.replace(/^aud-/, '')])).rejects.toThrow(/append-only/);
    await store.close();
  });
});
