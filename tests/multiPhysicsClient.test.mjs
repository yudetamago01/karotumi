import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiPhysicsClient } from '../src/multiPhysicsClient.js';
import { stageGeometry } from '../src/stageGeometry.js';

test('a drop is visible immediately and stale worker frames cannot move it backwards', () => {
  const originalWorker = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() { this.messages = []; worker = this; }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  try {
    const geometry = stageGeometry(390, 700);
    const client = new MultiPhysicsClient(geometry);
    client.sync({ phase: 'playing', pieces: [], activeId: null, currentPlayerId: 'a', term: 'RK', turnDeadline: 1000 });
    const olderEpoch = worker.messages.at(-1).epoch;
    const predicted = client.predict('RK', 'a', geometry.width / 2, geometry.spawnTop, 0);
    assert.ok(client.pose(predicted.id), 'the drop is drawn before a worker or server reply');
    worker.onmessage({ data: { epoch: olderEpoch, poses: [[predicted.id, 9999, 9999, 0, 0, 0, 0]] } });
    assert.ok(client.pose(predicted.id).x < geometry.width, 'an older worker frame is ignored');
    worker.onmessage({ data: { epoch: worker.messages.at(-1).epoch,
      poses: [[predicted.id, predicted.x, predicted.y + 12, 0, 0, 0, 0]] } });
    assert.ok(client.pose(predicted.id).y > predicted.y);
    client.dispose();
    assert.equal(worker.terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
