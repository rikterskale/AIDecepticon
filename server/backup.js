import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const archiveFormat = 'aidecepticon-backup/v1';
const snapshotFormat = 'aidecepticon-snapshot/v1';
const backupIdPattern = /^bkp-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const resourcePattern = /^[a-z][a-zA-Z0-9]*$/;

function backupError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function decodeKey(value) {
  const input = String(value || '').trim();
  let decoded;
  if (/^[a-f0-9]{64}$/i.test(input)) decoded = Buffer.from(input, 'hex');
  else if (/^[a-zA-Z0-9+/]+={0,2}$/.test(input) && input.length % 4 === 0) decoded = Buffer.from(input, 'base64');
  else decoded = Buffer.from(input);
  if (decoded.length !== 32) throw new Error('Backup encryption keys must contain exactly 32 bytes');
  return decoded;
}

function parseKeyring(environment) {
  if (environment.BACKUP_ENCRYPTION_KEYS) {
    let parsed;
    try {
      parsed = JSON.parse(environment.BACKUP_ENCRYPTION_KEYS);
    } catch {
      throw new Error('BACKUP_ENCRYPTION_KEYS must be a JSON object of key IDs to encryption keys');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !Object.keys(parsed).length) {
      throw new Error('BACKUP_ENCRYPTION_KEYS must contain at least one key');
    }
    return new Map(Object.entries(parsed).map(([id, value]) => {
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) throw new Error(`Invalid backup encryption key ID ${id}`);
      return [id, decodeKey(value)];
    }));
  }
  if (environment.BACKUP_ENCRYPTION_KEY) return new Map([['primary', decodeKey(environment.BACKUP_ENCRYPTION_KEY)]]);
  if (environment.NODE_ENV === 'production') throw new Error('BACKUP_ENCRYPTION_KEYS is required in production');
  return new Map([['development', crypto.createHash('sha256').update('aidecepticon-development-backup-key').digest()]]);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), minimum), maximum) : fallback;
}

function archiveAad(archive) {
  return Buffer.from(JSON.stringify({
    format: archive.format,
    id: archive.id,
    createdAt: archive.createdAt,
    keyId: archive.keyId,
    sourceMode: archive.sourceMode,
    reason: archive.reason,
    createdBy: archive.createdBy,
    resourceCounts: archive.resourceCounts,
    auditEventCount: archive.auditEventCount,
  }));
}

function backupId(now = new Date()) {
  return `bkp-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${crypto.randomBytes(4).toString('hex')}`;
}

function assertBackupId(id) {
  if (!backupIdPattern.test(String(id || ''))) throw backupError('Invalid backup ID', 400);
}

function publicArchive(archive, fileSize) {
  return {
    id: archive.id,
    createdAt: archive.createdAt,
    reason: archive.reason,
    createdBy: archive.createdBy,
    keyId: archive.keyId,
    sourceMode: archive.sourceMode,
    resourceCounts: archive.resourceCounts,
    auditEventCount: archive.auditEventCount,
    sizeBytes: fileSize,
  };
}

function validateArchiveHeader(archive, id) {
  const countsValid = archive?.resourceCounts
    && !Array.isArray(archive.resourceCounts)
    && typeof archive.resourceCounts === 'object'
    && Object.entries(archive.resourceCounts).every(([resource, count]) => resourcePattern.test(resource) && Number.isInteger(count) && count >= 0);
  const encryptionValid = archive?.encryption?.algorithm === 'aes-256-gcm'
    && archive.encryption.compression === 'gzip'
    && typeof archive.encryption.iv === 'string'
    && typeof archive.encryption.tag === 'string';
  if (archive?.format !== archiveFormat
    || archive.id !== id
    || typeof archive.createdAt !== 'string'
    || !Number.isFinite(Date.parse(archive.createdAt))
    || typeof archive.reason !== 'string'
    || typeof archive.createdBy !== 'string'
    || typeof archive.keyId !== 'string'
    || !['json', 'postgresql'].includes(archive.sourceMode)
    || !countsValid
    || !Number.isInteger(archive.auditEventCount)
    || archive.auditEventCount < 0
    || !encryptionValid
    || typeof archive.ciphertext !== 'string') {
    throw backupError('Backup archive metadata is invalid', 422);
  }
  return archive;
}

function validateSnapshotShape(snapshot) {
  if (!snapshot || snapshot.format !== snapshotFormat || !snapshot.resources || Array.isArray(snapshot.resources) || typeof snapshot.resources !== 'object') {
    throw new Error('Backup snapshot format is invalid');
  }
  if (!Array.isArray(snapshot.auditEvents)) throw new Error('Backup audit event collection is invalid');
  if (!Array.isArray(snapshot.resources.organizations) || snapshot.resources.organizations.length === 0) {
    throw new Error('Backup must contain at least one organization');
  }
  const organizationIds = new Set(snapshot.resources.organizations.map((organization) => organization.id));
  for (const [resource, items] of Object.entries(snapshot.resources)) {
    if (!resourcePattern.test(resource) || !Array.isArray(items)) throw new Error(`Backup resource ${resource} is invalid`);
    const ids = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) throw new Error(`Backup resource ${resource} contains an invalid record`);
      if (ids.has(item.id)) throw new Error(`Backup resource ${resource} contains duplicate record ${item.id}`);
      if (resource !== 'organizations' && item.organizationId && !organizationIds.has(item.organizationId)) {
        throw new Error(`Backup resource ${resource} references unknown organization ${item.organizationId}`);
      }
      ids.add(item.id);
    }
  }
  for (const event of snapshot.auditEvents) {
    if (!event || typeof event !== 'object' || typeof event.id !== 'string' || typeof event.hash !== 'string' || typeof event.previousHash !== 'string') {
      throw new Error('Backup contains an invalid audit event');
    }
  }
  return snapshot;
}

export class BackupService {
  constructor(store, auditTrail, environment = process.env) {
    this.store = store;
    this.auditTrail = auditTrail;
    this.keyring = parseKeyring(environment);
    this.activeKeyId = environment.BACKUP_ENCRYPTION_KEY_ID || this.keyring.keys().next().value;
    if (!this.keyring.has(this.activeKeyId)) throw new Error(`BACKUP_ENCRYPTION_KEY_ID ${this.activeKeyId} is not present in BACKUP_ENCRYPTION_KEYS`);
    this.directory = path.resolve(environment.BACKUP_DIR || path.join(environment.DATA_DIR || './runtime-data', 'backups'));
    this.retentionCount = boundedInteger(environment.BACKUP_RETENTION_COUNT, 14, 1, 10_000);
    this.scheduleIntervalHours = Number(environment.BACKUP_SCHEDULE_INTERVAL_HOURS || 0);
    if (!Number.isFinite(this.scheduleIntervalHours) || this.scheduleIntervalHours < 0) throw new Error('BACKUP_SCHEDULE_INTERVAL_HOURS must be zero or a positive number');
    this.maximumArchiveBytes = boundedInteger(environment.BACKUP_MAX_ARCHIVE_BYTES, 512 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024);
    this.maximumSnapshotBytes = boundedInteger(environment.BACKUP_MAX_SNAPSHOT_BYTES, 1024 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024);
    this.timer = null;
    this.lastBackup = null;
    this.lastError = null;
    this.nextRunAt = null;
    this.restoring = false;
    this.pending = Promise.resolve();
  }

  async init() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lastBackup = (await this.list())[0] || null;
    if (this.scheduleIntervalHours > 0) {
      const intervalMs = this.scheduleIntervalHours * 60 * 60 * 1000;
      this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      this.timer = setInterval(() => {
        void this.create({ reason: 'scheduled', createdBy: 'system:scheduler' })
          .then(() => { this.lastError = null; })
          .catch((error) => { this.lastError = error.message; })
          .finally(() => { this.nextRunAt = new Date(Date.now() + intervalMs).toISOString(); });
      }, intervalMs);
      this.timer.unref?.();
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    await this.pending;
  }

  exclusive(operation) {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    return result;
  }

  archivePath(id) {
    assertBackupId(id);
    return path.join(this.directory, `${id}.json`);
  }

  readArchive(id) {
    const filePath = this.archivePath(id);
    let content;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > this.maximumArchiveBytes) throw new Error('Backup archive exceeds the configured size limit');
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw backupError('Backup not found', 404);
      throw error;
    }
    let archive;
    try {
      archive = JSON.parse(content);
    } catch {
      throw backupError('Backup archive is not valid JSON', 422);
    }
    validateArchiveHeader(archive, id);
    return { archive, filePath, sizeBytes: Buffer.byteLength(content) };
  }

  async list() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const items = [];
    for (const filename of fs.readdirSync(this.directory).filter((name) => backupIdPattern.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))) {
      try {
        const id = filename.slice(0, -5);
        const { archive, sizeBytes } = this.readArchive(id);
        items.push(publicArchive(archive, sizeBytes));
      } catch {
        // Invalid files remain on disk for an operator to inspect and are never treated as restorable backups.
      }
    }
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create({ reason = 'manual', createdBy = 'system' } = {}) {
    return this.exclusive(() => this.createInternal({ reason, createdBy }));
  }

  async createInternal({ reason, createdBy }) {
    await this.auditTrail.flush();
    const exported = await this.store.exportSnapshot();
    const now = new Date();
    const id = backupId(now);
    const snapshot = {
      format: snapshotFormat,
      backupId: id,
      createdAt: now.toISOString(),
      sourceMode: this.store.mode,
      resources: exported.resources,
      auditEvents: exported.auditEvents,
    };
    validateSnapshotShape(snapshot);
    const archive = {
      format: archiveFormat,
      id,
      createdAt: snapshot.createdAt,
      reason: String(reason).slice(0, 40),
      createdBy: String(createdBy).slice(0, 200),
      keyId: this.activeKeyId,
      sourceMode: this.store.mode,
      resourceCounts: Object.fromEntries(Object.entries(snapshot.resources).map(([resource, items]) => [resource, items.length])),
      auditEventCount: snapshot.auditEvents.length,
      encryption: { algorithm: 'aes-256-gcm', compression: 'gzip' },
    };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keyring.get(this.activeKeyId), iv);
    cipher.setAAD(archiveAad(archive));
    const snapshotPayload = Buffer.from(JSON.stringify(snapshot));
    if (snapshotPayload.length > this.maximumSnapshotBytes) throw new Error('Backup snapshot exceeds the configured size limit');
    const compressed = await gzipAsync(snapshotPayload, { level: 9 });
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    archive.encryption.iv = iv.toString('base64');
    archive.encryption.tag = cipher.getAuthTag().toString('base64');
    archive.ciphertext = ciphertext.toString('base64');
    const serialized = JSON.stringify(archive, null, 2);
    if (Buffer.byteLength(serialized) > this.maximumArchiveBytes) throw new Error('Backup archive exceeds the configured size limit');
    const filePath = this.archivePath(id);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporaryPath, filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    const result = publicArchive(archive, Buffer.byteLength(serialized));
    this.lastBackup = result;
    this.lastError = null;
    await this.prune();
    return result;
  }

  async decrypt(id) {
    const { archive } = this.readArchive(id);
    const key = this.keyring.get(archive.keyId);
    if (!key) throw backupError(`Backup encryption key ${archive.keyId} is unavailable`, 422);
    if (archive.encryption?.algorithm !== 'aes-256-gcm' || archive.encryption?.compression !== 'gzip') {
      throw backupError('Backup encryption metadata is unsupported', 422);
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(archive.encryption.iv, 'base64'));
      decipher.setAAD(archiveAad(archive));
      decipher.setAuthTag(Buffer.from(archive.encryption.tag, 'base64'));
      const compressed = Buffer.concat([decipher.update(Buffer.from(archive.ciphertext, 'base64')), decipher.final()]);
      const snapshot = JSON.parse((await gunzipAsync(compressed, { maxOutputLength: this.maximumSnapshotBytes })).toString('utf8'));
      if (snapshot.backupId !== archive.id || snapshot.createdAt !== archive.createdAt || snapshot.sourceMode !== archive.sourceMode) {
        throw new Error('Backup snapshot metadata does not match its archive');
      }
      return { archive, snapshot: validateSnapshotShape(snapshot) };
    } catch (error) {
      throw backupError(`Backup authentication or decoding failed: ${error.message}`, 422);
    }
  }

  async validate(id) {
    return this.exclusive(() => this.validateInternal(id));
  }

  async validateInternal(id) {
    const { archive, snapshot } = await this.decrypt(id);
    const verification = this.auditTrail.verifyEvents(snapshot.auditEvents);
    if (!verification.valid) throw new Error(`Backup audit chain failed at event ${verification.failedEventId}`);
    const secretKeyIds = [...new Set((snapshot.resources.secrets || []).map((secret) => secret.envelope?.keyId || secret.keyId).filter(Boolean))].sort();
    const auditSigningKeyIds = [...new Set(snapshot.auditEvents.map((event) => event.signingKeyId).filter(Boolean))].sort();
    return {
      ...publicArchive(archive, this.readArchive(id).sizeBytes),
      valid: true,
      verification,
      secretKeyIds,
      auditSigningKeyIds,
    };
  }

  async restore(id, { createdBy = 'system' } = {}) {
    if (this.restoring) throw backupError('A full-system restore is already in progress', 409);
    this.restoring = true;
    return this.exclusive(async () => {
      try {
        const validation = await this.validateInternal(id);
        const { snapshot } = await this.decrypt(id);
        const checkpoint = await this.createInternal({ reason: 'pre-restore', createdBy });
        await this.store.importSnapshot(snapshot);
        return { restored: validation, checkpoint };
      } finally {
        this.restoring = false;
      }
    });
  }

  async prune() {
    const items = await this.list();
    for (const backup of items.slice(this.retentionCount)) fs.rmSync(this.archivePath(backup.id), { force: true });
  }

  downloadPath(id) {
    return this.readArchive(id).filePath;
  }

  health() {
    return {
      healthy: !this.lastError,
      mode: 'encrypted-full-state',
      enabled: true,
      scheduled: this.scheduleIntervalHours > 0,
      intervalHours: this.scheduleIntervalHours,
      retentionCount: this.retentionCount,
      restoring: this.restoring,
      lastBackupAt: this.lastBackup?.createdAt || null,
      nextRunAt: this.nextRunAt,
      error: this.lastError,
    };
  }
}

export function createBackupService(store, auditTrail, environment = process.env) {
  return new BackupService(store, auditTrail, environment);
}
