const emojiUrls = Object.freeze({
  '👈': new URL('./assets/emoji/point-left.png', import.meta.url).href,
  '💪': new URL('./assets/emoji/flexed-biceps.png', import.meta.url).href,
  '🥕': new URL('./assets/emoji/carrot.png', import.meta.url).href,
});

const images = new Map();
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
let loading;

export function hasGameEmoji(text) {
  return Object.hasOwn(emojiUrls, text);
}

export function getGameEmojiImage(text) {
  return images.get(text) || null;
}

export function loadGameEmojiImages() {
  loading ||= Promise.all(Object.entries(emojiUrls).map(([emoji, url]) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { images.set(emoji, image); resolve(); };
    image.onerror = () => reject(new Error(`絵文字画像を読み込めませんでした: ${emoji}`));
    image.src = url;
  })));
  return loading;
}

export function termLabelHtml(term) {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const segments = segmenter.segment(String(term));
  return [...segments].map(({ segment }) => hasGameEmoji(segment)
    ? `<img class="term-emoji" src="${emojiUrls[segment]}" alt="${escape(segment)}">`
    : escape(segment)).join('');
}
