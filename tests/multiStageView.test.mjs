import test from 'node:test';
import assert from 'node:assert/strict';
import { multiStageView } from '../src/multiStageView.js';

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
