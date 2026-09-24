import test from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { initialDropVelocity, PHYSICS_STEP_MS } from '../src/dropMotion.js';

function fallingSteps(distance, fast) {
  const engine = Matter.Engine.create({ gravity: { x: 0, y: 1.15 } });
  const body = Matter.Bodies.rectangle(0, 0, 50, 50);
  Matter.Composite.add(engine.world, body);
  if (fast) {
    Matter.Body.setVelocity(body, {
      x: 0,
      y: initialDropVelocity(distance, engine.gravity.y, engine.gravity.scale),
    });
  }
  let steps = 0;
  while (body.position.y < distance && steps < 1000) {
    Matter.Engine.update(engine, PHYSICS_STEP_MS);
    steps++;
  }
  return steps;
}

test('falling words reach the pile in about two thirds of the previous time', () => {
  for (const distance of [400, 600, 1000, 1500]) {
    const speedup = fallingSteps(distance, false) / fallingSteps(distance, true);
    assert.ok(speedup > 1.43 && speedup < 1.57, `${distance}: ${speedup}`);
  }
});
