// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditTrail } from './audit.js';
import { BackupService } from './backup.js';
import { JsonStore, PostgresStore } from './store.js';

const { Pool } = pg;
const temporaryDirectories = [];
const services = [];
const testAuditKey = Buffer.alloc(32, 7).toString('base64');
const oldBackupKey = Buffer.alloc(32, 8).toString('base64');
const currentBackupKey = Buffer.alloc(32, 9).toString('base64');

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function jsonFixture(keyring = { current: currentBackupKey }, activeKeyId = 'current', overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-backup-'));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, 'data'));
  const audit = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY_ID: 'audit', AUDIT_SIGNING_KEYS: JSON.stringify({ audit: testAuditKey }) });
  const backup = new BackupService(store, audit, {
    NODE_ENV: 'test',
    DATA_DIR: path.join(root, 'data'),
    BACKUP_DIR: path.join(root, 'backups'),
    BACKUP_ENCRYPTION_KEY_ID: activeKeyId,
    BACKUP_ENCRYPTION_KEYS: JSON.stringify(keyring),
    BACKUP_RETENTION_COUNT: '5',
    ...overrides,
  });
  services.push(backup);
  return { root, store, audit, backup };
}

async function appendAudit(audit, action) {
  return audit.append({
    actor: { id: 'admin' },
    action,
    target: { type: 'test', id: action },
    outcome: 'success',
    request: { id: `request-${action}` },
  });
}

describe('encrypted backup and disaster recovery', () => {
  it('fails closed without a production backup encryption key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-backup-production-'));
    temporaryDirectories.push(root);
    const store = new JsonStore(root);
    const audit = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY: 'audit-test-key-with-at-least-32-bytes' });
    expect(() => new BackupService(store, audit, { NODE_ENV: 'production', DATA_DIR: root })).toThrow(/BACKUP_ENCRYPTION_KEYS is required/);
  });

  it('restores a full JSON snapshot and creates a pre-restore checkpoint', async () => {
    const { store, audit, backup } = jsonFixture();
    await backup.init();
    await appendAudit(audit, 'before.backup');
    const archived = await backup.create({ createdBy: 'admin' });
    await store.add('deployments', { id: 'dep-after-backup', name: 'temporary mutation', organizationId: 'org-default' });
    await appendAudit(audit, 'after.backup');

    const validation = await backup.validate(archived.id);
    expect(validation).toMatchObject({ valid: true, auditEventCount: 1, auditSigningKeyIds: ['audit'] });
    const restored = await backup.restore(archived.id, { createdBy: 'admin' });

    expect(restored.checkpoint.reason).toBe('pre-restore');
    expect((await store.read('deployments')).some((item) => item.id === 'dep-after-backup')).toBe(false);
    expect(await audit.verify()).toMatchObject({ valid: true, checked: 1 });
    expect((await backup.list()).map((item) => item.id)).toEqual(expect.arrayContaining([archived.id, restored.checkpoint.id]));
  });

  it('rejects ciphertext and authenticated metadata tampering', async () => {
    const { backup } = jsonFixture();
    await backup.init();
    const archived = await backup.create({ createdBy: 'admin' });
    const filePath = backup.downloadPath(archived.id);
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    payload.resourceCounts.deployments += 1;
    fs.writeFileSync(filePath, JSON.stringify(payload));
    await expect(backup.validate(archived.id)).rejects.toThrow(/authentication or decoding failed/);
  });

  it('validates historical archives after encryption-key rotation', async () => {
    const fixture = jsonFixture({ old: oldBackupKey }, 'old');
    await fixture.backup.init();
    const archived = await fixture.backup.create({ createdBy: 'admin' });
    await fixture.backup.close();
    const rotated = new BackupService(fixture.store, fixture.audit, {
      NODE_ENV: 'test',
      BACKUP_DIR: path.join(fixture.root, 'backups'),
      BACKUP_ENCRYPTION_KEY_ID: 'current',
      BACKUP_ENCRYPTION_KEYS: JSON.stringify({ current: currentBackupKey, old: oldBackupKey }),
    });
    services.push(rotated);
    await rotated.init();

    expect(await rotated.validate(archived.id)).toMatchObject({ valid: true, keyId: 'old' });
  });

  it('prunes encrypted archives beyond the configured retention count', async () => {
    const { backup } = jsonFixture(undefined, undefined, { BACKUP_RETENTION_COUNT: '2' });
    await backup.init();
    await backup.create({ createdBy: 'admin' });
    await backup.create({ createdBy: 'admin' });
    const newest = await backup.create({ createdBy: 'admin' });

    const retained = await backup.list();
    expect(retained).toHaveLength(2);
    expect(retained.some((item) => item.id === newest.id)).toBe(true);
  });

  it.skipIf(!process.env.DATABASE_URL)('round-trips PostgreSQL state in an isolated schema', async () => {
    const schema = `backup_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const isolatedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
      ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidecepticon-postgres-backup-'));
    temporaryDirectories.push(root);
    const store = new PostgresStore(process.env.DATABASE_URL, { pool: isolatedPool });
    try {
      await store.init();
      const audit = new AuditTrail(store, { NODE_ENV: 'test', AUDIT_SIGNING_KEY_ID: 'audit', AUDIT_SIGNING_KEYS: JSON.stringify({ audit: testAuditKey }) });
      const backup = new BackupService(store, audit, {
        NODE_ENV: 'test',
        BACKUP_DIR: path.join(root, 'backups'),
        BACKUP_ENCRYPTION_KEY_ID: 'current',
        BACKUP_ENCRYPTION_KEYS: JSON.stringify({ current: currentBackupKey }),
      });
      services.push(backup);
      await backup.init();
      await appendAudit(audit, 'postgres.before');
      const archived = await backup.create({ createdBy: 'admin' });
      await store.add('deployments', { id: 'dep-postgres-after', name: 'temporary mutation', organizationId: 'org-default' });

      await backup.restore(archived.id, { createdBy: 'admin' });
      expect((await store.read('deployments')).some((item) => item.id === 'dep-postgres-after')).toBe(false);
      expect(await audit.verify()).toMatchObject({ valid: true, checked: 1 });
      await expect(store.pool.query('DELETE FROM administrative_audit_events')).rejects.toThrow(/append-only/);
    } finally {
      await store.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
