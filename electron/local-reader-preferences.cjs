'use strict';
const { EXTRA_PREFS, validatePrefs } = require('./reader-state.cjs');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validateLocalPreferences(prefs) {
  if (!plain(prefs)) throw new Error('Invalid offline reader preferences');
  const extras = {};
  for (const [key, value] of Object.entries(prefs)) {
    if (EXTRA_PREFS.includes(key)) extras[key] = value;
    else if (key === 'readerMode') {
      if (!['WEBTOON', 'PAGED', 'PAGED_RTL', 'VERTICAL'].includes(value)) throw new Error('Invalid reader mode');
    } else if (['brightness', 'contrast', 'saturation'].includes(key)) {
      if (!Number.isFinite(value) || value < (key === 'brightness' ? -1 : 0) || value > (key === 'brightness' ? 1 : 2)) throw new Error('Invalid reader image adjustment');
    } else if (key === 'palette') {
      if (!['', 'Grayscale', 'HighContrast', 'Soft', 'Sepia', 'Noir', 'Cool', 'Warm', 'DuotoneRed', 'DuotoneBlue'].includes(value)) throw new Error('Invalid reader palette');
    } else throw new Error('Unknown offline reader preference');
  }
  validatePrefs(extras);
}
module.exports = { validateLocalPreferences };
