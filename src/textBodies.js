import { makeCompoundTextBody } from './physicsBody.js';

const emojiPattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Presentation}\u20e3]/u;
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const spriteCache = new Map();

// A term is queued as one rigid text piece per continuous text run. Emoji are
// individual pieces, including joined emoji such as family emoji or flags.
export function splitTerm(term) {
  const pieces = [];
  let word = '';
  for (const { segment } of segmenter.segment(term)) {
    if (emojiPattern.test(segment)) {
      if (word) pieces.push({ text: word, emoji: false });
      word = '';
      pieces.push({ text: segment, emoji: true });
    } else word += segment;
  }
  if (word) pieces.push({ text: word, emoji: false });
  return pieces;
}

function fontFor(size, emoji) {
  return emoji
    ? `${size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`
    : `900 ${size}px "M PLUS Rounded 1c", sans-serif`;
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
  const maxWidth = Math.max(130, Math.min(stageWidth * .76, 510));
  const key = `${piece.text}|${piece.emoji}|${Math.round(maxWidth)}|${color}`;
  if (spriteCache.has(key)) return spriteCache.get(key);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let size = piece.emoji ? Math.min(76, stageWidth * .18) : Math.min(62, stageWidth * .13);
  size = Math.max(piece.emoji ? 48 : 34, Math.floor(size));
  ctx.font = fontFor(size, piece.emoji);
  while (ctx.measureText(piece.text).width > maxWidth - 18 && size > 16) {
    size -= 2;
    ctx.font = fontFor(size, piece.emoji);
  }
  const naturalWidth = ctx.measureText(piece.text).width;
  const horizontalScale = Math.min(1, (maxWidth - 18) / naturalWidth);
  const width = Math.ceil(naturalWidth * horizontalScale + 18);
  const height = Math.ceil(size * 1.55 + 18);
  canvas.width = width;
  canvas.height = height;
  ctx.font = fontFor(size, piece.emoji);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(width / 2, height / 2);
  ctx.scale(horizontalScale, 1);
  if (!piece.emoji) {
    ctx.lineWidth = Math.max(2, size * .045);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.strokeText(piece.text, 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(piece.text, 0, 0);
  } else {
    ctx.fillStyle = '#086b9e';
    ctx.fillText(piece.text, 0, 0);
  }

  const pixels = ctx.getImageData(0, 0, width, height);
  let cell = 7;
  let rectangles = occupiedRectangles(pixels, cell);
  while (rectangles.length > 72 && cell < 10) {
    cell++;
    rectangles = occupiedRectangles(pixels, cell);
  }
  const sprite = { canvas, width, height, rectangles, piece, size, cell };
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
