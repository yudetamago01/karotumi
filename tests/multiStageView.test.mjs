import test from 'node:test';
import assert from 'node:assert/strict';
import { multiStageView } from '../src/multiStageView.js';
import { PLATE_WIDTH, stageGeometry } from '../src/stageGeometry.js';

test('mobile multiplayer keeps the plate above rotation controls while the pile grows', () => {
  for (const [width, height] of [[390, 476], [320, 378]]) {
    const shortPile = multiStageView(width, height, 160);
    const tallPile = multiStageView(width, height, -520);
    const buttonTop = height - 6 - 48;
    for (const view of [shortPile, tallPile]) {
      assert.ok(view.screenY(650) < buttonTop - 15, `${width}x${height}: plate overlaps controls`);
      assert.ok(view.screenY(650) > 0, `${width}x${height}: plate left the screen`);
      assert.ok(view.screenY(-610) > 50 || view === shortPile);
      assert.ok(Math.abs(view.worldX(view.screenX(500)) - 500) < 1e-9);
    }
    assert.ok(tallPile.scale < shortPile.scale);
  }
});

test('multiplayer and solo use the same text and plate scale', () => {
  for (const [width, height] of [[390, 476], [320, 378], [1600, 900]]) {
    const multi = multiStageView(width, height);
    const solo = stageGeometry(width, height);
    assert.equal(multi.scale, solo.displayScale);
    assert.equal(PLATE_WIDTH * multi.scale, PLATE_WIDTH * solo.displayScale);
    assert.equal(multi.screenX(500), width / 2);
  }
});
