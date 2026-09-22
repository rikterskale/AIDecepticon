// @vitest-environment node
import crypto from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { HaCoordinator } from './ha.js';
import { SensorCommandQueue } from './command-queue.js';
import { PostgresStore } from './store.js';

const { Pool } = pg;

describe('HA coordinator', () => {
  it('guides a single controller through drain and resume', async () => {
    const coordinator = new HaCoordinator({ mode: 'json' }, {
      CONTROLLER_INSTANCE_ID: 'controller-test-1',
      CONTROLLER_ZONE: 'test-zone',
    });

    await coordinator.init();
    expect(coordinator.health()).toMatchObject({ healthy: true, ready: true, leader: true, mode: 'single-instance' });
    expect(await coordinator.topology()).toEqual([expect.objectContaining({ instanceId: 'controller-test-1', status: 'online', current: true, leader: true })]);

    await coordinator.setDraining(true);
    expect(coordinator.health()).toMatchObject({ healthy: true, ready: false, leader: false, state: 'draining' });
    expect(await coordinator.topology()).toEqual([expect.objectContaining({ status: 'draining', leader: false })]);

    await coordinator.setDraining(false);
    expect(coordinator.health()).toMatchObject({ ready: true, leader: true, state: 'ready' });
    await coordinator.close();
    expect(coordinator.health()).toMatchObject({ healthy: false, ready: false });
  });

  it('rejects unsafe controller instance identifiers', () => {
    expect(() => new HaCoordinator({ mode: 'json' }, { CONTROLLER_INSTANCE_ID: 'invalid controller/id' })).toThrow(/unsupported characters/);
  });
});

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

describePostgres('PostgreSQL HA coordination', () => {
  it('elects one leader and transfers leadership when that replica drains', async () => {
    const schema = `ha_${crypto.randomUUID().replaceAll('-', '')}`;
    const lockId = 1_000_000 + crypto.randomInt(1_000_000_000);
    const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined });
    const isolatedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 6,
      options: `-c search_path=${schema}`,
      ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
    });
    const store = new PostgresStore(process.env.DATABASE_URL, { pool: isolatedPool });
    let first;
    let second;

    try {
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      await store.init();
      const sharedEnvironment = {
        HA_LEADER_LOCK_ID: String(lockId),
        HA_HEARTBEAT_INTERVAL_MS: '60000',
        HA_STALE_AFTER_MS: '120000',
      };
      first = new HaCoordinator(store, { ...sharedEnvironment, CONTROLLER_INSTANCE_ID: 'controller-a', CONTROLLER_ZONE: 'zone-a' });
      second = new HaCoordinator(store, { ...sharedEnvironment, CONTROLLER_INSTANCE_ID: 'controller-b', CONTROLLER_ZONE: 'zone-b' });
      await first.init();
      await second.init();

      expect([first.leader, second.leader].filter(Boolean)).toHaveLength(1);
      const originalLeader = first.leader ? first : second;
      const follower = first.leader ? second : first;
      expect(await first.topology()).toEqual(expect.arrayContaining([
        expect.objectContaining({ instanceId: 'controller-a', status: 'online' }),
        expect.objectContaining({ instanceId: 'controller-b', status: 'online' }),
      ]));

      await originalLeader.setDraining(true);
      await follower.runOnce();
      expect(originalLeader.health()).toMatchObject({ ready: false, leader: false, state: 'draining' });
      expect(follower.health()).toMatchObject({ ready: true, leader: true, state: 'ready' });
      expect((await follower.topology()).filter((instance) => instance.leader)).toEqual([
        expect.objectContaining({ instanceId: follower.instanceId, status: 'online' }),
      ]);

      await store.add('sensorCommands', {
        id: 'cmd-ha-claim',
        sensorId: 'sensor-ha',
        type: 'snapshot',
        payload: {},
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nextAttemptAt: new Date(Date.now() - 500).toISOString(),
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        retryBackoffSeconds: 5,
        organizationId: 'org-default',
      });
      const firstQueue = new SensorCommandQueue(store);
      const secondQueue = new SensorCommandQueue(store);
      const deliveries = (await Promise.all([firstQueue.dispatch('sensor-ha'), secondQueue.dispatch('sensor-ha')])).flat();
      expect(deliveries).toEqual([expect.objectContaining({ id: 'cmd-ha-claim', status: 'dispatched', attempts: 1 })]);
      expect((await store.read('sensorCommands')).find((command) => command.id === 'cmd-ha-claim')).toMatchObject({ status: 'dispatched', attempts: 1 });
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);
      await store.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  });
});
