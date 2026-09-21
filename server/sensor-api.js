import crypto from 'node:crypto';
import { organizationScope } from './tenancy.js';

const developmentSigningKey = 'aidecepticon-development-command-key-change-me';
const allowedCommandTypes = new Set(['deploy_decoy', 'stop_decoy', 'snapshot']);
const allowedEventProtocols = new Set(['http', 'ssh', 'postgres', 'redis', 'smb', 'tcp']);

export function assertSensorSecurityConfiguration() {
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.SENSOR_COMMAND_SIGNING_KEY || '') < 32) {
    throw new Error('SENSOR_COMMAND_SIGNING_KEY must contain at least 32 bytes when NODE_ENV=production');
  }
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function commandPayload(command) {
  return canonicalize({
    expiresAt: command.expiresAt,
    id: command.id,
    issuedAt: command.issuedAt,
    payload: command.payload,
    sensorId: command.sensorId,
    type: command.type,
  });
}

function deriveCommandKey(sensorId) {
  const masterKey = process.env.SENSOR_COMMAND_SIGNING_KEY || developmentSigningKey;
  return crypto.createHmac('sha256', masterKey).update(`sensor:${sensorId}`).digest();
}

export function signSensorCommand(command) {
  return crypto.createHmac('sha256', deriveCommandKey(command.sensorId))
    .update(JSON.stringify(commandPayload(command)))
    .digest('base64url');
}

export function verifySensorCommand(command) {
  return safeEqual(command.signature, signSensorCommand(command));
}

export function publicSensor(sensor) {
  if (!sensor) return sensor;
  const { accessTokenHash: _accessTokenHash, ...safeSensor } = sensor;
  return safeSensor;
}

export async function createSensorCommand(store, commandQueue, sensorId, input = {}, scope = {}) {
  const sensor = (await store.read('sensors', scope)).find((candidate) => candidate.id === sensorId);
  if (!sensor) return { error: 'Sensor not found', status: 404 };
  if (!allowedCommandTypes.has(input.type)) return { error: 'Unsupported sensor command type', status: 400 };

  const issuedAt = new Date();
  const maxAttempts = Math.trunc(boundedNumber(input.maxAttempts, 3, 1, 10));
  const retryBackoffSeconds = boundedNumber(input.retryBackoffSeconds, 15, 5, 300);
  const command = {
    id: `cmd-${crypto.randomUUID().slice(0, 12)}`,
    sensorId,
    organizationId: sensor.organizationId,
    type: input.type,
    payload: input.payload || {},
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
    status: 'queued',
    attempts: 0,
    maxAttempts,
    retryBackoffSeconds,
    nextAttemptAt: issuedAt.toISOString(),
  };
  command.signature = signSensorCommand(command);
  const persisted = await store.add('sensorCommands', command, { organizationId: sensor.organizationId });
  await commandQueue.enqueue(persisted);
  return { command: persisted };
}

function authorizeSensor(store) {
  return async (request, response, next) => {
    const sensor = (await store.read('sensors')).find((candidate) => candidate.id === request.params.sensorId);
    const token = request.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    if (!sensor?.accessTokenHash || !safeEqual(sensor.accessTokenHash, hashSecret(token))) {
      return response.status(401).json({ error: 'A valid sensor bearer token is required' });
    }
    request.sensor = sensor;
    request.organization = { id: sensor.organizationId };
    next();
  };
}

function techniqueFor(protocol) {
  return ({
    http: 'T1190',
    ssh: 'T1021.004',
    postgres: 'T1213',
    redis: 'T1213',
    smb: 'T1021.002',
    tcp: 'T1046',
  })[protocol] || 'T1046';
}

export function installSensorRoutes(app, { store, commandQueue, commandScheduler, requirePermission }) {
  assertSensorSecurityConfiguration();

  const requireSensor = authorizeSensor(store);

  app.get('/api/v1/sensor-commands', requirePermission('sensor:read'), async (request, response) => {
    const requestedStatuses = String(request.query.status || '').split(',').map((status) => status.trim()).filter(Boolean);
    const commands = await store.read('sensorCommands', organizationScope(request));
    const items = requestedStatuses.length
      ? commands.filter((command) => requestedStatuses.includes(command.status))
      : commands;
    response.json({ items });
  });

  app.post('/api/v1/sensor-commands/:commandId/retry', requirePermission('sensor:write'), async (request, response) => {
    const scope = organizationScope(request);
    const original = (await store.read('sensorCommands', scope)).find((command) => command.id === request.params.commandId);
    if (!original) return response.status(404).json({ error: 'Command not found' });
    if (original.status !== 'dead_lettered') return response.status(409).json({ error: 'Only dead-lettered commands can be retried' });
    const result = await createSensorCommand(store, commandQueue, original.sensorId, {
      type: original.type,
      payload: original.payload,
      maxAttempts: original.maxAttempts,
      retryBackoffSeconds: original.retryBackoffSeconds,
    }, scope);
    if (result.error) return response.status(result.status).json({ error: result.error });
    await store.update('sensorCommands', original.id, {
      status: 'retried',
      retriedAt: new Date().toISOString(),
      retriedAs: result.command.id,
    }, scope);
    response.status(201).json(result.command);
  });

  app.post('/api/v1/sensor-commands/:commandId/dismiss', requirePermission('sensor:write'), async (request, response) => {
    const scope = organizationScope(request);
    const original = (await store.read('sensorCommands', scope)).find((command) => command.id === request.params.commandId);
    if (!original) return response.status(404).json({ error: 'Command not found' });
    if (original.status !== 'dead_lettered') return response.status(409).json({ error: 'Only dead-lettered commands can be dismissed' });
    const dismissed = await store.update('sensorCommands', original.id, {
      status: 'dismissed',
      dismissedAt: new Date().toISOString(),
    }, scope);
    await commandQueue.remove(original.sensorId, original.id);
    response.json(dismissed);
  });

  app.post('/api/v1/sensor-enrollment-tokens', requirePermission('sensor:write'), async (request, response) => {
    const ttlMinutes = Math.min(Math.max(Number(request.body?.ttlMinutes || 15), 5), 60);
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const record = await store.add('sensorEnrollmentTokens', {
      id: `enr-${crypto.randomUUID().slice(0, 10)}`,
      label: String(request.body?.label || 'Projection sensor').slice(0, 100),
      tokenHash: hashSecret(token),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMinutes * 60_000).toISOString(),
      usedAt: null,
    }, organizationScope(request));
    response.status(201).json({ id: record.id, token, expiresAt: record.expiresAt });
  });

  app.post('/api/v1/sensors/enroll', async (request, response) => {
    const input = request.body || {};
    const tokenHash = hashSecret(String(input.enrollmentToken || ''));
    const enrollment = (await store.read('sensorEnrollmentTokens')).find((candidate) => safeEqual(candidate.tokenHash, tokenHash));
    if (!enrollment || enrollment.usedAt || Date.parse(enrollment.expiresAt) <= Date.now()) {
      return response.status(401).json({ error: 'Enrollment token is invalid, expired, or already used' });
    }
    request.organization = { id: enrollment.organizationId };

    const requestedId = input.sensorId ? String(input.sensorId) : '';
    if (requestedId && !/^[a-zA-Z0-9._-]{3,64}$/.test(requestedId)) {
      return response.status(400).json({ error: 'sensorId must be 3-64 letters, numbers, dots, dashes, or underscores' });
    }
    const sensorId = requestedId || `sen-${crypto.randomUUID().slice(0, 10)}`;
    if ((await store.read('sensors')).some((candidate) => candidate.id === sensorId)) {
      return response.status(409).json({ error: 'A sensor with this ID already exists' });
    }

    const accessToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const scope = { organizationId: enrollment.organizationId };
    const sensor = await store.add('sensors', {
      id: sensorId,
      name: String(input.name || enrollment.label || sensorId).slice(0, 100),
      type: 'projection',
      version: String(input.version || 'dev').slice(0, 30),
      platform: String(input.platform || 'unknown').slice(0, 50),
      capabilities: Array.isArray(input.capabilities) ? input.capabilities.slice(0, 30) : [],
      health: 100,
      latency: 0,
      address: request.ip,
      lastSeen: 'now',
      lastSeenAt: now,
      enrolledAt: now,
      status: 'online',
      decoyCount: 0,
      accessTokenHash: hashSecret(accessToken),
    }, scope);
    await store.update('sensorEnrollmentTokens', enrollment.id, { usedAt: now, sensorId }, scope);

    response.status(201).json({
      sensor: publicSensor(sensor),
      accessToken,
      commandSigningKey: deriveCommandKey(sensorId).toString('base64url'),
      pollIntervalSeconds: 10,
    });
  });

  app.post('/api/v1/sensors/:sensorId/heartbeat', requireSensor, async (request, response) => {
    const now = new Date().toISOString();
    const decoys = Array.isArray(request.body?.decoys) ? request.body.decoys.slice(0, 500) : [];
    const scope = { organizationId: request.sensor.organizationId };
    const sensor = await store.update('sensors', request.params.sensorId, {
      health: Math.min(Math.max(Number(request.body?.health ?? 100), 0), 100),
      latency: Math.max(Number(request.body?.latency ?? 0), 0),
      version: String(request.body?.version || request.sensor.version).slice(0, 30),
      address: String(request.body?.address || request.ip).slice(0, 200),
      lastSeen: 'now',
      lastSeenAt: now,
      status: 'online',
      decoyCount: decoys.length,
      decoys,
    }, scope);
    const pendingCommands = await commandQueue.count(request.params.sensorId);
    response.json({ sensor: publicSensor(sensor), controllerTime: now, pendingCommands });
  });

  app.get('/api/v1/sensors/:sensorId/commands', requireSensor, async (request, response) => {
    await commandScheduler.runOnce();
    const commands = await commandQueue.dispatch(request.params.sensorId);
    response.json({ items: commands });
  });

  app.post('/api/v1/sensors/:sensorId/commands', requirePermission('sensor:write'), async (request, response) => {
    const result = await createSensorCommand(store, commandQueue, request.params.sensorId, request.body, organizationScope(request));
    if (result.error) return response.status(result.status).json({ error: result.error });
    response.status(201).json(result.command);
  });

  app.post('/api/v1/sensors/:sensorId/commands/:commandId/ack', requireSensor, async (request, response) => {
    const scope = { organizationId: request.sensor.organizationId };
    const command = (await store.read('sensorCommands', scope)).find((candidate) => candidate.id === request.params.commandId && candidate.sensorId === request.params.sensorId);
    if (!command) return response.status(404).json({ error: 'Command not found' });
    const status = request.body?.status === 'failed' ? 'failed' : 'acknowledged';
    const error = status === 'failed' ? String(request.body?.error || 'Sensor command failed').slice(0, 1000) : null;
    const updated = status === 'failed'
      ? await commandQueue.fail(command, error)
      : await store.update('sensorCommands', command.id, {
        status,
        acknowledgedAt: new Date().toISOString(),
        output: request.body?.output || null,
        error,
      }, scope);
    if (status === 'acknowledged') await commandQueue.acknowledge(request.params.sensorId, command.id);
    response.json(updated);
  });

  app.post('/api/v1/sensors/:sensorId/events', requireSensor, async (request, response) => {
    const input = request.body || {};
    const protocol = allowedEventProtocols.has(input.protocol) ? input.protocol : 'tcp';
    if (!input.decoyId || !input.source) {
      return response.status(400).json({ error: 'decoyId and source are required' });
    }
    const timestamp = new Date().toISOString();
    const scope = { organizationId: request.sensor.organizationId };
    const event = await store.add('sensorEvents', {
      id: `evt-${crypto.randomUUID().slice(0, 12)}`,
      sensorId: request.params.sensorId,
      decoyId: String(input.decoyId).slice(0, 100),
      decoyName: String(input.decoyName || input.decoyId).slice(0, 150),
      protocol,
      source: String(input.source).slice(0, 200),
      destination: String(input.destination || '').slice(0, 200),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      timestamp,
    }, scope);
    const incident = await store.add('incidents', {
      id: `INC-${crypto.randomInt(3000, 9999)}`,
      severity: 'high',
      title: `${protocol.toUpperCase()} interaction with projected decoy ${event.decoyName}`,
      source: event.source,
      target: event.decoyName,
      technique: techniqueFor(protocol),
      confidence: 99,
      status: 'new',
      age: 'now',
      timestamp,
      summary: `Projection sensor ${request.sensor.name} observed an unauthorized ${protocol.toUpperCase()} interaction with a deception service.`,
      steps: ['Connection accepted by decoy', 'Protocol metadata captured', 'High-confidence incident opened'],
      sensorId: request.params.sensorId,
      eventId: event.id,
    }, scope);
    response.status(201).json({ event, incident });
  });
}
