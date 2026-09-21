import crypto from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

const envelopeFormat = 'aidecepticon-secret/v1';
const maximumSecretBytes = 4_096;

function decodeKey(value) {
  const input = String(value || '').trim();
  const key = /^[a-f0-9]{64}$/i.test(input) ? Buffer.from(input, 'hex') : Buffer.from(input, 'base64');
  if (key.length !== 32) throw new Error('Local secret-encryption keys must decode to exactly 32 bytes');
  return key;
}

function parseKeyring(environment) {
  const configured = environment.SECRET_LOCAL_KEYS;
  if (!configured) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('SECRET_LOCAL_KEYS is required when SECRET_PROVIDER=local in production');
    }
    return new Map([['development', crypto.createHash('sha256').update('aidecepticon-development-secret-key').digest()]]);
  }
  let parsed;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error('SECRET_LOCAL_KEYS must be a JSON object of key IDs to base64 or hex-encoded 32-byte keys');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error('SECRET_LOCAL_KEYS must contain at least one key');
  }
  return new Map(Object.entries(parsed).map(([id, value]) => {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) throw new Error(`Invalid local secret key ID ${id}`);
    return [id, decodeKey(value)];
  }));
}

function contextFor(secretId, purpose) {
  return {
    application: 'AIDecepticon',
    purpose: String(purpose || 'control-plane-secret').slice(0, 100),
    secretId: String(secretId),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function envelopeFingerprint(envelope) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(envelope))).digest('hex').slice(0, 16);
}

function aadFor(context) {
  return Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)))));
}

function assertPlaintext(value) {
  const plaintext = Buffer.from(String(value || ''), 'utf8');
  if (plaintext.length === 0) throw new Error('Secret value is required');
  if (plaintext.length > maximumSecretBytes) throw new Error(`Secret values cannot exceed ${maximumSecretBytes} bytes`);
  return plaintext;
}

class LocalSecretProvider {
  constructor(environment) {
    this.name = 'local';
    this.keyring = parseKeyring(environment);
    this.activeKeyId = environment.SECRET_LOCAL_KEY_ID || this.keyring.keys().next().value;
    if (!this.keyring.has(this.activeKeyId)) throw new Error(`SECRET_LOCAL_KEY_ID ${this.activeKeyId} is not present in SECRET_LOCAL_KEYS`);
  }

  async encrypt(plaintext, context) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keyring.get(this.activeKeyId), iv, { authTagLength: 16 });
    cipher.setAAD(aadFor(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      format: envelopeFormat,
      provider: this.name,
      keyId: this.activeKeyId,
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      context,
    };
  }

  async decrypt(envelope) {
    const key = this.keyring.get(envelope.keyId);
    if (!key) throw new Error(`Local secret key ${envelope.keyId} is unavailable`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aadFor(envelope.context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  }

  health() {
    return { healthy: true, mode: this.name, keyId: this.activeKeyId };
  }
}

class VaultTransitSecretProvider {
  constructor(environment) {
    this.name = 'vault-transit';
    if (!environment.VAULT_ADDR) throw new Error('VAULT_ADDR is required when SECRET_PROVIDER=vault-transit');
    try {
      this.address = new URL(environment.VAULT_ADDR);
    } catch {
      throw new Error('VAULT_ADDR must be a valid absolute URL');
    }
    this.token = environment.VAULT_TOKEN || '';
    this.namespace = environment.VAULT_NAMESPACE || '';
    this.mount = environment.VAULT_TRANSIT_MOUNT || 'transit';
    this.keyName = environment.VAULT_TRANSIT_KEY || 'aidecepticon';
    if (this.address.protocol !== 'https:' && environment.NODE_ENV === 'production') {
      throw new Error('VAULT_ADDR must use HTTPS in production');
    }
    if (!this.token) throw new Error('VAULT_TOKEN is required when SECRET_PROVIDER=vault-transit');
  }

  async request(operation, body) {
    const endpoint = new URL(`/v1/${encodeURIComponent(this.mount)}/${operation}/${encodeURIComponent(this.keyName)}`, this.address);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Token': this.token,
        ...(this.namespace ? { 'X-Vault-Namespace': this.namespace } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Vault Transit ${operation} failed with status ${response.status}`);
    return response.json();
  }

  async encrypt(plaintext, context) {
    const result = await this.request('encrypt', {
      plaintext: plaintext.toString('base64'),
      associated_data: aadFor(context).toString('base64'),
    });
    if (!result.data?.ciphertext) throw new Error('Vault Transit response did not contain ciphertext');
    return {
      format: envelopeFormat,
      provider: this.name,
      keyId: this.keyName,
      algorithm: 'vault-transit',
      ciphertext: result.data.ciphertext,
      context,
    };
  }

  async decrypt(envelope) {
    const result = await this.request('decrypt', {
      ciphertext: envelope.ciphertext,
      associated_data: aadFor(envelope.context).toString('base64'),
    });
    if (!result.data?.plaintext) throw new Error('Vault Transit response did not contain plaintext');
    return Buffer.from(result.data.plaintext, 'base64');
  }

  health() {
    return { healthy: true, mode: this.name, keyId: this.keyName, endpoint: this.address.origin };
  }
}

class AwsKmsSecretProvider {
  constructor(environment, options = {}) {
    this.name = 'aws-kms';
    this.keyId = environment.AWS_KMS_KEY_ID || '';
    if (!this.keyId) throw new Error('AWS_KMS_KEY_ID is required when SECRET_PROVIDER=aws-kms');
    this.region = environment.AWS_REGION || environment.AWS_DEFAULT_REGION || '';
    if (!this.region) throw new Error('AWS_REGION is required when SECRET_PROVIDER=aws-kms');
    this.client = options.kmsClient || new KMSClient({
      region: this.region,
      ...(environment.AWS_KMS_ENDPOINT ? { endpoint: environment.AWS_KMS_ENDPOINT } : {}),
    });
  }

  async encrypt(plaintext, context) {
    const result = await this.client.send(new EncryptCommand({
      KeyId: this.keyId,
      Plaintext: plaintext,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: context,
    }));
    if (!result.CiphertextBlob) throw new Error('AWS KMS response did not contain ciphertext');
    return {
      format: envelopeFormat,
      provider: this.name,
      keyId: result.KeyId || this.keyId,
      algorithm: 'SYMMETRIC_DEFAULT',
      ciphertext: Buffer.from(result.CiphertextBlob).toString('base64'),
      context,
    };
  }

  async decrypt(envelope) {
    const result = await this.client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(envelope.ciphertext, 'base64'),
      KeyId: envelope.keyId,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: envelope.context,
    }));
    if (!result.Plaintext) throw new Error('AWS KMS response did not contain plaintext');
    return Buffer.from(result.Plaintext);
  }

  health() {
    return { healthy: true, mode: this.name, keyId: this.keyId, region: this.region };
  }

  async close() {
    this.client.destroy?.();
  }
}

export class SecretManager {
  constructor(environment = process.env, options = {}) {
    this.environment = environment;
    this.mode = String(environment.SECRET_PROVIDER || 'local').toLowerCase();
    if (this.mode === 'local') this.provider = new LocalSecretProvider(environment);
    else if (this.mode === 'vault-transit') this.provider = new VaultTransitSecretProvider(environment);
    else if (this.mode === 'aws-kms') this.provider = new AwsKmsSecretProvider(environment, options);
    else throw new Error('SECRET_PROVIDER must be local, vault-transit, or aws-kms');
  }

  async seal(secretId, value, purpose) {
    const plaintext = assertPlaintext(value);
    const context = contextFor(secretId, purpose);
    const envelope = await this.provider.encrypt(plaintext, context);
    return {
      envelope,
      fingerprint: envelopeFingerprint(envelope),
    };
  }

  async unseal(secretId, envelope) {
    if (!envelope || envelope.format !== envelopeFormat || envelope.provider !== this.mode) {
      throw new Error(`Secret ${secretId} was encrypted by an unavailable or unsupported provider`);
    }
    if (envelope.context?.secretId !== secretId) throw new Error('Encrypted secret context does not match its record');
    return (await this.provider.decrypt(envelope)).toString('utf8');
  }

  async verify(secretId, envelope, fingerprint) {
    await this.unseal(secretId, envelope);
    return envelopeFingerprint(envelope) === fingerprint;
  }

  health() {
    return this.provider.health();
  }

  async close() {
    await this.provider.close?.();
  }
}

export function createSecretManager(environment = process.env, options = {}) {
  return new SecretManager(environment, options);
}

export function publicSecret(record) {
  if (!record) return record;
  const { envelope: _envelope, ...metadata } = record;
  return metadata;
}
