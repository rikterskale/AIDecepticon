// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import { AuthController, buildPrincipal, hasPermission, safeReturnTo } from './auth.js';

const oidcEnvironment = {
  AUTH_MODE: 'oidc',
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
  SESSION_SECRET: 'test-session-secret-with-at-least-32-bytes',
  OIDC_ISSUER: 'https://identity.example.test',
  OIDC_CLIENT_ID: 'aidecepticon-test',
  OIDC_CLIENT_SECRET: 'test-client-secret',
};

describe('authentication and RBAC', () => {
  it('maps trusted identity groups to the highest-priority configured role', () => {
    const principal = buildPrincipal({
      sub: 'user-123',
      name: 'Deception Operator',
      email: 'operator@example.test',
      groups: ['SOC-Analysts', 'Deception-Admins'],
    }, {
      provider: 'oidc',
      defaultRole: 'auditor',
      roleMappings: {
        platform_admin: ['Deception-Admins'],
        analyst: ['SOC-Analysts'],
      },
    });

    expect(principal).toMatchObject({ id: 'user-123', role: 'platform_admin', provider: 'oidc' });
    expect(hasPermission(principal, 'sensor:write')).toBe(true);
  });

  it('enforces role permissions and defaults unknown users to auditor', () => {
    const principal = buildPrincipal({ sub: 'auditor-1', name: 'Audit User' }, { defaultRole: 'auditor' });
    expect(hasPermission(principal, 'incident:read')).toBe(true);
    expect(hasPermission(principal, 'incident:write')).toBe(false);
    expect(hasPermission(principal, 'sensor:write')).toBe(false);
  });

  it('requires MFA evidence when the configured OIDC policy demands it', () => {
    const controller = new AuthController({ ...oidcEnvironment, AUTH_REQUIRE_MFA: 'true' });
    expect(() => controller.principalFromClaims({ sub: 'without-mfa', amr: ['pwd'] })).toThrow(/MFA policy/);
    expect(controller.principalFromClaims({ sub: 'with-mfa', amr: ['pwd', 'mfa'] }).mfa).toBe(true);
  });

  it('fails closed for incomplete production authentication configuration', () => {
    expect(() => new AuthController({
      ...oidcEnvironment,
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://deception.example.test',
    })).toThrow(/REDIS_URL/);
    expect(() => new AuthController({
      ...oidcEnvironment,
      SESSION_SECRET: 'too-short',
    })).toThrow(/at least 32 bytes/);
    expect(() => new AuthController({
      AUTH_MODE: 'disabled',
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://deception.example.test',
    })).toThrow(/only allowed for loopback/);
  });

  it('scopes API-key access and rejects unsafe redirect targets', () => {
    const controller = new AuthController({
      AUTH_MODE: 'disabled',
      PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
      CONTROL_PLANE_API_KEY: 'scoped-test-key',
      CONTROL_PLANE_API_PERMISSIONS: 'sensor:read',
    });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const deniedNext = vi.fn();
    controller.requirePermission('sensor:write')({
      get: () => 'Bearer scoped-test-key',
    }, response, deniedNext);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();

    const allowedNext = vi.fn();
    controller.requirePermission('sensor:read')({
      get: () => 'Bearer scoped-test-key',
    }, response, allowedNext);
    expect(allowedNext).toHaveBeenCalledOnce();
    expect(safeReturnTo('/surfaces')).toBe('/surfaces');
    expect(safeReturnTo('//attacker.example')).toBe('/');
    expect(safeReturnTo('https://attacker.example')).toBe('/');
  });

  it('exchanges an API key for an origin-protected GUI session', async () => {
    const controller = new AuthController({
      AUTH_MODE: 'disabled',
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
      CONTROL_PLANE_API_KEY: 'browser-session-key-with-at-least-32-bytes',
      CONTROL_PLANE_API_PERMISSIONS: 'sensor:read,sensor:write',
    });
    const app = express();
    app.use(express.json());
    controller.install(app);
    app.post('/protected', controller.requirePermission('sensor:write'), (_request, response) => response.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    try {
      const signIn = await fetch(`${origin}/api/v1/auth/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'browser-session-key-with-at-least-32-bytes' }),
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.get('set-cookie').split(';', 1)[0];
      const session = await fetch(`${origin}/api/v1/auth/session`, { headers: { Cookie: cookie } });
      expect(await session.json()).toMatchObject({ authenticated: true, permissions: ['sensor:read', 'sensor:write'] });

      const protectedResponse = await fetch(`${origin}/protected`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:8787' },
      });
      expect(protectedResponse.status).toBe(200);
      const crossOrigin = await fetch(`${origin}/protected`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://attacker.example' },
      });
      expect(crossOrigin.status).toBe(403);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await controller.close();
    }
  });

  it.skipIf(!process.env.REDIS_URL)('persists and revokes authenticated GUI sessions in Redis', async () => {
    const prefix = `aidecepticon-auth-test-${crypto.randomUUID()}`;
    const controller = new AuthController({
      AUTH_MODE: 'disabled',
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
      CONTROL_PLANE_API_KEY: 'redis-session-key-with-at-least-32-bytes',
      CONTROL_PLANE_API_PERMISSIONS: '*',
      REDIS_URL: process.env.REDIS_URL,
      REDIS_PREFIX: prefix,
    });
    await controller.init();
    const app = express();
    app.use(express.json());
    controller.install(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const signIn = await fetch(`${origin}/api/v1/auth/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'redis-session-key-with-at-least-32-bytes' }),
      });
      const cookie = signIn.headers.get('set-cookie').split(';', 1)[0];
      expect((await controller.redisClient.keys(`${prefix}:session:*`)).length).toBe(1);
      const logout = await fetch(`${origin}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://127.0.0.1:8787' } });
      expect(logout.status).toBe(204);
      expect(await controller.redisClient.keys(`${prefix}:session:*`)).toHaveLength(0);
    } finally {
      const keys = await controller.redisClient.keys(`${prefix}:*`);
      if (keys.length) await controller.redisClient.del(keys);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await controller.close();
    }
  });
});
