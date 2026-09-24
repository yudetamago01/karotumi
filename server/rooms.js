import crypto from 'node:crypto';
import Matter from 'matter-js';
import { createTermPicker } from '../src/termPicker.js';
import { makeCompoundTextBody } from '../src/physicsBody.js';
import { applyDropGravity, PHYSICS_STEP_MS } from '../src/dropMotion.js';
import { CANONICAL_SHAPES } from '../src/canonicalShapes.js';
import { stageGeometry } from '../src/stageGeometry.js';
import { isLost } from '../src/lossRules.js';

const { Engine, Bodies, Body, Composite, Events } = Matter;
const MAX_PLAYERS = 10;
const TURN_MS = 10_000;
const END_SCREEN_MS = 3_500;
const rooms = new Map();
let lastCleanup = 0;

function makeEngine(room) {
  const engine = Engine.create({ gravity: { x: 0, y: 1.15 }, enableSleeping: true });
  // Narrow glyph parts need the same solver precision as solo play. Matter
  // sleeps resting pieces naturally after their contacts have settled.
  engine.positionIterations = 10;
  engine.velocityIterations = 10;
  engine.constraintIterations = 4;
  const base = Bodies.rectangle(room.geometry.width / 2, room.geometry.baseY, room.geometry.baseWidth, 28, { isStatic: true, label: 'base', friction: 1.1 });
  Composite.add(engine.world, base);
  room.engine = engine;
  room.base = base;
  Events.on(engine, 'collisionStart', event => {
    if (!room.active) return;
    for (const pair of event.pairs) {
      const a = pair.bodyA.parent;
      const b = pair.bodyB.parent;
      const other = a === room.active.body ? b : b === room.active.body ? a : null;
      if (other && other !== room.active.body && room.active.body.position.y < other.position.y + 20) {
        room.active.landed = true;
        break;
      }
    }
  });
}

function makeBody(shape, x, y) {
  const body = makeCompoundTextBody(shape.rectangles, shape.width, shape.height, x, y);
  return { body, offsetX: x - body.position.x, offsetY: y - body.position.y };
}

function serialize(room) {
  return {
    id: room.id, phase: room.phase, hostId: room.hostId, leaderId: room.hostId,
    members: [...room.members.values()], order: room.order,
    turnIndex: room.turnIndex, term: room.term, turnDeadline: room.turnDeadline,
    spawnY: room.spawnY, geometry: room.geometry, winnerId: room.winnerId,
    activeId: room.active?.id || null, activeLanded: Boolean(room.active?.landed),
    pieces: room.pieces.map(p => ({
      id: p.id, term: p.term, ownerId: p.ownerId,
      x: p.body.position.x, y: p.body.position.y, angle: p.body.angle,
      vx: p.body.velocity.x, vy: p.body.velocity.y, va: p.body.angularVelocity,
      offsetX: p.offsetX, offsetY: p.offsetY,
    })),
    messages: room.messages.slice(-50),
  };
}

function storageState(room) {
  // A restarted server always returns a match to the lobby. Persist only
  // the data needed for that recovery, not the large physics masks/pile.
  return {
    phase: room.phase, hostId: room.hostId,
    members: [...room.members.values()], order: room.order,
    turnIndex: -1, term: null, turnDeadline: 0,
    spawnY: 160, winnerId: null, pieces: [],
    messages: room.messages.slice(-50),
  };
}

function hydrate(row) {
  const data = row.state;
  const room = {
    id: row.id, passwordHash: row.password_hash, phase: data.phase,
    hostId: data.hostId || data.leaderId, members: new Map((data.members || []).map(m => [m.id, { ...m, avatar: m.avatar || null }])),
    order: data.order, turnIndex: data.turnIndex, term: data.term,
    turnDeadline: data.turnDeadline, spawnY: data.spawnY,
    winnerId: data.winnerId, pieces: [], messages: data.messages || [], geometry: null, lastDropOwnerId: null,
    active: null, listeners: new Set(), dirty: false,
    lastPersist: Date.now(), persistChain: Promise.resolve(), resetTimer: null,
  };
  // A free Render service can restart while nobody is connected. The physics
  // clock did not run during that gap, so resume at the waiting room.
  if (room.phase !== 'lobby') resetToLobby(room);
  return room;
}

async function dbRequest(path, init = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

export function databaseReady() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function cleanupOldRooms() {
  if (!databaseReady() || Date.now() - lastCleanup < 86400_000) return;
  lastCleanup = Date.now();
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  await dbRequest(`karotter_stack_rooms?updated_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE' });
}

export async function persist(room) {
  if (!databaseReady()) return;
  room.lastPersistAttempt = Date.now();
  room.dirty = false;
  room.persistChain = room.persistChain.catch(() => {}).then(async () => {
    try {
      await dbRequest('karotter_stack_rooms?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ id: room.id, password_hash: room.passwordHash, state: storageState(room), updated_at: new Date().toISOString() }),
      });
      room.lastPersist = Date.now();
    } catch (error) {
      room.dirty = true;
      throw error;
    }
  });
  await room.persistChain;
}

export async function getRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  if (!databaseReady()) return null;
  const rows = await dbRequest(`karotter_stack_rooms?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!rows?.length) return null;
  const room = hydrate(rows[0]);
  rooms.set(id, room);
  return room;
}

function passwordDigest(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function passwordMatches(password, digest) {
  if (!digest) return true;
  const [salt, hash] = digest.split(':');
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function createRoom(user, password = '') {
  cleanupOldRooms().catch(error => console.error('Room cleanup:', error.message));
  const id = crypto.randomBytes(4).toString('hex').toUpperCase();
  const room = {
    id, passwordHash: password ? passwordDigest(password) : null,
    phase: 'lobby', hostId: user.id,
    members: new Map([[user.id, { id: user.id, name: user.name, avatar: user.avatar || null, status: 'playing' }]]),
    order: [user.id], turnIndex: -1, term: null, turnDeadline: 0,
    spawnY: 160, winnerId: null, pieces: [], messages: [], geometry: null, lastDropOwnerId: null,
    active: null, listeners: new Set(), dirty: true, resetTimer: null,
    lastPersist: 0, persistChain: Promise.resolve(),
  };
  rooms.set(id, room);
  await persist(room);
  return room;
}

export function joinRoom(room, user, password = '') {
  const previous = room.members.get(user.id);
  if (!previous) {
    if (!passwordMatches(password, room.passwordHash)) throw new Error('パスワードが違います');
    if ([...room.members.values()].filter(m => m.status !== 'left').length >= MAX_PLAYERS) throw new Error('ルームは満員です');
    const status = room.phase === 'lobby' ? 'playing' : 'watching';
    room.members.set(user.id, { id: user.id, name: user.name, avatar: user.avatar || null, status });
    if (status === 'playing') room.order.push(user.id);
  } else if (previous.status === 'left') {
    if (!passwordMatches(password, room.passwordHash)) throw new Error('パスワードが違います');
    previous.status = room.phase === 'lobby' ? 'playing' : 'watching';
    previous.avatar = user.avatar || previous.avatar || null;
    if (previous.status === 'playing' && !room.order.includes(user.id)) room.order.push(user.id);
  }
  publish(room);
  return room.members.get(user.id);
}

export function publicState(room, viewerId, includeMessages = true) {
  const data = serialize(room);
  delete data.order;
  if (!includeMessages) delete data.messages;
  return { ...data, currentPlayerId: room.order[room.turnIndex] || null, leaderId: room.hostId, viewerId };
}

export function publish(room) {
  room.dirty = true;
  const payload = `event: state\ndata: ${JSON.stringify(publicState(room, null, false))}\n\n`;
  for (const response of room.listeners) {
    try { response.write(payload); }
    catch { room.listeners.delete(response); }
  }
}

export function subscribe(room, response) {
  room.listeners.add(response);
  response.write(`event: state\ndata: ${JSON.stringify(publicState(room, null))}\n\n`);
  response.on('close', () => room.listeners.delete(response));
}

function broadcastTick(room, activeOnly = false) {
  const pieces = room.pieces.flatMap((p, index) => p.body.isSleeping || (activeOnly && p !== room.active) ? [] : [[
    index,
    Math.round(p.body.position.x * 10) / 10,
    Math.round(p.body.position.y * 10) / 10,
    Math.round(p.body.angle * 1000) / 1000,
  ]]);
  if (!pieces.length) return;
  const payload = `event: tick\ndata: ${JSON.stringify({
    pieces,
  })}\n\n`;
  for (const response of room.listeners) {
    try { response.write(payload); }
    catch { room.listeners.delete(response); }
  }
}

function finishIfOne(room) {
  const alive = room.order.filter(id => room.members.get(id)?.status === 'playing');
  if (alive.length <= 1) {
    room.phase = 'ended';
    room.winnerId = alive[0] || null;
    room.term = null;
    room.turnDeadline = 0;
    publish(room);
    scheduleLobbyReset(room);
    return true;
  }
  return false;
}

function resetToLobby(room) {
  if (room.phase === 'lobby') return;
  for (const member of room.members.values()) {
    if (member.status !== 'left') member.status = 'playing';
  }
  room.order = [...room.members.values()].filter(member => member.status !== 'left').map(member => member.id);
  if (!room.members.get(room.hostId) || room.members.get(room.hostId).status === 'left') {
    room.hostId = room.order[0] || null;
  }
  room.phase = 'lobby';
  room.turnIndex = -1;
  room.term = null;
  room.turnDeadline = 0;
  room.spawnY = 160;
  room.geometry = null;
  room.lastDropOwnerId = null;
  room.winnerId = null;
  room.pieces = [];
  room.active = null;
  room.engine = null;
  room.base = null;
  publish(room);
  persist(room).catch(error => console.error('Lobby reset:', error.message));
}

function scheduleLobbyReset(room) {
  if (room.resetTimer) return;
  room.resetTimer = setTimeout(() => {
    room.resetTimer = null;
    resetToLobby(room);
  }, END_SCREEN_MS);
  room.resetTimer.unref?.();
}

function chooseTurn(room) {
  if (finishIfOne(room)) return;
  for (let i = 0; i < room.order.length; i++) {
    room.turnIndex = (room.turnIndex + 1) % room.order.length;
    if (room.members.get(room.order[room.turnIndex])?.status === 'playing') break;
  }
  room.term = room.pickTerm();
  room.turnDeadline = Date.now() + TURN_MS;
  publish(room);
}

export function startRoom(room, user, viewport = {}) {
  if (room.phase !== 'lobby') throw new Error('すでに開始しています');
  if (room.hostId !== user.id) throw new Error('ルーム作成者だけが開始できます');
  if (room.order.length < 2) throw new Error('2人以上で開始できます');
  room.phase = 'playing';
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  // The leader's playable canvas sets the room's physics world. Every client
  // then observes the same authoritative pile, even on another screen size.
  room.geometry = stageGeometry(
    width >= 280 && width <= 3840 ? width : 1000,
    height >= 320 && height <= 2400 ? height : 700,
  );
  room.spawnY = Math.min(room.geometry.spawnTop, room.geometry.baseY - 100);
  room.lastDropOwnerId = null;
  room.physicsTime = performance.now();
  room.physicsAccumulator = 0;
  room.pickTerm = createTermPicker();
  makeEngine(room);
  chooseTurn(room);
}

export function acceptShape(room, shape) {
  // Older clients still send this request. Physics always uses the server's
  // canonical glyph mask, including when a turn expires while its owner is away.
  return room.phase === 'playing' && !room.active && shape?.term === room.term;
}

export function drop(room, userId, x, _shape, angle = 0) {
  if (room.phase !== 'playing' || room.active || room.order[room.turnIndex] !== userId) throw new Error('今はあなたの番ではありません');
  const selectedShape = CANONICAL_SHAPES[`t:${room.term}`] || CANONICAL_SHAPES[`e:${room.term}`];
  if (!selectedShape) throw new Error('用語の当たり判定が見つかりません');
  const safeAngle = Number.isFinite(angle) ? Math.max(-Math.PI * 2, Math.min(Math.PI * 2, angle)) : 0;
  const halfWidth = Math.abs(Math.cos(safeAngle)) * selectedShape.width / 2 + Math.abs(Math.sin(safeAngle)) * selectedShape.height / 2;
  const requestedX = Number(x);
  const center = Math.max(halfWidth + 6, Math.min(room.geometry.width - halfWidth - 6, Number.isFinite(requestedX) ? requestedX : room.geometry.width / 2));
  const item = makeBody(selectedShape, center, room.spawnY);
  Body.setAngle(item.body, safeAngle);
  const piece = {
    id: crypto.randomUUID(), term: room.term, ownerId: userId,
    shape: selectedShape, ...item, landed: false, landingTicks: 0, stableTicks: 0,
  };
  room.pieces.push(piece);
  room.active = piece;
  room.lastDropOwnerId = userId;
  Composite.add(room.engine.world, piece.body);
  room.turnDeadline = 0;
  publish(room);
}

function eliminate(room, userId) {
  const member = room.members.get(userId);
  if (!member || member.status !== 'playing') return;
  member.status = 'eliminated';
  if (room.active?.ownerId === userId) room.active = null;
  if (finishIfOne(room)) return;
  if (room.order[room.turnIndex] === userId && room.phase === 'playing') chooseTurn(room);
  publish(room);
}

export function chooseAfterLoss(room, userId, choice) {
  const member = room.members.get(userId);
  if (!member || member.status !== 'eliminated') throw new Error('選択できません');
  if (choice !== 'watching' && choice !== 'left') throw new Error('選択が正しくありません');
  member.status = choice;
  publish(room);
}

export function leaveRoom(room, userId) {
  const member = room.members.get(userId);
  if (!member) return;
  if (member.status === 'playing' && room.phase === 'playing') eliminate(room, userId);
  member.status = 'left';
  if (room.phase === 'lobby') {
    room.order = room.order.filter(id => id !== userId);
    if (room.hostId === userId) room.hostId = room.order[0] || null;
  }
  publish(room);
}

export async function addMessage(room, user, body) {
  const member = room.members.get(user.id);
  if (!member || member.status === 'left') throw new Error('ルームに参加してください');
  const message = { id: crypto.randomUUID(), room_id: room.id, user_id: user.id, name: user.name, avatar: user.avatar || member.avatar || null, body, created_at: new Date().toISOString() };
  room.messages.push(message);
  room.messages = room.messages.slice(-50);
  room.dirty = true;
  const payload = `event: chat\ndata: ${JSON.stringify(message)}\n\n`;
  for (const response of room.listeners) {
    try { response.write(payload); }
    catch { room.listeners.delete(response); }
  }
  return message;
}

function stepPhysics(room) {
  if (room.phase !== 'playing') return;
  if (!room.active && room.turnDeadline && Date.now() >= room.turnDeadline) {
    drop(room, room.order[room.turnIndex], room.geometry.width / 2);
  }
  if (room.active && !room.active.landed) applyDropGravity(room.active.body, room.engine.gravity);
  Engine.update(room.engine, PHYSICS_STEP_MS);
  if (room.active?.landed) {
    const piece = room.active;
    piece.landingTicks++;
    if (piece.body.speed < .65 && piece.body.angularSpeed < .025) piece.stableTicks++;
    else piece.stableTicks = 0;
    if (piece.landingTicks >= 30 && (piece.stableTicks >= 16 || piece.landingTicks >= 170)) {
      // Advancing the turn must not force this piece asleep while it still
      // has unresolved contacts with the letters below it.
      room.active = null;
      const highest = room.pieces.reduce((y, p) => Math.min(y, p.body.bounds.min.y), room.geometry.baseY);
      room.spawnY = Math.min(room.geometry.spawnTop, highest - 155);
      chooseTurn(room);
    }
  }
}

function checkLoss(room) {
  const fallen = room.pieces.find(piece => isLost(piece.body, room.base));
  if (!fallen) return;
  // A collapse belongs to the person whose drop caused it, even when an
  // older word is the first one to leave the plate. Start the next survivor
  // on a clear plate instead of leaving invisible/fallen supports behind.
  const loserId = room.active?.ownerId || room.lastDropOwnerId || fallen.ownerId;
  room.pieces = [];
  room.active = null;
  room.spawnY = room.geometry.spawnTop;
  room.lastDropOwnerId = null;
  makeEngine(room);
  eliminate(room, loserId);
}

export function advanceRoomPhysics(room, now = performance.now()) {
  if (room.phase !== 'playing') return;
  const delta = Math.min(40, Math.max(0, now - (room.physicsTime ?? now)));
  room.physicsTime = now;
  room.physicsAccumulator = Math.min(50, (room.physicsAccumulator || 0) + delta);
  while (room.phase === 'playing' && room.physicsAccumulator >= PHYSICS_STEP_MS) {
    stepPhysics(room);
    room.physicsAccumulator -= PHYSICS_STEP_MS;
    if (room.phase === 'playing') checkLoss(room);
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    try {
      if (room.phase === 'playing') {
        advanceRoomPhysics(room);
        const now = Date.now();
        if (room.listeners.size && now - (room.lastBroadcast || 0) >= 500) {
          room.lastBroadcast = now;
          room.lastActiveBroadcast = now;
          broadcastTick(room);
        } else if (room.listeners.size && room.active && now - (room.lastActiveBroadcast || 0) >= 200) {
          room.lastActiveBroadcast = now;
          broadcastTick(room, true);
        }
      }
      if (room.dirty && Date.now() - (room.lastPersistAttempt || 0) > 5000) {
        persist(room).catch(error => console.error('Room persistence:', error.message));
      }
    } catch (error) { console.error('Room loop:', error); }
  }
}, 1000 / 60).unref();
