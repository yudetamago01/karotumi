const WORLD_WIDTH = 1000;
const WORLD_BOTTOM = 665;

// Leave room for the turn label above the pile and the rotation controls
// below the plate. Zoom out as the pile grows instead of pushing the plate
// off the screen.
export function multiStageView(width, height, spawnY = 160) {
  const top = Math.min(70, spawnY - 90);
  const topInset = Math.min(100, Math.max(54, height * .23));
  const bottomInset = Math.min(82, Math.max(62, height * .2));
  const usableHeight = Math.max(20, height - topInset - bottomInset);
  const scale = Math.min(width / WORLD_WIDTH, usableHeight / (WORLD_BOTTOM - top));
  const offsetX = (width - WORLD_WIDTH * scale) / 2;
  const offsetY = height - bottomInset - WORLD_BOTTOM * scale;
  return {
    scale,
    offsetX,
    offsetY,
    screenX: x => offsetX + x * scale,
    screenY: y => offsetY + y * scale,
    worldX: x => (x - offsetX) / scale,
  };
}
