// Keep the plate and glyph physics at the same size on every screen. Only the
// camera scales the world to fit a narrow viewport.
export const TEXT_STAGE_WIDTH = 1300;
const MIN_VIEW_WIDTH = 1000;
const PLATE_WIDTH = 910;
const BOTTOM_GAP = 72;
const SPAWN_TOP = 185;

export function stageGeometry(cssWidth, cssHeight) {
  const displayScale = Math.min(1, cssWidth / MIN_VIEW_WIDTH);
  const width = cssWidth / displayScale;
  const height = cssHeight / displayScale;
  return {
    displayScale,
    width,
    height,
    baseWidth: PLATE_WIDTH,
    baseY: height - BOTTOM_GAP / displayScale,
    spawnTop: SPAWN_TOP / displayScale,
    topPadding: Math.min(110, Math.max(62, cssHeight * .28)) / displayScale,
  };
}
