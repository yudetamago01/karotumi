import test from 'node:test';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3001';
const origin = 'http://127.0.0.1:5173';

test('solo ranking requires login and records a player best', async () => {
  const name = `ランキング試験${Date.now()}`;
  const login = await fetch(`${base}/auth/dev`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(`${base}/api/ranking`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 4 }),
  });
  assert.equal(denied.status, 401);
  const submitted = await fetch(`${base}/api/ranking`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ count: 4 }),
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(await submitted.json(), { bestCount: 4, updated: true });
  const response = await fetch(`${base}/api/ranking`);
  assert.equal(response.status, 200);
  const { scores } = await response.json();
  assert.ok(scores.some(score => score.name === name && score.bestCount === 4));
});

test('a lower solo score cannot replace the best', async () => {
  const previous = process.env.DEV_LOGIN;
  process.env.DEV_LOGIN = '1';
  try {
    const { submitScore } = await import('../server/ranking.js');
    const user = { id: 'rank-unit', name: 'Player', avatar: null };
    assert.deepEqual(await submitScore(user, 9), { bestCount: 9, updated: true });
    assert.deepEqual(await submitScore(user, 2), { bestCount: 9, updated: false });
    await assert.rejects(submitScore(user, 0), /1〜10000/);
  } finally {
    if (previous === undefined) delete process.env.DEV_LOGIN;
    else process.env.DEV_LOGIN = previous;
  }
});
