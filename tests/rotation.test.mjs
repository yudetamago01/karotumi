import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { acceptShape, drop, publicState } from '../server/rooms.js';
import { CANONICAL_SHAPES } from '../src/canonicalShapes.js';
import { PLATE_WIDTH } from '../src/stageGeometry.js';

test('multiplayer drop keeps the chosen angle in physics and room state', () => {
  const room = {
    id: 'ROTATION', phase: 'playing', hostId: 'player-1',
    members: new Map([['player-1', { id: 'player-1', status: 'playing' }]]),
    order: ['player-1', 'player-2'], turnIndex: 0, term: 'カロート',
    turnDeadline: Date.now() + 10_000, spawnY: 160, winnerId: null,
    active: null, pieces: [], messages: [], listeners: new Set(),
    engine: Matter.Engine.create(),
    base: Matter.Bodies.rectangle(500, 650, PLATE_WIDTH, 28, { isStatic: true }),
  };
  const shape = {
    term: 'カロート', width: 200, height: 60,
    rectangles: [{ x: 100, y: 30, w: 180, h: 50 }],
  };

  assert.equal(acceptShape(room, shape), true);
  drop(room, 'player-1', 0, shape, Math.PI / 2);

  const piece = room.active;
  const canonical = CANONICAL_SHAPES['t:カロート'];
  assert.ok(piece);
  assert.equal(piece.shape, canonical, 'the browser cannot replace the collision mask');
  assert.ok(Math.abs(piece.body.angle - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(piece.body.position.x + piece.offsetX - (canonical.height / 2 + 6)) < 1e-6,
    'rotated width is used when clamping the drop position');
  assert.ok(piece.body.bounds.max.x - piece.body.bounds.min.x < canonical.height,
    'the collision mask turns with the visible word');
  assert.ok(Math.abs(publicState(room, 'player-1').pieces[0].angle - Math.PI / 2) < 1e-6);
});
