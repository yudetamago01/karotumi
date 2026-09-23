import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMS } from '../src/terms.js';
import { createTermPicker } from '../src/termPicker.js';

test('each term appears once per shuffled cycle without a boundary repeat', () => {
  assert.equal(new Set(TERMS).size, TERMS.length);
  const pick = createTermPicker(TERMS, () => .5);
  const first = Array.from({ length: TERMS.length }, pick);
  const second = Array.from({ length: TERMS.length }, pick);
  assert.deepEqual(new Set(first), new Set(TERMS));
  assert.deepEqual(new Set(second), new Set(TERMS));
  assert.notEqual(first.at(-1), second[0]);
});
