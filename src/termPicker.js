import { TERMS } from './terms.js';

export function createTermPicker(terms = TERMS, random = Math.random) {
  const choices = [...new Set(terms)];
  if (!choices.length) throw new Error('用語がありません');
  let bag = [];
  let previous;

  return () => {
    if (!bag.length) {
      bag = choices.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (bag.length > 1 && bag[bag.length - 1] === previous) {
        [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
      }
    }
    previous = bag.pop();
    return previous;
  };
}
