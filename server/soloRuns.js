import crypto from 'node:crypto';
import Matter from 'matter-js';
import { createTermPicker } from '../src/termPicker.js';
import { splitTerm } from '../src/textBodies.js';
import { CANONICAL_SHAPES } from '../src/canonicalShapes.js';
import { makeCompoundTextBody } from '../src/physicsBody.js';
import { stageGeometry } from '../src/stageGeometry.js';
import { applyDropGravity, PHYSICS_STEP_MS } from '../src/dropMotion.js';
import { submitScore } from './ranking.js';

const { Engine, Bodies, Body, Composite, Events } = Matter;
const runs = new Map();
const RUN_TTL_MS = 30 * 60_000;
const MAX_PIECES = 150;
const MAX_EVENTS = 320;
const MAX_WAIT_TICKS = 500;
const MAX_TOTAL_TICKS = 80_000;
const startTimes = new Map();

function viewport(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
    width < 280 || width > 3840 || height < 350 || height > 2400) {
    throw new Error('画面サイズを確認できませんでした');
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function shapeFor(piece) {
  const shape = CANONICAL_SHAPES[`${piece.emoji ? 'e' : 't'}:${piece.text}`];
  if (!shape) throw new Error('用語の当たり判定が見つかりません');
  return shape;
}

function makeReplay(run) {
  const geometry = stageGeometry(run.width, run.height);
  const engine = Engine.create({ gravity: { x: 0, y: 1.15 }, enableSleeping: true });
  engine.positionIterations = 10;
  engine.velocityIterations = 10;
  engine.constraintIterations = 4;
  const base = Bodies.rectangle(geometry.width / 2, geometry.baseY, geometry.baseWidth, 28,
    { isStatic: true, label: 'base', friction: 1.1 });
  Composite.add(engine.world, base);
  const replay = {
    engine, base, geometry, pieces: [], active: null, landing: false,
    landingTicks: 0, stableTicks: 0, score: 0, nextPiece: 0,
    spawnY: Math.min(geometry.spawnTop, base.position.y - 100), over: false,
  };
  Events.on(engine, 'collisionStart', event => {
    if (!replay.active) return;
    for (const pair of event.pairs) {
      const a = pair.bodyA.parent;
      const b = pair.bodyB.parent;
      const other = a === replay.active ? b : b === replay.active ? a : null;
      if (other && (other === replay.base || replay.pieces.includes(other)) &&
        replay.active.position.y < other.position.y + 20) {
        replay.landing = true;
        break;
      }
    }
  });
  return replay;
}

function resizeReplay(replay, width, height) {
  const geometry = stageGeometry(width, height);
  const shift = (geometry.width - replay.geometry.width) / 2;
  const rise = geometry.baseY - replay.base.position.y;
  Body.setPosition(replay.base, { x: geometry.width / 2, y: geometry.baseY });
  if (Math.abs(shift) > 1 || Math.abs(rise) > 1) {
    for (const body of replay.pieces) {
      Body.setPosition(body, { x: body.position.x + shift, y: body.position.y + rise });
    }
  }
  replay.geometry = geometry;
  const highest = replay.pieces.reduce((y, body) => Math.min(y, body.bounds.min.y), replay.base.position.y);
  replay.spawnY = Math.min(geometry.spawnTop, replay.base.position.y - 100,
    ...(replay.pieces.length ? [highest - 155] : []));
}

function dropReplay(replay, run, event) {
  if (replay.active || replay.over || replay.nextPiece >= run.pieces.length) {
    throw new Error('落下の順番が正しくありません');
  }
  if (!Number.isFinite(event.x) || !Number.isFinite(event.angle) ||
    event.x < 0 || event.x > replay.geometry.width || Math.abs(event.angle) > Math.PI + .001) {
    throw new Error('落下位置を確認できませんでした');
  }
  const shape = shapeFor(run.pieces[replay.nextPiece++]);
  const cosine = Math.abs(Math.cos(event.angle));
  const sine = Math.abs(Math.sin(event.angle));
  const halfWidth = (shape.width * cosine + shape.height * sine) / 2;
  const x = Math.max(halfWidth + 6,
    Math.min(replay.geometry.width - halfWidth - 6, event.x));
  const body = makeCompoundTextBody(shape.rectangles, shape.width, shape.height, x, replay.spawnY);
  Body.setAngle(body, event.angle);
  Composite.add(replay.engine.world, body);
  replay.pieces.push(body);
  replay.active = body;
  replay.landing = false;
  replay.landingTicks = 0;
  replay.stableTicks = 0;
}

function stepReplay(replay) {
  if (replay.over) return;
  if (replay.active && !replay.landing) applyDropGravity(replay.active, replay.engine.gravity);
  Engine.update(replay.engine, PHYSICS_STEP_MS);
  if (replay.active && replay.landing) {
    replay.landingTicks++;
    if (replay.active.speed < .65 && replay.active.angularSpeed < .025) replay.stableTicks++;
    else replay.stableTicks = 0;
    if (replay.landingTicks >= 30 && (replay.stableTicks >= 16 || replay.landingTicks >= 170)) {
      replay.score++;
      replay.active = null;
      replay.landing = false;
      const highest = replay.pieces.reduce((y, body) => Math.min(y, body.bounds.min.y), replay.base.position.y);
      replay.spawnY = Math.min(replay.geometry.spawnTop, highest - 155);
    }
  }
  const leftLimit = replay.base.bounds.min.x - 120;
  const rightLimit = replay.base.bounds.max.x + 120;
  replay.over = replay.pieces.some(body => body.position.y > replay.base.position.y + 95 ||
    body.bounds.max.x < leftLimit || body.bounds.min.x > rightLimit);
}

async function verifyReplay(run, input) {
  const events = input.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS ||
    !Number.isSafeInteger(input.endWait) || input.endWait < 0 || input.endWait > MAX_WAIT_TICKS) {
    throw new Error('プレイ記録を確認できませんでした');
  }
  let totalTicks = input.endWait;
  let drops = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.wait) || event.wait < 0 || event.wait > MAX_WAIT_TICKS ||
      !['drop', 'resize'].includes(event.type)) throw new Error('プレイ記録を確認できませんでした');
    totalTicks += event.wait;
    if (event.type === 'drop') drops++;
  }
  if (!drops || drops > MAX_PIECES || totalTicks > MAX_TOTAL_TICKS ||
    totalTicks > (Date.now() - run.startedAt) / PHYSICS_STEP_MS + 600) {
    throw new Error('プレイ時間を確認できませんでした');
  }
  const replay = makeReplay(run);
  let elapsed = 0;
  const advance = async count => {
    for (let i = 0; i < count; i++) {
      stepReplay(replay);
      if (++elapsed % 400 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  };
  for (const event of events) {
    await advance(event.wait);
    if (replay.over) throw new Error('終了後の操作があります');
    if (event.type === 'resize') {
      const size = viewport(event.width, event.height);
      resizeReplay(replay, size.width, size.height);
    } else dropReplay(replay, run, event);
  }
  await advance(input.endWait);
  if (replay.score < 1 || !replay.over) {
    throw new Error('記録を確定できませんでした');
  }
  return replay.score;
}

function pruneRuns() {
  const now = Date.now();
  for (const [id, run] of runs) if (now - run.startedAt > RUN_TTL_MS) runs.delete(id);
  for (const [id, at] of startTimes) if (now - at > 60_000) startTimes.delete(id);
}

export function startSoloRun(user, input) {
  if (!user?.id) throw new Error('Karotterにログインしてください');
  const size = viewport(input.width, input.height);
  pruneRuns();
  if (Date.now() - (startTimes.get(user.id) || 0) < 2000) throw new Error('少し待ってから始めてください');
  const pick = createTermPicker(undefined, () => crypto.randomInt(0x100000000) / 0x100000000);
  const pieces = [];
  while (pieces.length < MAX_PIECES + 2) pieces.push(...splitTerm(pick()));
  const id = crypto.randomBytes(18).toString('base64url');
  runs.set(id, { id, userId: user.id, ...size, pieces, startedAt: Date.now(), submissionHash: null, replayScore: null, replayError: null, result: null, processing: false });
  startTimes.set(user.id, Date.now());
  return { id, pieces };
}

export async function finishSoloRun(user, input) {
  const run = runs.get(String(input.runId || ''));
  if (!run || run.userId !== user?.id || Date.now() - run.startedAt > RUN_TTL_MS) {
    throw new Error('プレイ記録の有効期限が切れました');
  }
  const submissionHash = crypto.createHash('sha256').update(JSON.stringify({ events: input.events, endWait: input.endWait })).digest('hex');
  if (run.submissionHash && run.submissionHash !== submissionHash) throw new Error('プレイ記録は再送できません');
  if (run.replayError) throw new Error(run.replayError);
  if (run.result) return run.result;
  if (run.processing) throw new Error('記録を処理中です');
  run.processing = true;
  try {
    if (run.replayScore === null) {
      run.submissionHash = submissionHash;
      try { run.replayScore = await verifyReplay(run, input); }
      catch (error) { run.replayError = error.message; throw error; }
    }
    run.result = await submitScore(user, run.replayScore);
    return run.result;
  } finally { run.processing = false; }
}
