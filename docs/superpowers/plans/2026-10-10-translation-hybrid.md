# Minimal-download hybrid test plan

**Goal:** Test Nyora OCR/translation output with Koharu's native lettering without additional ML weights.
**Architecture:** Replay the verified production Nyora result into a renderer-only Rust helper. Locate enclosed white bubble interiors using connected pixels, conservatively reject uncertain/open/colored regions, erase only source text rectangles in accepted white bubbles, and pass the interior contour to Koharu's `FlowsIn` layout. Use installed Comic Sans MS / Arial fonts. Do not initialize Koharu ML runtimes.
**Scope:** An isolated experiment and comparison artifacts, not a production Electron feature. Existing cached test output isolates layout quality; do not claim a newly measured end-to-end translation time.

- [x] Create pixel analysis and scene adapter in `nyora-desktop/experiments/translation-hybrid/hybrid.rs`, built as a temporary Koharu renderer binary.
- [x] Check white enclosed, open, colored, and overlapping-text bubble cases; avoid artwork deletion outside source rectangles.
- [x] Render source-sized and expanded-contour versions of the same seven translations, preserving strings exactly.
- [x] Run both passes with an empty isolated runtime store and network blocked. Inspect all outputs and record timing, font sizes, extra model bytes, and native helper size separately.
- [x] Save screenshots, raw evidence, and a report with limitations and recommendation.
