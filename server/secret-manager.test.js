// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { SecretManager, publicSecret } from './secret-manager.js';

const localEnvironment = {
  NODE_ENV: 'test',
  SECRET_PROVIDER: 'local',
  SECRET_LOCAL_KEY_ID: 'current',
  SECRET_LOCAL_KEYS: JSON.stringify({ current: Buffer.alloc(32, 7).toString('base64') }),
};

describe('encrypted secret providers', () => {
  it('encrypts local secrets with authenticated context and never exposes the envelope', async () => {
    const manager = new SecretManager(localEnvironment);
    const sealed = await manager.seal('sec-local', 'top-secret-value', 'integration');

    expect(JSON.stringify(sealed.envelope)).not.toContain('top-secret-value');
    expect(sealed.envelope).toMatchObject({ provider: 'local', algorithm: 'AES-256-GCM', keyId: 'current' });
    expect(await manager.unseal('sec-local', sealed.envelope)).toBe('top-secret-value');
    await expect(manager.unseal('sec-other', sealed.envelope)).rejects.toThrow(/context does not match/);
    expect(publicSecret({ id: 'sec-local', envelope: sealed.envelope, fingerprint: sealed.fingerprint })).not.toHaveProperty('envelope');
  });

  it('supports AWS KMS with a cryptographically bound encryption context', async () => {
    const send = vi.fn(async (command) => {
      if (command instanceof EncryptCommand) return { CiphertextBlob: Buffer.from('kms-ciphertext'), KeyId: 'arn:aws:kms:us-east-1:123:key/test' };
      if (command instanceof DecryptCommand) return { Plaintext: Buffer.from('kms-secret') };
      throw new Error('Unexpected command');
    });
    const manager = new SecretManager({
      NODE_ENV: 'test',
      SECRET_PROVIDER: 'aws-kms',
      AWS_REGION: 'us-east-1',
      AWS_KMS_KEY_ID: 'alias/aidecepticon',
    }, { kmsClient: { send, destroy: vi.fn() } });

    const sealed = await manager.seal('sec-kms', 'kms-secret', 'cloud');
    expect(sealed.envelope).toMatchObject({ provider: 'aws-kms', algorithm: 'SYMMETRIC_DEFAULT' });
    expect(await manager.unseal('sec-kms', sealed.envelope)).toBe('kms-secret');
    expect(send.mock.calls[0][0].input.EncryptionContext).toEqual({ application: 'AIDecepticon', purpose: 'cloud', secretId: 'sec-kms' });
    expect(send.mock.calls[1][0].input.EncryptionContext).toEqual(send.mock.calls[0][0].input.EncryptionContext);
  });

  it('keeps historical local secrets decryptable across key rotation', async () => {
    const oldKey = Buffer.alloc(32, 1).toString('base64');
    const newKey = Buffer.alloc(32, 2).toString('base64');
    const oldManager = new SecretManager({ NODE_ENV: 'test', SECRET_PROVIDER: 'local', SECRET_LOCAL_KEY_ID: 'old', SECRET_LOCAL_KEYS: JSON.stringify({ old: oldKey }) });
    const historical = await oldManager.seal('sec-history', 'historical-value', 'integration');
    const rotatedManager = new SecretManager({ NODE_ENV: 'test', SECRET_PROVIDER: 'local', SECRET_LOCAL_KEY_ID: 'current', SECRET_LOCAL_KEYS: JSON.stringify({ current: newKey, old: oldKey }) });

    expect(await rotatedManager.unseal('sec-history', historical.envelope)).toBe('historical-value');
    expect((await rotatedManager.seal('sec-current', 'current-value', 'integration')).envelope.keyId).toBe('current');
  });

  it('supports Vault Transit without retaining plaintext', async () => {
    const previousFetch = global.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { ciphertext: 'vault:v1:encrypted' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { plaintext: Buffer.from('vault-secret').toString('base64') } }) });
    global.fetch = fetchMock;
    try {
      const manager = new SecretManager({
        NODE_ENV: 'test',
        SECRET_PROVIDER: 'vault-transit',
        VAULT_ADDR: 'http://127.0.0.1:8200',
        VAULT_TOKEN: 'test-token',
        VAULT_TRANSIT_KEY: 'control-plane',
      });
      const sealed = await manager.seal('sec-vault', 'vault-secret', 'identity');
      expect(sealed.envelope).toMatchObject({ provider: 'vault-transit', ciphertext: 'vault:v1:encrypted' });
      expect(await manager.unseal('sec-vault', sealed.envelope)).toBe('vault-secret');
      const encryptBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(Buffer.from(encryptBody.plaintext, 'base64').toString()).toBe('vault-secret');
      expect(encryptBody.associated_data).toBeTruthy();
    } finally {
      global.fetch = previousFetch;
    }
  });

  it('fails closed when production local keys are not configured', () => {
    expect(() => new SecretManager({ NODE_ENV: 'production', SECRET_PROVIDER: 'local' })).toThrow(/SECRET_LOCAL_KEYS is required/);
  });
});
