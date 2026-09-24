import { BOTTOM_GAP, MAX_DISPLAY_SCALE, stageGeometry } from './stageGeometry.js';

// The leader's canvas defines the room world. Keep the plate at the same
// screen height and use the same initial scale as solo on that canvas.
export function multiStageView(width, height, spawnY, roomGeometry, scaleOverride) {
  const geometry = roomGeometry || stageGeometry(width, height);
  const top = Math.min(geometry.spawnTop, spawnY ?? geometry.spawnTop) - 90;
  const topInset = Math.min(100, Math.max(54, height * .23));
  const bottomInset = BOTTOM_GAP;
  const usableHeight = Math.max(20, height - topInset - bottomInset);
  const targetScale = Math.min(MAX_DISPLAY_SCALE, stageGeometry(width, height).displayScale, usableHeight / Math.max(1, geometry.baseY - top));
  const scale = scaleOverride ?? targetScale;
  const offsetX = (width - geometry.width * scale) / 2;
  const offsetY = height - bottomInset - geometry.baseY * scale;
  return {
    scale,
    targetScale,
    offsetX,
    offsetY,
    screenX: x => offsetX + x * scale,
    screenY: y => offsetY + y * scale,
    worldX: x => (x - offsetX) / scale,
  };
}
