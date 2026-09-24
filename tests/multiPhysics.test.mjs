import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { advanceRoomPhysics, drop, startRoom } from '../server/rooms.js';
import { CANONICAL_SHAPES } from '../src/canonicalShapes.js';
import { makeCompoundTextBody } from '../src/physicsBody.js';
import { applyDropGravity, PHYSICS_STEP_MS } from '../src/dropMotion.js';
import { stageGeometry } from '../src/stageGeometry.js';

const { Engine, Bodies, Composite, Events } = Matter;

function newRoom(viewport) {
  const room = {
    id: 'TEST', phase: 'lobby', hostId: 'a',
    members: new Map([
      ['a', { id: 'a', name: 'A', status: 'playing' }],
      ['b', { id: 'b', name: 'B', status: 'playing' }],
    ]),
    order: ['a', 'b'], turnIndex: -1, term: null, turnDeadline: 0,
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
