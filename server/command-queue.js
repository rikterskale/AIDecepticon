import { createClient } from 'redis';

function pendingFromStore(store, sensorId) {
  return store.read('sensorCommands').then((commands) => commands.filter((command) => (
    command.sensorId === sensorId
    && command.status === 'queued'
    && Date.parse(command.expiresAt) > Date.now()
  )));
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
        .zAdd(this.queueKey(command.sensorId), [{ score: Date.parse(command.expiresAt), value: command.id }])
        .exec();
    } catch (error) {
      this.logger.error(`Redis enqueue failed for ${command.id}: ${error.message}`);
    }
  }

  async pending(sensorId) {
    const durable = await pendingFromStore(this.store, sensorId);
    if (!this.client?.isReady) return durable;
    try {
      const queueKey = this.queueKey(sensorId);
      const commandsKey = this.commandsKey(sensorId);
      const expired = await this.client.zRangeByScore(queueKey, 0, Date.now());
      if (expired.length) {
        await this.client.multi().zRem(queueKey, expired).hDel(commandsKey, expired).exec();
      }

      const queuedIds = await this.client.zRangeByScore(queueKey, Date.now(), '+inf');
      const queuedPayloads = queuedIds.length ? await this.client.hmGet(commandsKey, queuedIds) : [];
      const queued = queuedPayloads.filter(Boolean).map((payload) => JSON.parse(payload));
      const known = new Set(queued.map((command) => command.id));
      const missing = durable.filter((command) => !known.has(command.id));
      await Promise.all(missing.map((command) => this.enqueue(command)));
      return [...queued, ...missing].sort((left, right) => left.issuedAt.localeCompare(right.issuedAt));
    } catch (error) {
      this.logger.error(`Redis poll failed for sensor ${sensorId}: ${error.message}`);
      return durable;
    }
  }

  async acknowledge(sensorId, commandId) {
    if (!this.client?.isReady) return;
    try {
      await this.client.multi()
        .zRem(this.queueKey(sensorId), commandId)
        .hDel(this.commandsKey(sensorId), commandId)
        .exec();
    } catch (error) {
      this.logger.error(`Redis acknowledgement failed for ${commandId}: ${error.message}`);
    }
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

export function createCommandQueue(store, environment = process.env) {
  return new SensorCommandQueue(store, { url: environment.REDIS_URL, prefix: environment.REDIS_PREFIX });
}
