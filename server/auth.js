import crypto from 'node:crypto';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient } from 'redis';
import * as oidc from 'openid-client';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';

export const rolePermissions = Object.freeze({
  platform_admin: ['*'],
  deception_engineer: ['platform:read', 'deception:read', 'deception:write', 'sensor:read', 'sensor:write', 'token:write', 'incident:read'],
  analyst: ['platform:read', 'deception:read', 'sensor:read', 'incident:read', 'incident:write'],
  auditor: ['platform:read', 'deception:read', 'sensor:read', 'incident:read', 'audit:read'],
  service: [],
});

const allowedModes = new Set(['disabled', 'oidc', 'saml']);
const rolePriority = ['platform_admin', 'deception_engineer', 'analyst', 'auditor', 'service'];
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return value === undefined || value === null ? [] : [String(value)];
}

function boundedNumber(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, minimum) : fallback;
}

function normalizePem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function parseRoleMappings(value) {
  if (!value) return {};
  let mappings;
  try {
    mappings = JSON.parse(value);
  } catch {
    throw new Error('AUTH_ROLE_MAPPINGS must be valid JSON');
  }
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw new Error('AUTH_ROLE_MAPPINGS must be a JSON object keyed by role');
  }
  for (const [role, groups] of Object.entries(mappings)) {
    if (!rolePermissions[role]) throw new Error(`AUTH_ROLE_MAPPINGS contains unsupported role ${role}`);
    if (!Array.isArray(groups) || groups.some((group) => typeof group !== 'string')) {
      throw new Error(`AUTH_ROLE_MAPPINGS.${role} must be an array of group names`);
    }
  }
  return mappings;
}

export function safeReturnTo(value) {
  const candidate = typeof value === 'string' ? value : '/';
  return candidate.startsWith('/') && !candidate.startsWith('//') && !candidate.includes('\\') ? candidate : '/';
}

export function hasPermission(user, permission) {
  if (!user) return false;
  const permissions = Array.isArray(user.permissions) ? user.permissions : rolePermissions[user.role] || [];
  return permissions.includes('*') || permissions.includes(permission);
}

export function buildPrincipal(claims, options = {}) {
  const groups = normalizeList(claims[options.groupsClaim || 'groups']);
  const directRoles = normalizeList(claims[options.roleClaim || 'aidecepticon_role']);
  let role = rolePriority.find((candidate) => directRoles.includes(candidate));
  if (!role) {
    for (const candidate of rolePriority) {
      const mappedGroups = options.roleMappings?.[candidate] || [];
      if (mappedGroups.some((group) => groups.includes(group))) {
        role = candidate;
        break;
      }
    }
  }
  role ||= rolePermissions[options.defaultRole] ? options.defaultRole : 'auditor';
  const id = String(claims.sub || claims.nameID || claims.email || claims.mail || 'unknown');
  const email = String(claims.email || claims.mail || claims['urn:oid:0.9.2342.19200300.100.1.3'] || '');
  const displayName = String(claims.name || claims.displayName || claims.cn || email || id);
  return {
    id,
    email,
    displayName,
    role,
    groups,
    provider: options.provider || 'development',
    mfa: Boolean(options.mfa),
  };
}

class RedisSamlCache {
  constructor(client, prefix, ttlSeconds) {
    this.client = client;
    this.prefix = prefix;
    this.ttlSeconds = ttlSeconds;
  }

  key(id) {
    return `${this.prefix}${id}`;
  }

  async saveAsync(id, value) {
    const createdAt = Date.now();
    await this.client.set(this.key(id), JSON.stringify({ value, createdAt }), { EX: this.ttlSeconds });
    return { value, createdAt };
  }

  async getAsync(id) {
    const record = await this.client.get(this.key(id));
    if (!record) return null;
    return JSON.parse(record).value;
  }

  async removeAsync(id) {
    if (!id) return null;
    const key = this.key(id);
    const record = await this.client.get(key);
    await this.client.del(key);
    return record ? JSON.parse(record).value : null;
  }
}

function regenerateSession(request) {
  return new Promise((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
}

function saveSession(request) {
  return new Promise((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
}

function destroySession(request) {
  return new Promise((resolve, reject) => request.session.destroy((error) => error ? reject(error) : resolve()));
}

export class AuthController {
  constructor(environment = process.env, options = {}) {
    this.environment = environment;
    this.logger = options.logger || console;
    this.mode = String(environment.AUTH_MODE || 'disabled').toLowerCase();
    if (!allowedModes.has(this.mode)) throw new Error('AUTH_MODE must be disabled, oidc, or saml');
    this.enabled = this.mode !== 'disabled';
    this.publicBaseUrl = new URL(environment.PUBLIC_BASE_URL || `http://localhost:${environment.PORT || 8787}`);
    this.allowedOrigins = new Set([
      this.publicBaseUrl.origin,
      ...normalizeList(environment.CORS_ORIGIN).map((origin) => new URL(origin).origin),
    ]);
    this.providerLabel = environment.AUTH_PROVIDER_LABEL || (this.mode === 'saml' ? 'Enterprise SAML' : 'Enterprise SSO');
    this.defaultRole = environment.AUTH_DEFAULT_ROLE || 'auditor';
    this.groupsClaim = environment.AUTH_GROUPS_CLAIM || 'groups';
    this.roleClaim = environment.AUTH_ROLE_CLAIM || 'aidecepticon_role';
    this.roleMappings = parseRoleMappings(environment.AUTH_ROLE_MAPPINGS);
    this.requireMfa = String(environment.AUTH_REQUIRE_MFA || 'false').toLowerCase() === 'true';
    this.controlPlaneApiKey = environment.CONTROL_PLANE_API_KEY || '';
    this.apiKeyPermissions = normalizeList(environment.CONTROL_PLANE_API_PERMISSIONS || '*');
    this.sessionEnabled = this.enabled || Boolean(this.controlPlaneApiKey);
    this.redisClient = null;
    this.oidcConfiguration = null;
    this.saml = null;
    this.validateConfiguration();
    this.developmentUser = buildPrincipal({
      sub: 'local-development-admin',
      name: environment.AUTH_DEVELOPMENT_USER || 'Local administrator',
      email: environment.AUTH_DEVELOPMENT_EMAIL || 'local@aidecepticon.invalid',
      aidecepticon_role: 'platform_admin',
    }, { provider: 'development', defaultRole: 'platform_admin', mfa: true });
    this.sessionMiddleware = this.sessionEnabled ? this.createSessionMiddleware() : null;
  }

  validateConfiguration() {
    if (!rolePermissions[this.defaultRole]) throw new Error(`AUTH_DEFAULT_ROLE must be one of ${Object.keys(rolePermissions).join(', ')}`);
    if (!this.sessionEnabled) {
      if (this.environment.NODE_ENV === 'production' && !isLoopbackHostname(this.publicBaseUrl.hostname)) {
        throw new Error('AUTH_MODE=disabled is only allowed for loopback production URLs; configure OIDC, SAML, or a control-plane API key');
      }
      return;
    }
    if (this.controlPlaneApiKey && this.environment.NODE_ENV === 'production' && Buffer.byteLength(this.controlPlaneApiKey) < 32) {
      throw new Error('CONTROL_PLANE_API_KEY must contain at least 32 bytes in production');
    }
    const sessionSecrets = normalizeList(this.environment.SESSION_SECRET || (this.controlPlaneApiKey
      ? crypto.createHash('sha256').update(`aidecepticon-session:${this.controlPlaneApiKey}`).digest('hex')
      : ''));
    if (!sessionSecrets.length || Buffer.byteLength(sessionSecrets[0]) < 32) {
      throw new Error('SESSION_SECRET must contain at least 32 bytes when authentication is enabled');
    }
    if (this.environment.NODE_ENV === 'production' && !this.environment.REDIS_URL) {
      throw new Error('REDIS_URL is required for production authentication sessions');
    }
    if (this.publicBaseUrl.protocol !== 'https:' && this.environment.NODE_ENV === 'production') {
      throw new Error('PUBLIC_BASE_URL must use HTTPS when production authentication is enabled');
    }
    if (!this.enabled) return;
    if (this.mode === 'oidc') {
      for (const key of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) {
        if (!this.environment[key]) throw new Error(`${key} is required when AUTH_MODE=oidc`);
      }
    }
    if (this.mode === 'saml') {
      for (const key of ['SAML_ENTRY_POINT', 'SAML_ISSUER', 'SAML_IDP_CERT']) {
        if (!this.environment[key]) throw new Error(`${key} is required when AUTH_MODE=saml`);
      }
      if (this.requireMfa && !this.environment.SAML_MFA_ATTRIBUTE) {
        throw new Error('SAML_MFA_ATTRIBUTE is required when SAML MFA enforcement is enabled');
      }
      if (this.publicBaseUrl.protocol !== 'https:' && this.environment.NODE_ENV !== 'test') {
        throw new Error('PUBLIC_BASE_URL must use HTTPS for SAML POST binding');
      }
    }
  }

  createSessionMiddleware() {
    const sessionSecrets = normalizeList(this.environment.SESSION_SECRET || crypto.createHash('sha256').update(`aidecepticon-session:${this.controlPlaneApiKey}`).digest('hex'));
    const secure = this.publicBaseUrl.protocol === 'https:';
    let sessionStore;
    if (this.environment.REDIS_URL) {
      this.redisClient = createClient({ url: this.environment.REDIS_URL });
      this.redisClient.on('error', (error) => this.logger.error(`Authentication Redis error: ${error.message}`));
      sessionStore = new RedisStore({
        client: this.redisClient,
        prefix: `${this.environment.REDIS_PREFIX || 'aidecepticon'}:session:`,
        ttl: boundedNumber(this.environment.SESSION_TTL_SECONDS, 28_800, 300),
      });
    }
    return session({
      name: secure ? '__Host-aidecepticon.sid' : 'aidecepticon.sid',
      secret: sessionSecrets,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: true,
      cookie: {
        httpOnly: true,
        secure,
        sameSite: this.mode === 'saml' ? 'none' : 'lax',
        path: '/',
        maxAge: boundedNumber(this.environment.SESSION_TTL_SECONDS, 28_800, 300) * 1_000,
      },
    });
  }

  async init() {
    if (!this.sessionEnabled) return;
    if (this.redisClient && !this.redisClient.isOpen) await this.redisClient.connect();
    if (!this.enabled) return;
    if (this.mode === 'oidc') {
      this.oidcConfiguration = await oidc.discovery(
        new URL(this.environment.OIDC_ISSUER),
        this.environment.OIDC_CLIENT_ID,
        this.environment.OIDC_CLIENT_SECRET,
      );
    } else if (this.mode === 'saml') {
      const requestTtl = boundedNumber(this.environment.SAML_REQUEST_TTL_SECONDS, 300, 60);
      const cacheProvider = this.redisClient
        ? new RedisSamlCache(this.redisClient, `${this.environment.REDIS_PREFIX || 'aidecepticon'}:saml:request:`, requestTtl)
        : undefined;
      const authnContext = normalizeList(this.environment.SAML_REQUIRED_AUTHN_CONTEXT);
      this.saml = new SAML({
        callbackUrl: new URL('/api/v1/auth/saml/callback', this.publicBaseUrl).href,
        entryPoint: this.environment.SAML_ENTRY_POINT,
        issuer: this.environment.SAML_ISSUER,
        idpCert: normalizePem(this.environment.SAML_IDP_CERT),
        audience: this.environment.SAML_ISSUER,
        validateInResponseTo: ValidateInResponseTo.always,
        requestIdExpirationPeriodMs: requestTtl * 1_000,
        acceptedClockSkewMs: boundedNumber(this.environment.SAML_CLOCK_SKEW_MS, 5_000, 0),
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: true,
        disableRequestedAuthnContext: authnContext.length === 0,
        authnContext,
        racComparison: 'exact',
        ...(cacheProvider ? { cacheProvider } : {}),
      });
    }
  }

  assertMfa(claims) {
    if (this.mode === 'oidc') {
      const requiredAcr = this.environment.OIDC_REQUIRED_ACR;
      const acceptedAmr = normalizeList(this.environment.OIDC_MFA_AMR_VALUES || 'mfa,otp,hwk,swk');
      const amr = normalizeList(claims.amr);
      const satisfied = Boolean((requiredAcr && claims.acr === requiredAcr) || amr.some((value) => acceptedAmr.includes(value)));
      if (this.requireMfa && !satisfied) throw new Error('Identity provider response does not satisfy the configured MFA policy');
      return satisfied;
    }
    const attribute = this.environment.SAML_MFA_ATTRIBUTE;
    const acceptedValues = normalizeList(this.environment.SAML_MFA_VALUES || 'true,mfa');
    const assertedValues = normalizeList(claims[attribute]);
    const satisfied = assertedValues.some((value) => acceptedValues.includes(value));
    if (this.requireMfa && !satisfied) throw new Error('SAML assertion does not satisfy the configured MFA policy');
    return satisfied;
  }

  principalFromClaims(claims) {
    return buildPrincipal(claims, {
      provider: this.mode,
      defaultRole: this.defaultRole,
      groupsClaim: this.groupsClaim,
      roleClaim: this.roleClaim,
      roleMappings: this.roleMappings,
      mfa: this.assertMfa(claims),
    });
  }

  async establishSession(request, user, extra = {}) {
    await regenerateSession(request);
    request.session.user = user;
    request.session.authenticatedAt = new Date().toISOString();
    Object.assign(request.session, extra);
    await saveSession(request);
  }

  install(app) {
    if (this.sessionEnabled) {
      app.set('trust proxy', Number(this.environment.TRUST_PROXY_HOPS || 1));
      app.use(this.sessionMiddleware);
      app.use((request, _response, next) => {
        request.user = request.session?.user || null;
        next();
      });
    } else {
      app.use((request, _response, next) => {
        request.user = this.developmentUser;
        next();
      });
    }

    app.get('/api/v1/auth/config', (_request, response) => response.json({
      enabled: this.sessionEnabled,
      mode: this.enabled ? this.mode : (this.controlPlaneApiKey ? 'api_key' : 'disabled'),
      providerLabel: this.enabled ? this.providerLabel : (this.controlPlaneApiKey ? 'Control-plane API key' : 'Local development'),
      requireMfa: this.requireMfa,
      roles: Object.keys(rolePermissions),
    }));

    app.get('/api/v1/auth/session', (request, response) => response.json({
      enabled: this.sessionEnabled,
      mode: this.enabled ? this.mode : (this.controlPlaneApiKey ? 'api_key' : 'disabled'),
      providerLabel: this.enabled ? this.providerLabel : (this.controlPlaneApiKey ? 'Control-plane API key' : 'Local development'),
      requireMfa: this.requireMfa,
      authenticated: Boolean(request.user),
      user: request.user || null,
      permissions: request.user ? (request.user.permissions || rolePermissions[request.user.role] || []) : [],
    }));

    app.get('/api/v1/auth/login', async (request, response, next) => {
      if (!this.enabled) return response.redirect(safeReturnTo(request.query.returnTo));
      const returnTo = safeReturnTo(request.query.returnTo);
      try {
        if (this.mode === 'oidc') {
          const codeVerifier = oidc.randomPKCECodeVerifier();
          const state = oidc.randomState();
          const nonce = oidc.randomNonce();
          request.session.authTransaction = { codeVerifier, state, nonce, returnTo };
          await saveSession(request);
          const redirect = oidc.buildAuthorizationUrl(this.oidcConfiguration, {
            redirect_uri: new URL('/api/v1/auth/oidc/callback', this.publicBaseUrl).href,
            scope: this.environment.OIDC_SCOPES || 'openid profile email groups',
            code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
            code_challenge_method: 'S256',
            state,
            nonce,
          });
          return response.redirect(redirect.href);
        }
        const relayState = crypto.randomBytes(24).toString('base64url');
        request.session.authTransaction = { relayState, returnTo };
        await saveSession(request);
        return response.redirect(await this.saml.getAuthorizeUrlAsync(relayState, request.hostname, {}));
      } catch (error) {
        next(error);
      }
    });

    app.post('/api/v1/auth/api-key', async (request, response, next) => {
      if (this.enabled || !this.controlPlaneApiKey) return response.status(404).json({ error: 'API-key sign-in is not configured' });
      if (!safeEqual(String(request.body?.apiKey || ''), this.controlPlaneApiKey)) {
        return response.status(401).json({ error: 'The control-plane API key is invalid' });
      }
      try {
        const user = {
          id: 'control-plane-api-key',
          email: '',
          displayName: 'API key administrator',
          role: 'service',
          groups: [],
          provider: 'api-key',
          mfa: false,
          permissions: this.apiKeyPermissions,
        };
        await this.establishSession(request, user);
        response.json({ user, permissions: this.apiKeyPermissions });
      } catch (error) {
        next(error);
      }
    });

    app.get('/api/v1/auth/oidc/callback', async (request, response, next) => {
      if (this.mode !== 'oidc') return response.status(404).json({ error: 'OIDC is not configured' });
      const transaction = request.session?.authTransaction;
      if (!transaction) return response.status(400).json({ error: 'Authentication transaction is missing or expired' });
      try {
        const currentUrl = new URL(request.originalUrl, this.publicBaseUrl);
        const tokens = await oidc.authorizationCodeGrant(this.oidcConfiguration, currentUrl, {
          pkceCodeVerifier: transaction.codeVerifier,
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
        });
        const claims = tokens.claims();
        if (!claims?.sub) throw new Error('OIDC response did not contain a subject claim');
        const user = this.principalFromClaims(claims);
        await this.establishSession(request, user, { oidcIdToken: tokens.id_token });
        response.redirect(transaction.returnTo);
      } catch (error) {
        next(error);
      }
    });

    app.post('/api/v1/auth/saml/callback', async (request, response, next) => {
      if (this.mode !== 'saml') return response.status(404).json({ error: 'SAML is not configured' });
      const transaction = request.session?.authTransaction;
      if (!transaction || !safeEqual(String(request.body?.RelayState || ''), transaction.relayState)) {
        return response.status(400).json({ error: 'Authentication transaction is missing, expired, or invalid' });
      }
      try {
        const result = await this.saml.validatePostResponseAsync(request.body);
        if (!result.profile || result.loggedOut) throw new Error('SAML response did not contain an authenticated profile');
        const user = this.principalFromClaims(result.profile);
        await this.establishSession(request, user);
        response.redirect(transaction.returnTo);
      } catch (error) {
        next(error);
      }
    });

    app.get('/api/v1/auth/saml/metadata', (_request, response) => {
      if (this.mode !== 'saml' || !this.saml) return response.status(404).json({ error: 'SAML is not configured' });
      response.type('application/xml').send(this.saml.generateServiceProviderMetadata(null));
    });

    app.post('/api/v1/auth/logout', async (request, response, next) => {
      if (!this.sessionEnabled || !request.session) return response.status(204).end();
      if (request.user && !this.allowedOrigins.has(request.get('origin'))) {
        return response.status(403).json({ error: 'Request origin does not match the authenticated control-plane origin' });
      }
      try {
        await destroySession(request);
        response.clearCookie(this.publicBaseUrl.protocol === 'https:' ? '__Host-aidecepticon.sid' : 'aidecepticon.sid', { path: '/' });
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });

    app.use((request, response, next) => {
      if (!this.sessionEnabled || !request.user || !unsafeMethods.has(request.method) || request.path.startsWith('/api/v1/auth/')) return next();
      const origin = request.get('origin');
      if (origin && this.allowedOrigins.has(origin)) return next();
      response.status(403).json({ error: 'Request origin does not match the authenticated control-plane origin' });
    });
  }

  requirePermission(permission) {
    return (request, response, next) => {
      if (this.controlPlaneApiKey && request.get('authorization')?.startsWith('Bearer ')) {
        const token = request.get('authorization').slice(7);
        if (safeEqual(token, this.controlPlaneApiKey)) {
          if (this.apiKeyPermissions.includes('*') || this.apiKeyPermissions.includes(permission)) {
            request.user = { id: 'control-plane-api-key', displayName: 'Control-plane API key', role: 'service', provider: 'api-key', mfa: true };
            return next();
          }
          return response.status(403).json({ error: `API credential lacks permission ${permission}` });
        }
      }
      if (!request.user) return response.status(401).json({ error: 'Authentication is required', loginUrl: '/api/v1/auth/login' });
      if (!hasPermission(request.user, permission)) return response.status(403).json({ error: `Role ${request.user.role} lacks permission ${permission}` });
      next();
    };
  }

  health() {
    return {
      healthy: !this.sessionEnabled || !this.redisClient || this.redisClient.isReady,
      mode: this.enabled ? this.mode : (this.controlPlaneApiKey ? 'api_key' : 'disabled'),
      provider: this.enabled ? this.providerLabel : (this.controlPlaneApiKey ? 'Control-plane API key' : 'Local development'),
    };
  }

  async close() {
    if (this.redisClient?.isOpen) await this.redisClient.quit();
  }
}

export function createAuthController(environment = process.env, options = {}) {
  return new AuthController(environment, options);
}
