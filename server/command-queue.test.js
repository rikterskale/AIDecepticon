// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CommandScheduler, SensorCommandQueue } from './command-queue.js';

class MemoryStore {
  constructor(commands) {
    this.commands = commands;
  }

  async read() {
    return structuredClone(this.commands);
  }

  async update(_resource, id, changes) {
    const index = this.commands.findIndex((command) => command.id === id);
    if (index === -1) return null;
    this.commands[index] = { ...this.commands[index], ...changes };
    return structuredClone(this.commands[index]);
  }
}

function command(overrides = {}) {
  return {
    id: 'cmd-test',
    sensorId: 'sen-test',
    type: 'snapshot',
    payload: {},
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'dispatched',
    attempts: 1,
    maxAttempts: 2,
    retryBackoffSeconds: 5,
    nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    ...overrides,
  };
}

describe('sensor command scheduler', () => {
  it('requeues an unacknowledged delivery and dead-letters it after the attempt limit', async () => {
    const store = new MemoryStore([command()]);
    const queue = new SensorCommandQueue(store);
    const scheduler = new CommandScheduler(store, queue);

    await scheduler.runOnce();
    expect(store.commands[0].status).toBe('retrying');

    const delivery = await queue.dispatch('sen-test');
    expect(delivery[0]).toMatchObject({ status: 'dispatched', attempts: 2 });
    await store.update('sensorCommands', 'cmd-test', { nextAttemptAt: new Date(Date.now() - 1_000).toISOString() });
    await scheduler.runOnce();
    expect(store.commands[0]).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'attempt_limit' });
  });

  it('dead-letters commands that expire before delivery', async () => {
    const store = new MemoryStore([command({
      status: 'queued',
      attempts: 0,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })]);
    const queue = new SensorCommandQueue(store);
    const scheduler = new CommandScheduler(store, queue);

    await scheduler.runOnce();
    expect(store.commands[0]).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'expired' });
  });

  it('reports whether leader-only recovery scheduling is active', () => {
    const store = new MemoryStore([]);
    const scheduler = new CommandScheduler(store, new SensorCommandQueue(store));
    expect(scheduler.health()).toMatchObject({ healthy: true, active: false });
    scheduler.start();
    expect(scheduler.health()).toMatchObject({ healthy: true, active: true });
    scheduler.close();
    expect(scheduler.health()).toMatchObject({ healthy: true, active: false });
  });
});
