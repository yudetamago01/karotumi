import test from 'node:test';
import assert from 'node:assert/strict';
import { multiStageView } from '../src/multiStageView.js';
import { PLATE_WIDTH, stageGeometry } from '../src/stageGeometry.js';

test('mobile multiplayer keeps the plate above rotation controls while the pile grows', () => {
  for (const [width, height] of [[390, 476], [320, 378]]) {
    const geometry = stageGeometry(width, height);
    const shortPile = multiStageView(width, height, geometry.spawnTop, geometry);
    const tallPile = multiStageView(width, height, -520, geometry);
    const buttonTop = height - 6 - 48;
    for (const view of [shortPile, tallPile]) {
      assert.ok(view.screenY(geometry.baseY) < buttonTop - 15, `${width}x${height}: plate overlaps controls`);
      assert.ok(view.screenY(geometry.baseY) > 0, `${width}x${height}: plate left the screen`);
      assert.ok(view.screenY(-610) > 50 || view === shortPile);
      assert.ok(Math.abs(view.worldX(view.screenX(geometry.width / 2)) - geometry.width / 2) < 1e-9);
    }
    assert.ok(tallPile.scale < shortPile.scale);
  }
});

test('multiplayer and solo use the same text and plate scale', () => {
  for (const [width, height] of [[390, 476], [320, 378], [1600, 900]]) {
    const solo = stageGeometry(width, height);
    const multi = multiStageView(width, height, solo.spawnTop, solo);
    assert.equal(multi.scale, solo.displayScale);
    assert.equal(PLATE_WIDTH * multi.scale, PLATE_WIDTH * solo.displayScale);
    assert.equal(multi.screenX(solo.width / 2), width / 2);
  }
});

test('a phone viewing a desktop-led room retains its solo plate and text scale', () => {
  const roomGeometry = stageGeometry(990, 720);
  const phone = stageGeometry(390, 476);
  const view = multiStageView(390, 476, roomGeometry.spawnTop, roomGeometry);
  assert.equal(view.scale, phone.displayScale);
  assert.equal(view.screenX(roomGeometry.width / 2), 195);
  assert.equal(roomGeometry.baseWidth * view.scale, PLATE_WIDTH * phone.displayScale);
});
