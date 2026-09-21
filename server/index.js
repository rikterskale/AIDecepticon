import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { store } from './store.js';
import { installSensorRoutes, publicSensor } from './sensor-api.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const controlPlaneApiKey = process.env.CONTROL_PLANE_API_KEY;
const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../dist');

app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()) || false }));
app.use(express.json({ limit: '1mb' }));
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

function requireControlPlaneKey(request, response, next) {
  if (!controlPlaneApiKey) return next();
  if (request.get('authorization') === `Bearer ${controlPlaneApiKey}`) return next();
  response.status(401).json({ error: 'A valid control-plane bearer token is required' });
}

installSensorRoutes(app, { store, requireControlPlaneKey });

app.get('/api/v1/health', (_request, response) => {
  response.json({ status: 'ok', version: '0.1.0', time: new Date().toISOString() });
});

app.get('/api/v1/summary', (_request, response) => {
  const deployments = store.read('deployments');
  const incidents = store.read('incidents');
  const sensors = store.read('sensors');
  response.json({
    protectedAssets: deployments.reduce((total, deployment) => total + deployment.decoys, 0),
    activeDetections: incidents.filter((incident) => !['closed', 'contained'].includes(incident.status)).length,
    sensorsOnline: sensors.filter((sensor) => sensor.health >= 85).length,
    totalSensors: sensors.length,
    coverage: 87,
    meanTimeToDetect: '11s',
  });
});

for (const resource of ['deployments', 'incidents', 'domains', 'integrations', 'tokens']) {
  app.get(`/api/v1/${resource}`, (_request, response) => response.json({ items: store.read(resource) }));
}

app.get('/api/v1/sensors', (_request, response) => response.json({ items: store.read('sensors').map(publicSensor) }));

app.post('/api/v1/deployments', requireControlPlaneKey, (request, response) => {
  const { name, blueprintId, environment, location, mode = 'agentless', customizations = {} } = request.body || {};
  if (!name || !blueprintId || !environment || !location) {
    return response.status(400).json({ error: 'name, blueprintId, environment, and location are required' });
  }
  const deployment = store.add('deployments', {
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
  });
  response.status(201).json(deployment);
});

app.patch('/api/v1/incidents/:id', requireControlPlaneKey, (request, response) => {
  const allowed = ['status', 'assignee'];
  const changes = Object.fromEntries(Object.entries(request.body || {}).filter(([key]) => allowed.includes(key)));
  const incident = store.update('incidents', request.params.id, changes);
  if (!incident) return response.status(404).json({ error: 'Incident not found' });
  response.json(incident);
});

app.post('/api/v1/tokens', requireControlPlaneKey, (request, response) => {
  const { name, type = 'document', destination = 'default', metadata = {} } = request.body || {};
  if (!name) return response.status(400).json({ error: 'name is required' });
  const id = `tok-${crypto.randomUUID().slice(0, 12)}`;
  const token = store.add('tokens', {
    id,
    name,
    type,
    destination,
    metadata,
    status: 'armed',
    createdAt: new Date().toISOString(),
    beaconUrl: `${baseUrl}/api/v1/beacon/${id}`,
  });
  response.status(201).json(token);
});

app.all('/api/v1/beacon/:tokenId', (request, response) => {
  const token = store.read('tokens').find((candidate) => candidate.id === request.params.tokenId);
  if (!token) return response.status(404).json({ error: 'Token not found' });

  store.update('tokens', token.id, { status: 'triggered', lastTriggeredAt: new Date().toISOString() });
  store.add('incidents', {
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
  });
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

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, '0.0.0.0', () => {
    console.log(`AIDecepticon listening on http://localhost:${port}`);
  });
}

export { app };
