import test from 'node:test';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3001';
const origin = 'http://127.0.0.1:5173';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...options.headers },
  });
  return { response, data: await response.json() };
}

async function login(name) {
  const { response, data } = await request('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) });
  assert.equal(response.status, 200);
  return { user: data.user, cookie: response.headers.get('set-cookie').split(';')[0] };
}

test('two players join, start, chat, and receive room events', async () => {
  const a = await login('テストA');
  const b = await login('テストB');
  const c = await login('観戦C');
  const created = await request('/api/rooms', { method: 'POST', headers: { Cookie: a.cookie }, body: JSON.stringify({ password: 'ひみつ' }) });
  assert.equal(created.response.status, 201);
  const id = created.data.room.id;
  assert.match(id, /^[A-F0-9]{8}$/);
  assert.equal(created.data.room.leaderId, a.user.id);
  assert.equal(created.data.room.members[0].avatar, null);

  const denied = await request(`/api/rooms/${id}/join`, { method: 'POST', headers: { Cookie: b.cookie }, body: JSON.stringify({ password: 'bad' }) });
  assert.equal(denied.response.status, 400);

  const joined = await request(`/api/rooms/${id}/join`, { method: 'POST', headers: { Cookie: b.cookie }, body: JSON.stringify({ password: 'ひみつ' }) });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.data.room.members.filter(m => m.status === 'playing').length, 2);

  const started = await request(`/api/rooms/${id}/start`, { method: 'POST', headers: { Cookie: a.cookie }, body: '{}' });
  assert.equal(started.response.status, 200);
  assert.equal(started.data.room.phase, 'playing');
  assert.ok(started.data.room.turnDeadline > Date.now());

  const midgame = await request(`/api/rooms/${id}/join`, { method: 'POST', headers: { Cookie: c.cookie }, body: JSON.stringify({ password: 'ひみつ' }) });
  assert.equal(midgame.response.status, 200);
  assert.equal(midgame.data.room.members.find(member => member.id === c.user.id).status, 'watching');

  const chat = await request(`/api/rooms/${id}/chat`, { method: 'POST', headers: { Cookie: b.cookie }, body: JSON.stringify({ body: 'よろしく！' }) });
  assert.equal(chat.response.status, 200);
  assert.equal(chat.data.room.messages.at(-1).body, 'よろしく！');

  const spectatorChat = await request(`/api/rooms/${id}/chat`, { method: 'POST', headers: { Cookie: c.cookie }, body: JSON.stringify({ body: '観戦します' }) });
  assert.equal(spectatorChat.response.status, 200);
  assert.equal(spectatorChat.data.room.messages.at(-1).user_id, c.user.id);

  const controller = new AbortController();
  const stream = await fetch(`${base}/api/rooms/${id}/events`, { headers: { Cookie: a.cookie, Origin: origin }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const first = await stream.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /event: state/);
  controller.abort();

  const ended = await request(`/api/rooms/${id}/leave`, { method: 'POST', headers: { Cookie: b.cookie }, body: '{}' });
  assert.equal(ended.response.status, 200);
  assert.equal(ended.data.room.phase, 'ended');
  await new Promise(resolve => setTimeout(resolve, 3_800));
  const lobby = await request(`/api/rooms/${id}`, { headers: { Cookie: a.cookie } });
  assert.equal(lobby.response.status, 200);
  assert.equal(lobby.data.room.phase, 'lobby');
  assert.equal(lobby.data.room.term, null);
});
