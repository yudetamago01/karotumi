import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TERMS } from '../src/terms.js';
import { splitTerm } from '../src/textBodies.js';
import { CANONICAL_SHAPES } from '../src/canonicalShapes.js';
import { hasGameEmoji, termLabelHtml } from '../src/emojiAssets.js';

test('every falling emoji has a bundled Microsoft image and one fixed physics mask', async () => {
  const files = new Map([
    ['👈', 'point-left.png'],
    ['💪', 'flexed-biceps.png'],
    ['🥕', 'carrot.png'],
  ]);
  const fallingEmoji = new Set(TERMS.flatMap(term => splitTerm(term).filter(piece => piece.emoji).map(piece => piece.text)));
  assert.deepEqual(fallingEmoji, new Set(files.keys()));
  for (const [emoji, filename] of files) {
    assert.equal(hasGameEmoji(emoji), true);
    const image = await readFile(new URL(`../src/assets/emoji/${filename}`, import.meta.url));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const shape = CANONICAL_SHAPES[`e:${emoji}`];
    assert.equal(shape.width, 136);
    assert.equal(shape.height, 136);
    assert.ok(shape.rectangles.length > 0);
    assert.match(termLabelHtml(emoji), /<img class="term-emoji"/);
  }
});

test('the text heart remains part of its word', () => {
  assert.deepEqual(splitTerm('にゃん♡'), [{ text: 'にゃん♡', emoji: false }]);
  assert.ok(CANONICAL_SHAPES['t:にゃん♡']);
});
