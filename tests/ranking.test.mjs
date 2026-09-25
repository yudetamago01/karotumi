import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:5173';

test('solo ranking rejects direct counts and records only a replayed game', async () => {
  const name = `ランキング試験${Date.now()}`;
  const login = await fetch(`${base}/auth/dev`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(`${base}/api/solo/start`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 1440, height: 900 }),
  });
  assert.equal(denied.status, 401);
  const forged = await fetch(`${base}/api/ranking`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ count: 9999 }),
  });
  assert.equal(forged.status, 405);
  const started = await fetch(`${base}/api/solo/start`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ width: 1440, height: 900 }),
  });
  assert.equal(started.status, 201);
  const { id: runId, pieces } = await started.json();
  assert.ok(runId && pieces.length >= 150);
  const submitted = await fetch(`${base}/api/solo/finish`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ runId, count: 9999, events: [
      { type: 'drop', wait: 0, x: 960, angle: 0 },
      { type: 'drop', wait: 260, x: 20, angle: 0 },
    ], endWait: 330 }),
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(await submitted.json(), { bestCount: 1, updated: true });
  const response = await fetch(`${base}/api/ranking`);
  assert.equal(response.status, 200);
  const { scores } = await response.json();
  assert.ok(scores.some(score => score.name === name && score.bestCount === 1));
});

test('solo ranking rejects an unfinished replay', async () => {
  const login = await fetch(`${base}/auth/dev`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `未完了試験${Date.now()}` }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const started = await fetch(`${base}/api/solo/start`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ width: 1440, height: 900 }),
  });
  assert.equal(started.status, 201);
  const { id: runId } = await started.json();
  const response = await fetch(`${base}/api/solo/finish`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ runId, count: 9999, events: [
      { type: 'drop', wait: 0, x: 960, angle: 0 },
    ], endWait: 500 }),
  });
  assert.equal(response.status, 400);
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

test('an improvement is visible right away even if a list read was in flight', async () => {
  const previousLogin = process.env.DEV_LOGIN;
  const previousEnv = process.env.NODE_ENV;
  process.env.DEV_LOGIN = '1';
  process.env.NODE_ENV = 'development';
  try {
    const { leaderboard, submitScore, bestCount } = await import('../server/ranking.js');
    const user = { id: 'rank-cache', name: 'Cache', avatar: null };
    await submitScore(user, 3);
    await leaderboard();
    // Another player improves while this process may still hold a short cache.
    const other = { id: 'rank-cache-2', name: 'Other', avatar: null };
    await submitScore(other, 12);
    const scores = await leaderboard();
    assert.ok(scores.some(score => score.userId === other.id && score.bestCount === 12),
      'a new best from another user is not stuck behind a stale cache');
    assert.ok(scores.some(score => score.userId === user.id && score.bestCount === 3),
      'existing lower scores stay on the board');
    assert.equal(await bestCount(user.id), 3, 'a personal best is readable even outside the top 20');
    assert.equal(await bestCount('missing-user'), 0);
  } finally {
    if (previousLogin === undefined) delete process.env.DEV_LOGIN;
    else process.env.DEV_LOGIN = previousLogin;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});

test('recovery raises a missing best but never lowers an existing one', async () => {
  const previousLogin = process.env.DEV_LOGIN;
  const previousEnv = process.env.NODE_ENV;
  process.env.DEV_LOGIN = '1';
  process.env.NODE_ENV = 'development';
  try {
    const { recoverBest, bestCount } = await import('../server/ranking.js');
    const user = { id: 'rank-recover', name: 'Recover', avatar: null };
    const raised = await recoverBest(user, 21);
    assert.equal(raised.recovered, true);
    assert.equal(raised.bestCount, 21);
    assert.equal(await bestCount(user.id), 21);
    const kept = await recoverBest(user, 8);
    assert.equal(kept.recovered, false);
    assert.equal(kept.bestCount, 21, 'lower recovery claims cannot shrink the board');
    await assert.rejects(recoverBest(user, 0), /1〜10000/);
  } finally {
    if (previousLogin === undefined) delete process.env.DEV_LOGIN;
    else process.env.DEV_LOGIN = previousLogin;
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});
