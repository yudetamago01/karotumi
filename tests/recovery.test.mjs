import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('a saved match resumes in the waiting room after a server restart', async () => {
  let savedState;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify([{
        id: 'AABBCCDD', password_hash: null,
        state: {
          phase: 'playing', hostId: 'a',
          members: [
            { id: 'a', name: 'A', status: 'playing' },
            { id: 'b', name: 'B', status: 'eliminated' },
          ],
          order: ['a', 'b'], turnIndex: 1, term: 'テスト',
          turnDeadline: Date.now() - 60_000, spawnY: -200,
          winnerId: null, pieces: [{ id: 'old-piece' }], messages: [],
        },
      }]));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    savedState = JSON.parse(body).state;
    response.end('');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key';
  try {
    const { getRoom, persist } = await import('../server/rooms.js');
    const room = await getRoom('AABBCCDD');
    assert.equal(room.phase, 'lobby');
    assert.equal(room.term, null);
    assert.equal(room.turnDeadline, 0);
    assert.equal(room.pieces.length, 0);
    assert.deepEqual(room.order, ['a', 'b']);
    assert.equal(room.members.get('b').status, 'playing');
    await persist(room);
    assert.equal(savedState.phase, 'lobby');
    assert.deepEqual(savedState.pieces, []);
  } finally {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    await new Promise(resolve => server.close(resolve));
  }
});
