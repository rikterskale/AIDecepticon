import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { store } from './store.js';
import { installSensorRoutes, publicSensor } from './sensor-api.js';
import { createCommandQueue, createCommandScheduler } from './command-queue.js';
import { createAuthController } from './auth.js';
import { createSecretManager, publicSecret } from './secret-manager.js';
import { createAuditTrail } from './audit.js';
import { createTenancyController, organizationScope } from './tenancy.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const commandQueue = createCommandQueue(store);
const commandScheduler = createCommandScheduler(store, commandQueue);
const authController = createAuthController();
const secretManager = createSecretManager();
const auditTrail = createAuditTrail(store);
const tenancyController = createTenancyController(store);
const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../dist');

app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
  });
  next();
});
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()) || false }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '1mb' }));
app.use(auditTrail.middleware());
authController.install(app);
tenancyController.install(app, authController.requirePermission.bind(authController));

installSensorRoutes(app, { store, commandQueue, commandScheduler, requirePermission: authController.requirePermission.bind(authController) });

app.get('/api/v1/health', async (_request, response) => {
  const [storage, queue, audit] = await Promise.all([store.health(), commandQueue.health(), auditTrail.health()]);
  const scheduler = commandScheduler.health();
  const authentication = authController.health();
  const secrets = secretManager.health();
  const healthy = storage.healthy && queue.healthy && scheduler.healthy && authentication.healthy && secrets.healthy && audit.healthy;
  response.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    version: '0.1.0',
    time: new Date().toISOString(),
    infrastructure: { storage, queue, scheduler, authentication, secrets, audit },
  });
});

app.get('/api/v1/summary', authController.requirePermission('platform:read'), async (request, response) => {
  const scope = organizationScope(request);
  const [deployments, incidents, sensors] = await Promise.all([
    store.read('deployments', scope),
    store.read('incidents', scope),
    store.read('sensors', scope),
  ]);
  response.json({
    protectedAssets: deployments.reduce((total, deployment) => total + deployment.decoys, 0),
    activeDetections: incidents.filter((incident) => !['closed', 'contained'].includes(incident.status)).length,
    sensorsOnline: sensors.filter((sensor) => sensor.health >= 85).length,
    totalSensors: sensors.length,
    coverage: deployments.length ? 87 : 0,
    meanTimeToDetect: incidents.length ? '11s' : '—',
  });
});

for (const [resource, permission] of Object.entries({
  deployments: 'deception:read',
  incidents: 'incident:read',
  domains: 'platform:read',
  integrations: 'platform:read',
  tokens: 'deception:read',
})) {
  app.get(`/api/v1/${resource}`, authController.requirePermission(permission), async (request, response) => response.json({ items: await store.read(resource, organizationScope(request)) }));
}

app.get('/api/v1/sensors', authController.requirePermission('sensor:read'), async (request, response) => response.json({ items: (await store.read('sensors', organizationScope(request))).map(publicSensor) }));

app.get('/api/v1/secrets', authController.requirePermission('secret:read'), async (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ items: (await store.read('secrets', organizationScope(request))).map(publicSecret) });
});

app.post('/api/v1/secrets', authController.requirePermission('secret:write'), async (request, response) => {
  const { name, type = 'integration', description = '', value } = request.body || {};
  if (!String(name || '').trim() || !String(value || '')) return response.status(400).json({ error: 'name and value are required' });
  if (!['integration', 'cloud', 'identity', 'response', 'api'].includes(type)) return response.status(400).json({ error: 'Unsupported secret type' });
  const id = `sec-${crypto.randomUUID().slice(0, 12)}`;
  const scope = organizationScope(request);
  const sealed = await secretManager.seal(id, value, type, scope.organizationId);
  const now = new Date().toISOString();
  const record = await store.add('secrets', {
    id,
    name: String(name).trim().slice(0, 100),
    type,
    description: String(description).trim().slice(0, 300),
    provider: sealed.envelope.provider,
    keyId: sealed.envelope.keyId,
    fingerprint: sealed.fingerprint,
    envelope: sealed.envelope,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: request.user.id,
  }, scope);
  response.locals.auditTargetId = id;
  response.locals.auditTargetType = 'secret';
  response.set('Cache-Control', 'no-store');
  response.status(201).json(publicSecret(record));
});

app.post('/api/v1/secrets/:id/rotate', authController.requirePermission('secret:write'), async (request, response) => {
  const scope = organizationScope(request);
  const record = (await store.read('secrets', scope)).find((candidate) => candidate.id === request.params.id);
  if (!record) return response.status(404).json({ error: 'Secret not found' });
  if (!String(request.body?.value || '')) return response.status(400).json({ error: 'value is required' });
  const sealed = await secretManager.seal(record.id, request.body.value, record.type, scope.organizationId);
  const updated = await store.update('secrets', record.id, {
    provider: sealed.envelope.provider,
    keyId: sealed.envelope.keyId,
    fingerprint: sealed.fingerprint,
    envelope: sealed.envelope,
    updatedAt: new Date().toISOString(),
    updatedBy: request.user.id,
  }, scope);
  response.locals.auditTargetId = record.id;
  response.locals.auditTargetType = 'secret';
  response.set('Cache-Control', 'no-store');
  response.json(publicSecret(updated));
});

app.post('/api/v1/secrets/:id/verify', authController.requirePermission('secret:write'), async (request, response) => {
  const scope = organizationScope(request);
  const record = (await store.read('secrets', scope)).find((candidate) => candidate.id === request.params.id);
  if (!record) return response.status(404).json({ error: 'Secret not found' });
  const verified = await secretManager.verify(record.id, record.envelope, record.fingerprint, scope.organizationId);
  response.locals.auditTargetId = record.id;
  response.locals.auditTargetType = 'secret';
  response.set('Cache-Control', 'no-store');
  response.json({ verified, provider: record.provider, keyId: record.keyId, checkedAt: new Date().toISOString() });
});

app.get('/api/v1/audit-events', authController.requirePermission('audit:read'), async (request, response) => {
  const [items, verification] = await Promise.all([
    auditTrail.list(request.query.limit, organizationScope(request).organizationId),
    auditTrail.verify(),
  ]);
  response.set('Cache-Control', 'no-store');
  response.json({ items, verification });
});

app.post('/api/v1/deployments', authController.requirePermission('deception:write'), async (request, response) => {
  const { name, blueprintId, environment, location, mode = 'agentless', customizations = {} } = request.body || {};
  if (!name || !blueprintId || !environment || !location) {
    return response.status(400).json({ error: 'name, blueprintId, environment, and location are required' });
  }
  const deployment = await store.add('deployments', {
    id: `dep-${crypto.randomUUID().slice(0, 8)}`,
    name,
    blueprintId,
    environment,
    location,
    mode,
    customizations,
    status: 'provisioning',
    decoys: 1,
    interactions: 0,
    updatedAt: new Date().toISOString(),
  }, organizationScope(request));
  response.locals.auditTargetId = deployment.id;
  response.locals.auditTargetType = 'deployment';
  response.status(201).json(deployment);
});

app.patch('/api/v1/incidents/:id', authController.requirePermission('incident:write'), async (request, response) => {
  const allowed = ['status', 'assignee'];
  const changes = Object.fromEntries(Object.entries(request.body || {}).filter(([key]) => allowed.includes(key)));
  const incident = await store.update('incidents', request.params.id, changes, organizationScope(request));
  if (!incident) return response.status(404).json({ error: 'Incident not found' });
  response.locals.auditTargetId = request.params.id;
  response.locals.auditTargetType = 'incident';
  response.json(incident);
});

app.post('/api/v1/tokens', authController.requirePermission('token:write'), async (request, response) => {
  const { name, type = 'document', destination = 'default', metadata = {} } = request.body || {};
  if (!name) return response.status(400).json({ error: 'name is required' });
  const id = `tok-${crypto.randomUUID().slice(0, 12)}`;
  const token = await store.add('tokens', {
    id,
    name,
    type,
    destination,
    metadata,
    status: 'armed',
    createdAt: new Date().toISOString(),
    beaconUrl: `${baseUrl}/api/v1/beacon/${id}`,
  }, organizationScope(request));
  response.locals.auditTargetId = id;
  response.locals.auditTargetType = 'canary-token';
  response.status(201).json(token);
});

app.all('/api/v1/beacon/:tokenId', async (request, response) => {
  const token = (await store.read('tokens')).find((candidate) => candidate.id === request.params.tokenId);
  if (!token) return response.status(404).json({ error: 'Token not found' });

  const scope = { organizationId: token.organizationId };
  request.organization = { id: token.organizationId };
  await store.update('tokens', token.id, { status: 'triggered', lastTriggeredAt: new Date().toISOString() }, scope);
  await store.add('incidents', {
    id: `INC-${crypto.randomInt(3000, 9999)}`,
    severity: 'high',
    title: `${token.type} canary triggered: ${token.name}`,
    source: request.ip,
    target: token.name,
    technique: 'T1083',
    confidence: 98,
    status: 'new',
    age: 'now',
    timestamp: new Date().toISOString(),
    summary: `A ${token.type} deception token was accessed outside its expected workflow.`,
    steps: ['Canary accessed', 'Source fingerprinted', 'Incident opened'],
  }, scope);
  response.status(204).end();
});

app.get('/openapi.yaml', (_request, response) => response.sendFile(path.resolve(here, '../openapi.yaml')));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath));
  app.get('/{*splat}', (_request, response) => response.sendFile(path.join(distPath, 'index.html')));
}

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Unexpected server error' });
});

let server;

export async function initializeInfrastructure() {
  await Promise.all([store.init(), commandQueue.init(), authController.init()]);
  await commandScheduler.runOnce();
  commandScheduler.start();
}

export async function closeInfrastructure() {
  commandScheduler.close();
  await auditTrail.flush();
  await Promise.allSettled([authController.close(), secretManager.close(), commandQueue.close(), store.close()]);
}

export async function start() {
  await initializeInfrastructure();
  server = app.listen(port, '0.0.0.0', () => {
    console.log(`AIDecepticon listening on http://localhost:${port}`);
  });
  return server;
}

async function shutdown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeInfrastructure();
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((error) => {
    console.error(`AIDecepticon failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export { app, authController, tenancyController, secretManager, auditTrail, commandQueue, commandScheduler };
