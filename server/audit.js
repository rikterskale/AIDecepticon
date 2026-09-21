import crypto from 'node:crypto';

const genesisHash = '0'.repeat(64);
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const sensitiveKey = /(^value$|secret|token|password|credential|assertion|authorization|api.?key|private.?key|certificate|saml.?response|relay.?state)/i;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function decodeAuditKey(value) {
  const input = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(input)) return Buffer.from(input, 'hex');
  if (/^[a-zA-Z0-9+/]+={0,2}$/.test(input) && input.length % 4 === 0) {
    const decoded = Buffer.from(input, 'base64');
    if (decoded.length >= 32) return decoded;
  }
  const raw = Buffer.from(input);
  if (raw.length < 32) throw new Error('Audit signing keys must contain at least 32 bytes');
  return raw;
}

function parseKeyring(environment) {
  if (environment.AUDIT_SIGNING_KEYS) {
    let parsed;
    try {
      parsed = JSON.parse(environment.AUDIT_SIGNING_KEYS);
    } catch {
      throw new Error('AUDIT_SIGNING_KEYS must be a JSON object of key IDs to signing keys');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
      throw new Error('AUDIT_SIGNING_KEYS must contain at least one key');
    }
    return new Map(Object.entries(parsed).map(([id, value]) => {
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) throw new Error(`Invalid audit signing key ID ${id}`);
      return [id, decodeAuditKey(value)];
    }));
  }
  if (environment.AUDIT_SIGNING_KEY) return new Map([['primary', decodeAuditKey(environment.AUDIT_SIGNING_KEY)]]);
  if (environment.NODE_ENV === 'production') throw new Error('AUDIT_SIGNING_KEYS is required in production');
  return new Map([['development', crypto.createHash('sha256').update('aidecepticon-development-audit-key').digest()]]);
}

function redact(value, depth = 0) {
  if (depth > 5) return '[DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : redact(child, depth + 1),
    ]));
  }
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

function actionFor(request) {
  const path = request.path;
  if (path === '/api/v1/auth/api-key') return 'authentication.api_key_sign_in';
  if (path.includes('/auth/oidc/callback')) return 'authentication.oidc_callback';
  if (path.includes('/auth/saml/callback')) return 'authentication.saml_callback';
  if (path === '/api/v1/auth/logout') return 'authentication.logout';
  if (path === '/api/v1/deployments') return 'deception.deployment_create';
  if (/^\/api\/v1\/incidents\//.test(path)) return 'incident.update';
  if (path === '/api/v1/tokens') return 'deception.token_create';
  if (path === '/api/v1/sensor-enrollment-tokens') return 'sensor.enrollment_token_create';
  if (path === '/api/v1/sensors/enroll') return 'sensor.enroll';
  if (/\/sensor-commands\/[^/]+\/retry$/.test(path)) return 'sensor.command_retry';
  if (/\/sensor-commands\/[^/]+\/dismiss$/.test(path)) return 'sensor.command_dismiss';
  if (/\/sensors\/[^/]+\/commands$/.test(path)) return 'sensor.command_create';
  if (path === '/api/v1/secrets') return 'secret.create';
  if (/\/secrets\/[^/]+\/rotate$/.test(path)) return 'secret.rotate';
  if (/\/secrets\/[^/]+\/verify$/.test(path)) return 'secret.verify';
  return `http.${request.method.toLowerCase()}`;
}

function shouldAudit(request) {
  if (!unsafeMethods.has(request.method) || !request.path.startsWith('/api/v1/')) return false;
  if (/\/sensors\/[^/]+\/(heartbeat|events)$/.test(request.path)) return false;
  if (/\/sensors\/[^/]+\/commands\/[^/]+\/ack$/.test(request.path)) return false;
  return true;
}

function actorFor(request) {
  const actor = request.user;
  if (actor) {
    return {
      id: actor.id,
      displayName: actor.displayName,
      role: actor.role,
      provider: actor.provider,
      mfa: Boolean(actor.mfa),
    };
  }
  if (request.sensor) return { id: request.sensor.id, displayName: request.sensor.name, role: 'sensor', provider: 'sensor', mfa: false };
  return { id: 'anonymous', displayName: 'Unauthenticated request', role: 'anonymous', provider: 'none', mfa: false };
}

export class AuditTrail {
  constructor(store, environment = process.env) {
    this.store = store;
    this.keyring = parseKeyring(environment);
    this.activeKeyId = environment.AUDIT_SIGNING_KEY_ID || this.keyring.keys().next().value;
    if (!this.keyring.has(this.activeKeyId)) throw new Error(`AUDIT_SIGNING_KEY_ID ${this.activeKeyId} is not present in AUDIT_SIGNING_KEYS`);
    this.pending = Promise.resolve();
  }

  sign(event, key = this.keyring.get(event.signingKeyId)) {
    if (!key) return null;
    const { hash: _hash, ...signed } = event;
    return crypto.createHmac('sha256', key).update(canonicalJson(signed)).digest('hex');
  }

  append(input) {
    const operation = () => this.store.appendAudit((previous) => {
      const event = {
        schemaVersion: 1,
        id: input.id || `aud-${crypto.randomUUID()}`,
        occurredAt: input.occurredAt || new Date().toISOString(),
        actor: input.actor,
        action: input.action,
        target: input.target,
        outcome: input.outcome,
        request: input.request,
        details: input.details || {},
        previousHash: previous?.hash || genesisHash,
        signingKeyId: this.activeKeyId,
      };
      event.hash = this.sign(event);
      return event;
    });
    this.pending = this.pending.then(operation, operation);
    return this.pending;
  }

  async flush() {
    await this.pending;
  }

  async list(limit = 100) {
    await this.flush();
    return this.store.readAudit(Math.min(Math.max(Number(limit) || 100, 1), 1_000));
  }

  async verify(limit = 10_000) {
    await this.flush();
    const events = [...await this.store.readAudit(limit)].reverse();
    let previousHash = events[0]?.previousHash || genesisHash;
    for (const event of events) {
      const expectedHash = this.sign(event);
      if (!expectedHash || event.previousHash !== previousHash || event.hash !== expectedHash) {
        return { valid: false, checked: events.length, failedEventId: event.id };
      }
      previousHash = event.hash;
    }
    return { valid: true, checked: events.length, headHash: events.at(-1)?.hash || genesisHash };
  }

  async health() {
    try {
      const verification = await this.verify();
      return { healthy: verification.valid, mode: 'hmac-sha256-chain', ...verification };
    } catch (error) {
      return { healthy: false, mode: 'hmac-sha256-chain', error: error.message };
    }
  }

  middleware() {
    return (request, response, next) => {
      if (!shouldAudit(request)) return next();
      const requestId = request.get('x-request-id') || crypto.randomUUID();
      response.set('X-Request-Id', requestId);
      response.once('finish', () => {
        const segments = request.path.split('/').filter(Boolean);
        const targetId = response.locals.auditTargetId || segments.at(-1);
        void this.append({
          actor: actorFor(request),
          action: response.locals.auditAction || actionFor(request),
          target: { type: response.locals.auditTargetType || segments.at(-2) || 'control-plane', id: String(targetId || '') },
          outcome: response.statusCode < 400 ? 'success' : (response.statusCode < 500 ? 'denied' : 'error'),
          request: {
            id: requestId,
            method: request.method,
            path: request.path,
            status: response.statusCode,
            sourceIp: request.ip,
            userAgent: String(request.get('user-agent') || '').slice(0, 300),
          },
          details: redact(request.body || {}),
        }).catch((error) => console.error(`Unable to append audit event: ${error.message}`));
      });
      next();
    };
  }
}

export function createAuditTrail(store, environment = process.env) {
  return new AuditTrail(store, environment);
}
