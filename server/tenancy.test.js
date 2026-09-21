// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStore, PostgresStore } from './store.js';
import { TenancyController, canAccessOrganization, normalizeOrganizationIds } from './tenancy.js';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-tenancy-'));
  temporaryDirectories.push(directory);
  return new JsonStore(directory);
}

describe('organization tenancy boundaries', () => {
  it('normalizes identity memberships and recognizes platform-wide administrators', () => {
    expect(normalizeOrganizationIds('org-default,org-managed-lab')).toEqual(['org-default', 'org-managed-lab']);
    expect(canAccessOrganization({ role: 'analyst', organizationIds: ['org-default'] }, 'org-managed-lab')).toBe(false);
    expect(canAccessOrganization({ role: 'platform_admin', organizationIds: [] }, 'org-managed-lab')).toBe(true);
  });

  it('enforces tenant filters for reads, updates, and conflicting record IDs', async () => {
    const store = createStore();
    const primary = { organizationId: 'org-default' };
    const managed = { organizationId: 'org-managed-lab' };
    await store.add('secrets', { id: 'sec-boundary', name: 'Primary secret' }, primary);

    expect(await store.read('secrets', primary)).toEqual([expect.objectContaining({ name: 'Primary secret' })]);
    expect(await store.read('secrets', managed)).toEqual([]);
    expect(await store.update('secrets', 'sec-boundary', { name: 'Cross-tenant update' }, managed)).toBeNull();
    await expect(store.add('secrets', { id: 'sec-boundary', name: 'Conflicting secret' }, managed)).rejects.toThrow(/another organization/);
  });

  it('rejects an organization header outside the identity membership', async () => {
    const store = createStore();
    const controller = new TenancyController(store);
    const app = express();
    app.use((request, _response, next) => {
      request.user = { id: 'analyst-1', role: 'analyst', organizationIds: ['org-default'] };
      next();
    });
    app.use(controller.middleware());
    app.get('/api/v1/test', (request, response) => response.json({ organizationId: request.organization.id }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      expect((await fetch(`${origin}/api/v1/test`)).status).toBe(200);
      const denied = await fetch(`${origin}/api/v1/test`, { headers: { 'X-AIDecepticon-Organization': 'org-managed-lab' } });
      expect(denied.status).toBe(403);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.skipIf(!process.env.DATABASE_URL)('prevents PostgreSQL records from moving between organizations', async () => {
    const store = new PostgresStore(process.env.DATABASE_URL, { sslMode: process.env.DATABASE_SSL });
    await store.init();
    const id = `tenant-guard-${Date.now()}`;
    await store.add('secrets', { id, name: 'Guarded' }, { organizationId: 'org-default' });
    await expect(store.pool.query(
      "UPDATE control_plane_records SET payload = payload || '{\"organizationId\":\"org-managed-lab\"}'::jsonb WHERE resource_type = 'secrets' AND record_id = $1",
      [id],
    )).rejects.toThrow(/cannot move between organizations/);
    await store.close();
  });
});
