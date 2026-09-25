import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { advanceRoomPhysics, drop, publicState, setAim, startRoom } from '../server/rooms.js';
import { CANONICAL_SHAPES } from '../src/canonicalShapes.js';
import { makeCompoundTextBody } from '../src/physicsBody.js';
import { applyDropGravity, PHYSICS_STEP_MS } from '../src/dropMotion.js';
import { stageGeometry } from '../src/stageGeometry.js';
import { MultiPhysicsView } from '../src/multiPhysicsView.js';
import { isLost } from '../src/lossRules.js';

const { Engine, Bodies, Composite, Events } = Matter;

function newRoom(viewport, ids = ['a', 'b']) {
  const room = {
    id: 'TEST', phase: 'lobby', hostId: 'a',
    members: new Map(ids.map(id => [id, { id, name: id, status: 'playing' }])),
    order: ids, turnIndex: -1, term: null, turnDeadline: 0,
    spawnY: 160, pieces: [], messages: [], listeners: new Set(),
  };
  startRoom(room, { id: 'a' }, viewport);
  return room;
}

test('multiplayer uses the solo world and fall trajectory at the same canvas size', () => {
  const viewport = { width: 990, height: 720 };
  const room = newRoom(viewport);
  assert.deepEqual(room.geometry, stageGeometry(viewport.width, viewport.height));
  room.term = 'カロート';
  const x = room.geometry.width / 2;
  drop(room, room.order[room.turnIndex], x);

  const reference = Engine.create({ gravity: { x: 0, y: 1.15 }, enableSleeping: true });
  reference.positionIterations = 10;
  reference.velocityIterations = 10;
  reference.constraintIterations = 4;
  const base = Bodies.rectangle(x, room.geometry.baseY, room.geometry.baseWidth, 28, {
    isStatic: true, label: 'base', friction: 1.1,
  });
  const shape = CANONICAL_SHAPES['t:カロート'];
  const body = makeCompoundTextBody(shape.rectangles, shape.width, shape.height, x, room.spawnY);
  Composite.add(reference.world, [base, body]);
  let falling = body;
  let landed = false;
  Events.on(reference, 'collisionStart', event => {
    for (const pair of event.pairs) {
      const a = pair.bodyA.parent;
      const b = pair.bodyB.parent;
      const other = a === falling ? b : b === falling ? a : null;
      if (other && falling.position.y < other.position.y + 20) landed = true;
    }
  });

  let referenceSteps = 0;
  for (let frame = 0; frame < 160; frame++) {
    advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
    const roomSteps = Math.round(room.engine.timing.timestamp / PHYSICS_STEP_MS);
    while (referenceSteps < roomSteps) {
      if (!landed) applyDropGravity(body, reference.gravity);
      Engine.update(reference, PHYSICS_STEP_MS);
      referenceSteps++;
    }
    assert.ok(Math.abs(room.pieces[0].body.position.y - body.position.y) < .001, `frame ${frame}: vertical trajectory`);
    assert.ok(Math.abs(room.pieces[0].body.position.x - body.position.x) < .001, `frame ${frame}: horizontal trajectory`);
  }
  assert.equal(room.active, null, 'the same landing rules advance the turn');

  room.term = 'RK';
  const secondX = x + 90;
  drop(room, room.order[room.turnIndex], secondX);
  const secondShape = CANONICAL_SHAPES['t:RK'];
  const second = makeCompoundTextBody(secondShape.rectangles, secondShape.width, secondShape.height, secondX, room.spawnY);
  Composite.add(reference.world, second);
  falling = second;
  landed = false;
  let compared = 0;
  for (let frame = 0; frame < 90 && room.pieces.length === 2; frame++) {
    advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
    const roomSteps = Math.round(room.engine.timing.timestamp / PHYSICS_STEP_MS);
    while (referenceSteps < roomSteps) {
      if (!landed) applyDropGravity(second, reference.gravity);
      Engine.update(reference, PHYSICS_STEP_MS);
      referenceSteps++;
    }
    if (room.pieces.length !== 2) break;
    assert.ok(Math.abs(room.pieces[0].body.position.y - body.position.y) < .001, `second word frame ${frame}: pile trajectory`);
    assert.ok(Math.abs(room.pieces[1].body.position.y - second.position.y) < .001, `second word frame ${frame}: impact trajectory`);
    compared++;
  }
  assert.ok(compared > 40, 'the shared trajectory includes the second word landing on the pile');
});

test('a word that misses the solo plate boundary eliminates its owner', () => {
  const room = newRoom({ width: 990, height: 720 });
  room.term = 'RK';
  const owner = room.order[room.turnIndex];
  drop(room, owner, 0);
  for (let frame = 0; frame < 250 && room.phase === 'playing'; frame++) {
    advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
  }
  assert.equal(room.members.get(owner).status, 'eliminated');
  assert.equal(room.phase, 'ended');
});

test('a collapsing older word eliminates the current dropper and clears the plate', () => {
  const room = newRoom({ width: 1290, height: 900 }, ['a', 'b', 'c']);
  room.term = 'カロート';
  drop(room, room.order[room.turnIndex], room.geometry.width / 2);
  for (let frame = 0; frame < 250 && room.active; frame++) {
    advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
  }
  assert.equal(room.active, null);
  assert.equal(room.pieces.length, 1);
  const previous = room.pieces[0].body;
  const current = room.order[room.turnIndex];
  room.term = 'RK';
  drop(room, current, room.geometry.width / 2);
  Matter.Body.setPosition(previous, { x: room.geometry.width / 2, y: room.geometry.baseY + 120 });
  advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
  assert.equal(room.members.get(current).status, 'eliminated');
  assert.equal(room.members.get('a').status, 'playing');
  assert.equal(room.phase, 'playing');
  assert.equal(room.pieces.length, 0);
  assert.equal(room.active, null);
  assert.notEqual(room.order[room.turnIndex], current);
});

test('a tilted word touching the plate edge stays in play until it actually falls below', () => {
  const room = newRoom({ width: 1290, height: 900 });
  room.term = 'カロート';
  const owner = room.order[room.turnIndex];
  drop(room, owner, room.base.bounds.max.x - 20);
  const body = room.pieces[0].body;
  Matter.Body.setAngle(body, Math.PI / 2);
  Matter.Body.setPosition(body, { x: room.base.bounds.max.x - 20, y: room.base.bounds.max.y + 20 });
  assert.ok(body.bounds.min.y < room.base.bounds.min.y, 'a tall glyph still extends above the plate');
  assert.equal(isLost(body, room.base), false);
  Matter.Body.setPosition(body, { x: body.position.x, y: room.base.bounds.max.y + body.bounds.max.y - body.bounds.min.y + 30 });
  assert.equal(isLost(body, room.base), true);
});

test('the turn timer drops at the latest pointer position and rotation', () => {
  const room = newRoom({ width: 990, height: 720 });
  room.term = 'RK';
  const owner = room.order[room.turnIndex];
  const selectedX = room.geometry.width / 2 + 125;
  const deadline = room.turnDeadline;
  assert.equal(setAim(room, 'b', 100, 0, deadline, 1), false, 'another player cannot move the active word');
  assert.equal(setAim(room, owner, selectedX, Math.PI / 12, deadline - 1, 1), false, 'old turns cannot move the word');
  assert.equal(setAim(room, owner, selectedX, Math.PI / 12, deadline, 2), true);
  assert.equal(setAim(room, owner, room.geometry.width / 2, 0, deadline, 1), false, 'late requests cannot overwrite a newer aim');
  room.turnDeadline = Date.now() - 1;
  advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
  assert.equal(room.pieces.length, 1);
  const piece = room.pieces[0];
  assert.ok(Math.abs(piece.body.position.x + piece.offsetX - selectedX) < 1);
  assert.ok(Math.abs(piece.body.angle - Math.PI / 12) < .02);
});

test('local multiplayer motion matches the server and predicts an immediate drop', () => {
  const room = newRoom({ width: 390, height: 700 });
  room.term = 'カロート';
  const owner = room.order[room.turnIndex];
  const x = room.geometry.width / 2;
  const view = new MultiPhysicsView(room.geometry);
  view.step(0);
  const predicted = view.predict(room.term, owner, x, room.spawnY, 0);
  assert.ok(predicted, 'the release is visible before the HTTP response');
  drop(room, owner, x);
  const state = publicState(room, owner);
  view.sync(state);
  assert.equal(view.predictedId, null);
  assert.equal(view.pieces.size, 1, 'prediction is reused when the server confirms it');
  for (let frame = 1; frame <= 80; frame++) {
    const now = frame * PHYSICS_STEP_MS * 2;
    advanceRoomPhysics(room, room.physicsTime + PHYSICS_STEP_MS * 2);
    view.step(now);
    const actual = room.pieces[0].body;
    const visible = view.pose(room.pieces[0].id);
    assert.ok(Math.abs(view.engine.timing.timestamp - room.engine.timing.timestamp) <= PHYSICS_STEP_MS + .001);
    if (Math.abs(view.engine.timing.timestamp - room.engine.timing.timestamp) < .001) {
      assert.ok(Math.abs(visible.x - actual.position.x) < .001, `frame ${frame}: x`);
      assert.ok(Math.abs(visible.y - actual.position.y) < .001, `frame ${frame}: y`);
    }
  }
});
