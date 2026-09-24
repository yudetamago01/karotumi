import test from 'node:test';
import assert from 'node:assert/strict';
import { bindHoldRotation } from '../src/rotationControls.js';

test('holding a rotate button repeats until release and a keyboard click rotates once', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const left = new EventTarget();
  const right = new EventTarget();
  left.disabled = false;
  right.disabled = false;
  const turns = [];
  const cleanup = bindHoldRotation(left, right, direction => turns.push(direction));

  try {
    left.dispatchEvent(new Event('pointerdown'));
    assert.deepEqual(turns, [-1]);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(turns.length >= 3, 'rotation repeats during a hold');
    left.dispatchEvent(new Event('pointerup'));
    const stoppedAt = turns.length;
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(turns.length, stoppedAt, 'rotation stops on release');

    const keyboardClick = new Event('click');
    Object.defineProperty(keyboardClick, 'detail', { value: 0 });
    right.dispatchEvent(keyboardClick);
    assert.equal(turns.at(-1), 1);
    assert.equal(turns.length, stoppedAt + 1);

    right.disabled = true;
    right.dispatchEvent(new Event('pointerdown'));
    assert.equal(turns.length, stoppedAt + 1);
  } finally {
    cleanup();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
