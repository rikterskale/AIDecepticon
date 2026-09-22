import { createClient } from 'redis';

const deliverableStatuses = new Set(['queued', 'retrying']);

function timestamp(value, fallback = 0) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function availableAt(command) {
  return timestamp(command.nextAttemptAt, timestamp(command.issuedAt));
}

function retryDelayMilliseconds(command) {
  const attempt = Math.max(Number(command.attempts || 1), 1);
  const baseSeconds = Math.min(Math.max(Number(command.retryBackoffSeconds || 15), 5), 300);
  return Math.min(baseSeconds * (2 ** (attempt - 1)), 900) * 1_000;
}

function isDeliverable(command, now = Date.now()) {
  return deliverableStatuses.has(command.status)
    && timestamp(command.expiresAt) > now
    && availableAt(command) <= now;
}

async function deliverableFromStore(store, sensorId, now = Date.now()) {
  const commands = await store.read('sensorCommands');
  return commands.filter((command) => command.sensorId === sensorId && isDeliverable(command, now));
}

export class SensorCommandQueue {
  constructor(store, options = {}) {
    this.store = store;
    this.url = options.url;
    this.prefix = options.prefix || 'aidecepticon';
    this.mode = this.url ? 'redis' : 'store';
    this.client = options.client || (this.url ? createClient({
      url: this.url,
      socket: {
        reconnectStrategy: (retries) => retries > 5 ? new Error('Redis reconnect limit reached') : Math.min(100 * (retries + 1), 1_000),
      },
    }) : null);
    this.logger = options.logger || console;
    this.client?.on('error', (error) => this.logger.error(`Redis command queue error: ${error.message}`));
  }

  queueKey(sensorId) {
    return `${this.prefix}:sensor:${sensorId}:queue`;
  }

  commandsKey(sensorId) {
    return `${this.prefix}:sensor:${sensorId}:commands`;
  }

  async init() {
    if (this.client && !this.client.isOpen) await this.client.connect();
  }

  async enqueue(command) {
    if (!this.client?.isReady) return;
    try {
      await this.client.multi()
        .hSet(this.commandsKey(command.sensorId), command.id, JSON.stringify(command))
        .zAdd(this.queueKey(command.sensorId), [{ score: availableAt(command), value: command.id }])
        .exec();
    } catch (error) {
      this.logger.error(`Redis enqueue failed for ${command.id}: ${error.message}`);
    }
  }

  async remove(sensorId, commandId) {
    if (!this.client?.isReady) return;
    try {
      await this.client.multi()
        .zRem(this.queueKey(sensorId), commandId)
        .hDel(this.commandsKey(sensorId), commandId)
        .exec();
    } catch (error) {
      this.logger.error(`Redis removal failed for ${commandId}: ${error.message}`);
    }
  }

  async pending(sensorId) {
    const now = Date.now();
    const durable = await deliverableFromStore(this.store, sensorId, now);
    if (!this.client?.isReady) return durable;
    try {
      const queueKey = this.queueKey(sensorId);
      const commandsKey = this.commandsKey(sensorId);
      const dueIds = await this.client.zRangeByScore(queueKey, 0, now);
      const payloads = dueIds.length ? await this.client.hmGet(commandsKey, dueIds) : [];
      const durableById = new Map(durable.map((command) => [command.id, command]));
      const queued = payloads
        .filter(Boolean)
        .map((payload) => JSON.parse(payload))
        .map((command) => durableById.get(command.id))
        .filter(Boolean);
      const known = new Set(queued.map((command) => command.id));
      const missing = durable.filter((command) => !known.has(command.id));
      await Promise.all(missing.map((command) => this.enqueue(command)));
      return [...queued, ...missing].sort((left, right) => left.issuedAt.localeCompare(right.issuedAt));
    } catch (error) {
      this.logger.error(`Redis poll failed for sensor ${sensorId}: ${error.message}`);
      return durable;
    }
  }

  async dispatch(sensorId) {
    if (typeof this.store.claimSensorCommands === 'function') {
      const now = Date.now();
      const claimed = await this.store.claimSensorCommands(
        sensorId,
        [...deliverableStatuses],
        (command) => isDeliverable(command, now),
        (command) => {
          const attempts = Number(command.attempts || 0) + 1;
          const dispatchedAt = new Date(now);
          return {
            status: 'dispatched',
            attempts,
            lastDispatchedAt: dispatchedAt.toISOString(),
            nextAttemptAt: new Date(now + retryDelayMilliseconds({ ...command, attempts })).toISOString(),
          };
        },
      );
      await Promise.all(claimed.map((command) => this.remove(sensorId, command.id)));
      return claimed;
    }
    const commands = await this.pending(sensorId);
    const dispatched = [];
    for (const command of commands) {
      const attempts = Number(command.attempts || 0) + 1;
      const now = new Date();
      const updated = await this.store.update('sensorCommands', command.id, {
        status: 'dispatched',
        attempts,
        lastDispatchedAt: now.toISOString(),
        nextAttemptAt: new Date(now.getTime() + retryDelayMilliseconds({ ...command, attempts })).toISOString(),
      });
      await this.remove(sensorId, command.id);
      if (updated) dispatched.push(updated);
    }
    return dispatched;
  }

  async fail(command, errorMessage) {
    const attempts = Number(command.attempts || 0);
    const maxAttempts = Number(command.maxAttempts || 3);
    if (attempts >= maxAttempts || timestamp(command.expiresAt) <= Date.now()) {
      const changes = {
        status: 'dead_lettered',
        deadLetteredAt: new Date().toISOString(),
        deadLetterReason: attempts >= maxAttempts ? 'attempt_limit' : 'expired',
        error: errorMessage,
      };
      const dead = typeof this.store.updateIfStatus === 'function'
        ? await this.store.updateIfStatus('sensorCommands', command.id, ['dispatched', 'retrying'], changes)
        : await this.store.update('sensorCommands', command.id, changes);
      if (dead) await this.remove(command.sensorId, command.id);
      return dead;
    }
    const changes = {
      status: 'retrying',
      error: errorMessage,
      nextAttemptAt: command.nextAttemptAt || new Date(Date.now() + retryDelayMilliseconds(command)).toISOString(),
    };
    const retrying = typeof this.store.updateIfStatus === 'function'
      ? await this.store.updateIfStatus('sensorCommands', command.id, ['dispatched', 'retrying'], changes)
      : await this.store.update('sensorCommands', command.id, changes);
    if (retrying) await this.enqueue(retrying);
    return retrying;
  }

  async acknowledge(sensorId, commandId) {
    await this.remove(sensorId, commandId);
  }

  async count(sensorId) {
    return (await this.pending(sensorId)).length;
  }

  async health() {
    if (!this.client) return { healthy: true, mode: this.mode };
    try {
      return { healthy: await this.client.ping() === 'PONG', mode: this.mode };
    } catch (error) {
      return { healthy: false, mode: this.mode, error: error.message };
    }
  }

  async close() {
    if (this.client?.isOpen) await this.client.quit();
  }
}

export class CommandScheduler {
  constructor(store, commandQueue, options = {}) {
    this.store = store;
    this.commandQueue = commandQueue;
    const configuredInterval = Number(options.intervalMilliseconds || 5_000);
    this.intervalMilliseconds = Number.isFinite(configuredInterval) ? Math.max(configuredInterval, 1_000) : 5_000;
    this.logger = options.logger || console;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const commands = await this.store.read('sensorCommands');
      for (const command of commands) {
        if (['queued', 'retrying', 'dispatched'].includes(command.status) && timestamp(command.expiresAt) <= now) {
          const changes = {
            status: 'dead_lettered',
            deadLetteredAt: new Date(now).toISOString(),
            deadLetterReason: 'expired',
            error: command.error || 'Command expired before acknowledgement',
          };
          const expired = typeof this.store.updateIfStatus === 'function'
            ? await this.store.updateIfStatus('sensorCommands', command.id, ['queued', 'retrying', 'dispatched'], changes)
            : await this.store.update('sensorCommands', command.id, changes);
          if (expired) await this.commandQueue.remove(command.sensorId, command.id);
          continue;
        }
        if (command.status !== 'dispatched' || timestamp(command.nextAttemptAt, Number.POSITIVE_INFINITY) > now) continue;
        await this.commandQueue.fail(command, command.error || 'Sensor did not acknowledge the command before the delivery timeout');
      }
      this.lastRunAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      this.logger.error(`Command scheduler failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMilliseconds);
    this.timer.unref?.();
  }

  health() {
    return {
      healthy: !this.lastError,
      mode: 'scheduled',
      active: Boolean(this.timer),
      lastRunAt: this.lastRunAt,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createCommandQueue(store, environment = process.env) {
  return new SensorCommandQueue(store, { url: environment.REDIS_URL, prefix: environment.REDIS_PREFIX });
}

export function createCommandScheduler(store, commandQueue, environment = process.env) {
  return new CommandScheduler(store, commandQueue, { intervalMilliseconds: environment.COMMAND_SCHEDULER_INTERVAL_MS });
}
