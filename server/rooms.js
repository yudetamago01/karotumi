import crypto from 'node:crypto';
import Matter from 'matter-js';
import { createTermPicker } from '../src/termPicker.js';
import { makeCompoundTextBody } from '../src/physicsBody.js';
import { initialDropVelocity, PHYSICS_STEP_MS } from '../src/dropMotion.js';

const { Engine, Bodies, Body, Composite, Events } = Matter;
const WORLD_WIDTH = 1000;
const BASE_Y = 650;
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
  const base = Bodies.rectangle(500, BASE_Y, 700, 28, { isStatic: true, label: 'base', friction: 1.1 });
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
    spawnY: room.spawnY, winnerId: room.winnerId, activeId: room.active?.id || null,
    pieces: room.pieces.map(p => ({
      id: p.id, term: p.term, ownerId: p.ownerId,
      x: p.body.position.x, y: p.body.position.y, angle: p.body.angle,
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
    winnerId: data.winnerId, pieces: [], messages: data.messages || [],
    active: null, shape: null, listeners: new Set(), dirty: false,
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
    spawnY: 160, winnerId: null, pieces: [], messages: [],
    active: null, shape: null, listeners: new Set(), dirty: true, resetTimer: null,
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

function broadcastTick(room) {
  const pieces = room.pieces.flatMap((p, index) => p.body.isSleeping ? [] : [[
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
  room.winnerId = null;
  room.pieces = [];
  room.active = null;
  room.shape = null;
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
  room.shape = null;
  room.turnDeadline = Date.now() + TURN_MS;
  publish(room);
}

export function startRoom(room, user) {
  if (room.phase !== 'lobby') throw new Error('すでに開始しています');
  if (room.hostId !== user.id) throw new Error('ルーム作成者だけが開始できます');
  if (room.order.length < 2) throw new Error('2人以上で開始できます');
  room.phase = 'playing';
  room.pickTerm = createTermPicker();
  makeEngine(room);
  chooseTurn(room);
}

export function acceptShape(room, shape) {
  if (room.phase !== 'playing' || room.active || shape?.term !== room.term) return false;
  if (!Number.isFinite(shape.width) || !Number.isFinite(shape.height) ||
    shape.width < 15 || shape.width > 540 || shape.height < 15 || shape.height > 140 ||
    !Array.isArray(shape.rectangles) || shape.rectangles.length < 1 || shape.rectangles.length > 150) return false;
  for (const r of shape.rectangles) {
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0 ||
      r.x < 0 || r.y < 0 || r.x > shape.width || r.y > shape.height || r.w > 540 || r.h > 140) return false;
  }
  room.shape ||= { term: shape.term, width: shape.width, height: shape.height, rectangles: shape.rectangles };
  return true;
}

function fallbackShape(term) {
  const width = Math.min(510, Math.max(65, [...term].length * 51));
  return { term, width, height: 72, rectangles: [{ x: width / 2, y: 36, w: width - 8, h: 54 }] };
}

export function drop(room, userId, x, shape, angle = 0) {
  if (room.phase !== 'playing' || room.active || room.order[room.turnIndex] !== userId) throw new Error('今はあなたの番ではありません');
  if (shape) acceptShape(room, shape);
  const selectedShape = room.shape || fallbackShape(room.term);
  const safeAngle = Number.isFinite(angle) ? Math.max(-Math.PI * 2, Math.min(Math.PI * 2, angle)) : 0;
  const halfWidth = Math.abs(Math.cos(safeAngle)) * selectedShape.width / 2 + Math.abs(Math.sin(safeAngle)) * selectedShape.height / 2;
  const requestedX = Number(x);
  const center = Math.max(halfWidth + 6, Math.min(WORLD_WIDTH - halfWidth - 6, Number.isFinite(requestedX) ? requestedX : 500));
  const item = makeBody(selectedShape, center, room.spawnY);
  Body.setAngle(item.body, safeAngle);
  const supportY = Math.min(room.base.bounds.min.y, ...room.pieces.map(piece => piece.body.bounds.min.y));
  const distance = Math.max(0, supportY - item.body.bounds.max.y);
  Body.setVelocity(item.body, {
    x: 0,
    y: initialDropVelocity(distance, room.engine.gravity.y, room.engine.gravity.scale),
  });
  const piece = {
    id: crypto.randomUUID(), term: room.term, ownerId: userId,
    shape: selectedShape, ...item, landed: false, landingTicks: 0, stableTicks: 0,
  };
  room.pieces.push(piece);
  room.active = piece;
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

function step(room) {
  if (room.phase !== 'playing') return;
  if (!room.active && room.turnDeadline && Date.now() >= room.turnDeadline) {
    drop(room, room.order[room.turnIndex], 500);
  }
  // Two smaller steps prevent deep glyph contacts from pushing the pile apart.
  Engine.update(room.engine, PHYSICS_STEP_MS);
  Engine.update(room.engine, PHYSICS_STEP_MS);
  for (const piece of [...room.pieces]) {
    if (piece.body.position.y > BASE_Y + 95 || piece.body.bounds.max.x < -20 || piece.body.bounds.min.x > WORLD_WIDTH + 20) {
      Composite.remove(room.engine.world, piece.body);
      room.pieces = room.pieces.filter(p => p !== piece);
      eliminate(room, piece.ownerId);
    }
  }
  if (room.active?.landed) {
    const piece = room.active;
    piece.landingTicks += 2;
    if (piece.body.speed < .65 && piece.body.angularSpeed < .025) piece.stableTicks += 2;
    else piece.stableTicks = 0;
    if (piece.landingTicks >= 30 && (piece.stableTicks >= 16 || piece.landingTicks >= 170)) {
      // Advancing the turn must not force this piece asleep while it still
      // has unresolved contacts with the letters below it.
      room.active = null;
      const highest = room.pieces.reduce((y, p) => Math.min(y, p.body.bounds.min.y), BASE_Y);
      room.spawnY = Math.min(160, highest - 155);
      chooseTurn(room);
    }
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    try {
      if (room.phase === 'playing') {
        step(room);
        if (room.listeners.size && Date.now() - (room.lastBroadcast || 0) >= 166) {
          room.lastBroadcast = Date.now();
          broadcastTick(room);
        }
      }
      if (room.dirty && Date.now() - (room.lastPersistAttempt || 0) > 5000) {
        persist(room).catch(error => console.error('Room persistence:', error.message));
      }
    } catch (error) { console.error('Room loop:', error); }
  }
}, 1000 / 60).unref();
