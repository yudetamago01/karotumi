import test from 'node:test';
import assert from 'node:assert/strict';
import { stageGeometry, TEXT_STAGE_WIDTH } from '../src/stageGeometry.js';

test('phone and desktop keep the same plate-to-text world ratio', () => {
  const phone = stageGeometry(390, 844);
  const desktop = stageGeometry(1440, 900);
  assert.equal(phone.baseWidth, desktop.baseWidth);
  assert.equal(TEXT_STAGE_WIDTH, 1300);
  assert.equal(phone.width, 1000);
  assert.equal(desktop.width, 1920);
  assert.equal(desktop.displayScale, .75);
  assert.equal(phone.displayScale, .39);
  assert.ok(phone.baseWidth * phone.displayScale > 300);
  assert.ok(Math.abs(phone.baseWidth * phone.displayScale / (TEXT_STAGE_WIDTH * phone.displayScale)
    - desktop.baseWidth * desktop.displayScale / (TEXT_STAGE_WIDTH * desktop.displayScale)) < 1e-9);
  assert.ok(Math.abs((phone.height - phone.baseY) * phone.displayScale - 72) < 1e-9);
  assert.ok(Math.abs(phone.spawnTop * phone.displayScale - 185) < 1e-9);
});
