# Desktop reader translation layout

Integrated into the desktop frontend build on 2026-10-10. This is Nyora code informed by the Koharu experiment, not the Koharu Rust renderer. Existing detection/OCR models, Google translation, optional refinement, and translated strings are unchanged. Added model downloads: **0 bytes**. No native renderer or additional fonts are shipped.

The worker finds enclosed white bubble interiors with bounded local pixel analysis. It closes tiny outline gaps, avoids colored marks and other detected text, and provides safe rectangles. Open, colored, oversized, unreadable, or shared regions fall back to the original OCR box. The overlay keeps erasure at the source box, compares whole-word fits, and uses extra space only when it improves the fit. Decorative stars allow a line break without changing the text or inserting hyphens. Scrolling repositions overlays without repeating font searches; resizing recomputes them.

## Validation

- Geometry regression tests cover closed/open/colored/shared bubbles, thin outline leaks, pixel-access failure, allocation limits, and colored interjections beside and above text.
- Chromium regression covers actual font metrics, fallback against poor candidates, exact text, original erasure positions, resize, progress, destruction/recreation, and no repeated font fitting on scroll.
- The existing frontend suite and app smoke cover reader navigation and image loading, alongside other desktop features.
- `node scripts/smoke-translation-layout.mjs` uses an isolated real Electron runtime, real image pixels, and a module worker. It replays previously measured Japanese OCR and English MT at page widths 500, 770, and 1000 px. It does not run inference. It requires the local earlier benchmark files under `test-results/translation-comparison`.
- A separate live run used the built OCR worker, real detection/OCR models, Google MT, and the desktop overlay in Chrome. Both cold and warm runs returned the same seven strings as the earlier benchmark. Warm time was 13.81 seconds on this machine; this is a single run, not evidence of a speedup. This integration run preceded the final colored-mark candidate refinement, which was validated separately in Electron.

At 770 px page width, Electron measurements changed the School☆Idol bubble from 6 to 12.8 px, the shrimp-fishing bubble from 8.5 to 14.4 px, and the bank punchline from 17.3 to 29.7 px. Some other text is 0.3–0.5 px smaller because the new fitter measures the inner lettering height and padding more conservatively. All seven strings remain exact and fit at the three tested widths. Geometry analysis took about 24 ms for this page. This improves presentation, not translation accuracy; one page is not a broad quality benchmark.

Evidence: `test-results/translation-layout/{before.png,after.png,report.json}` and `test-results/translation-integrated/nyora.json`. The isolated smoke harness and manga sample are not desktop runtime assets. The historical native-renderer experiment remains under `experiments/translation-hybrid`; it is not bundled.
