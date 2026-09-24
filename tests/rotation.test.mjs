import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { drop, publicState } from '../server/rooms.js';

test('multiplayer drop keeps the chosen angle in physics and room state', () => {
  const room = {
    id: 'ROTATION', phase: 'playing', hostId: 'player-1',
    members: new Map([['player-1', { id: 'player-1', status: 'playing' }]]),
    order: ['player-1', 'player-2'], turnIndex: 0, term: '回転',
    turnDeadline: Date.now() + 10_000, spawnY: 160, winnerId: null,
    active: null, shape: null, pieces: [], messages: [], listeners: new Set(),
    engine: Matter.Engine.create(),
    base: Matter.Bodies.rectangle(500, 650, 700, 28, { isStatic: true }),
  };
  const shape = {
    term: '回転', width: 200, height: 60,
    rectangles: [{ x: 100, y: 30, w: 180, h: 50 }],
  };

  drop(room, 'player-1', 0, shape, Math.PI / 2);

  const piece = room.active;
  assert.ok(piece);
  assert.ok(Math.abs(piece.body.angle - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(piece.body.position.x + piece.offsetX - 36) < 1e-6,
    'rotated width is used when clamping the drop position');
  assert.ok(piece.body.bounds.max.x - piece.body.bounds.min.x < 70,
    'the collision mask turns with the visible word');
  assert.ok(Math.abs(publicState(room, 'player-1').pieces[0].angle - Math.PI / 2) < 1e-6);
});
