import { makeCompoundTextBody } from './physicsBody.js';
import { CANONICAL_SHAPES } from './canonicalShapes.js';
import { getGameEmojiImage } from './emojiAssets.js';

const emojiPattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Presentation}\u20e3]/u;
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const spriteCache = new Map();

// A term is queued as one rigid text piece per continuous text run. Emoji are
// individual pieces, including joined emoji such as family emoji or flags.
export function splitTerm(term) {
  const pieces = [];
  let word = '';
  for (const { segment } of segmenter.segment(term)) {
    if (emojiPattern.test(segment) && segment !== '♡') {
      if (word) pieces.push({ text: word, emoji: false });
      word = '';
      pieces.push({ text: segment, emoji: true });
    } else word += segment;
  }
  if (word) pieces.push({ text: word, emoji: false });
  return pieces;
}

const BASE_FONT = 64;
const FONT_FAMILY = '"M PLUS Rounded 1c", sans-serif';
const FONT_PROBE = 'カロッター用語0123ABCabc';

function fontFor(size) {
  return `900 ${size}px ${FONT_FAMILY}`;
}

// Google Fonts splits Japanese into subsets. Without an explicit load, the
// first sprites can be drawn in the fallback face and cached — phone and PC
// then show different stroke weights for the same term.
let fontLoad;
export function loadGameFonts() {
  fontLoad ||= (async () => {
    if (!document.fonts?.load) return;
    try {
      await document.fonts.load(fontFor(BASE_FONT), FONT_PROBE);
      await document.fonts.ready;
    } catch { /* Drawing falls back to the system face. */ }
  })();
  return fontLoad;
}

function occupiedRectangles(image, cell) {
  const { width, height, data } = image;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const occupied = Array.from({ length: rows }, () => new Uint8Array(cols));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * cell;
      const y0 = row * cell;
      const x1 = Math.min(width, x0 + cell);
      const y1 = Math.min(height, y0 + cell);
      let pixels = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * width + x) * 4 + 3] > 105) pixels++;
        }
      }
      if (pixels >= Math.max(2, Math.ceil((x1 - x0) * (y1 - y0) * .15))) occupied[row][col] = 1;
    }
  }

  // Merge full cells into convex, non-overlapping rectangles. Empty cells stay
  // empty, so spaces between glyphs and the counters inside glyphs remain open.
  const rectangles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!occupied[row][col]) continue;
      let span = 1;
      while (col + span < cols && occupied[row][col + span]) span++;
      let tall = 1;
      outer: while (row + tall < rows) {
        for (let x = col; x < col + span; x++) {
          if (!occupied[row + tall][x]) break outer;
        }
        tall++;
      }
      for (let y = row; y < row + tall; y++) {
        for (let x = col; x < col + span; x++) occupied[y][x] = 0;
      }
      const x = col * cell;
      const y = row * cell;
      const w = Math.min(width - x, span * cell);
      const h = Math.min(height - y, tall * cell);
      rectangles.push({ x: x + w / 2, y: y + h / 2, w, h });
    }
  }
  return rectangles;
}

export function makeTextSprite(piece, stageWidth, color = '#086b9e') {
  const canonical = CANONICAL_SHAPES[`${piece.emoji ? 'e' : 't'}:${piece.text}`];
  const key = `${piece.text}|${piece.emoji}|${color}`;
  if (spriteCache.has(key)) return spriteCache.get(key);

  if (piece.emoji) {
    const image = getGameEmojiImage(piece.text);
    if (!canonical || !image) throw new Error(`絵文字画像の準備ができていません: ${piece.text}`);
    const canvas = document.createElement('canvas');
    canvas.width = canonical.width;
    canvas.height = canonical.height;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const sprite = { canvas, width: canvas.width, height: canvas.height, rectangles: canonical.rectangles, piece, cell: 7 };
    spriteCache.set(key, sprite);
    return sprite;
  }

  // The canvas is always the shared collider box. Drawing at 1:1 keeps stroke
  // weight identical on every device; a metric-sized canvas stretched onto the
  // box changes thickness when font advances differ (phone vs PC).
  const maxWidth = Math.max(130, Math.min(stageWidth * .76, 510));
  const width = canonical?.width ?? Math.ceil(maxWidth);
  const height = canonical?.height ?? Math.ceil(BASE_FONT * 1.55 + 18);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = fontFor(BASE_FONT);
  const metrics = ctx.measureText(piece.text);
  const textWidth = Math.max(1, metrics.width);
  const textHeight = Math.max(1,
    (metrics.actualBoundingBoxAscent || BASE_FONT * .82) +
    (metrics.actualBoundingBoxDescent || BASE_FONT * .28));
  const pad = 10;
  const fit = Math.min((width - pad * 2) / textWidth, (height - pad * 2) / textHeight);
  ctx.translate(width / 2, height / 2);
  ctx.scale(fit, fit);
  ctx.font = fontFor(BASE_FONT);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Constant in user space → visible stroke scales with the glyphs (uniform).
  ctx.lineWidth = BASE_FONT * .045;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#fff';
  ctx.strokeText(piece.text, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(piece.text, 0, 0);

  let cell = 7;
  let rectangles = canonical?.rectangles;
  if (!rectangles) {
    const pixels = ctx.getImageData(0, 0, width, height);
    rectangles = occupiedRectangles(pixels, cell);
    while (rectangles.length > 72 && cell < 10) {
      cell++;
      rectangles = occupiedRectangles(pixels, cell);
    }
  }
  const sprite = { canvas, width, height, rectangles, piece, size: BASE_FONT * fit, cell };
  spriteCache.set(key, sprite);
  return sprite;
}

export function makeTextBody(sprite, x, y) {
  const body = makeCompoundTextBody(sprite.rectangles, sprite.width, sprite.height, x, y);
  body.plugin.text = {
    sprite,
    offsetX: x - body.position.x,
    offsetY: y - body.position.y,
    dropY: y,
  };
  return body;
}
