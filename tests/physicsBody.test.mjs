import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { makeCompoundTextBody } from '../src/physicsBody.js';

test('distant glyph parts contribute to a dynamic word’s rotational inertia', () => {
  const body = makeCompoundTextBody([
    { x: 10, y: 20, w: 20, h: 40 },
    { x: 110, y: 20, w: 20, h: 40 },
  ], 120, 40, 300, 100);
  const localInertia = body.parts.slice(1).reduce((sum, part) => sum + part.inertia, 0);
  assert.ok(body.inertia > localInertia * 10);
  assert.ok(body.inverseInertia > 0);
  assert.equal(body.isStatic, false);

  const engine = Matter.Engine.create();
  Matter.Composite.add(engine.world, [body, Matter.Bodies.rectangle(300, 250, 300, 20, { isStatic: true })]);
  for (let i = 0; i < 120; i++) Matter.Engine.update(engine, 1000 / 60);
  assert.ok(body.position.y > 100, 'the word can still fall under gravity');
  assert.ok(Math.abs(body.angle) < Math.PI / 4, 'a symmetric word remains stable on a centered landing');
});
