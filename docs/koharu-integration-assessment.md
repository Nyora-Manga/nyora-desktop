# Koharu integration assessment

Reviewed 2026-10-10. Upstream checkout: `2c78c0cd6eeec4dbf607f0a22e3a7e1f932b6ff3` (workspace version 0.83.5). The initial source review is now followed by a [completed Japanese → English pipeline comparison](translation-benchmark-2026-10-10.md). Koharu runs natively on this M3 Mac; its tested Qwen 3.5 2B configuration improves lettering but translates less faithfully than Nyora on the sample page.

A subsequent [minimal-download combined prototype](translation-hybrid-2026-10-10.md) successfully replays Nyora translations through Koharu’s renderer with zero additional ML weights. Small-bubble readability improves, but wrapping remains mixed; production integration is not complete.

## Decision

Technically suitable as an optional native translation engine for Nyora Electron. Start with a one-page prototype, then benchmark against Nyora's current translator before making it a default. Keep Nyora's reader, native library and source transport.

## Evidence

- Nyora `nyora-web/web/core/translate/engine.js` coordinates detection/OCR, machine translation and optional LLM refinement. `overlay.js` explicitly uses sampled-background rectangles rather than inpainting.
- Koharu separates scene, pipeline, ML, translation, renderer and rasterizer crates from the Tauri application. The pipeline has page-stage progress, cooperative cancellation and incremental commits.
- `crates/koharu-pipeline/src/bin/run.rs` accepts an input image, output image, target language, model selections and CPU flag. It performs the full pipeline and renders the output. This is an in-repository runner; the normal desktop executable's CLI has no translation arguments.
- The runner currently selects a local translation provider and defaults to a 12B model. It is a starting point, not the full production integration. Its runtime initialization retries indefinitely, so an adapter needs bounded startup, errors and cancellation.
- The UI communicates through typed Tauri commands. There is no documented ready-made HTTP translation service in the reviewed architecture. Nyora should call a purpose-built helper process through Electron main.
- Apple silicon Metal is supported. Other accelerator paths and CPU fallbacks depend on the runtime/model combination. Initial use downloads runtime packages and model weights.
- Workspace code license is MIT OR Apache-2.0. Model weights and third-party native packages require separate review for the chosen distribution.

## Proposed first slice

1. Build the upstream pipeline runner at the pinned revision. Select conservative OCR/inpainting/translation models explicitly instead of relying on its heavyweight defaults.
2. Process representative Japanese, Korean and Chinese pages. Compare OCR accuracy, text removal, layout, cold/warm latency and peak memory with Nyora's existing output. Include artwork behind text and tall webtoon pages.
3. Add a native adapter accepting validated image bytes/owned temporary paths, target language and settings. Return a job ID, stage progress and a translated output asset. Preserve originals.
4. Surface an optional Koharu provider under translation settings and a Translate page action. Display the native-produced page with an Original/Translated switch.
5. Use a persistent worker for chapter queues so models remain loaded. Cache results by source/chapter/page identity, image hash, language, model revision and settings. Ignore late results when the reader changes page or source.
6. Add signed per-platform helper packaging and managed model/runtime downloads only after the benchmark succeeds.

The proof of concept should avoid importing Koharu's complete Tauri editor, project store or telemetry into Nyora. A browser-only deployment would need a separately designed backend or substantial port.

## Sources

- https://github.com/koharu-rs/koharu
- https://koharu.rs/en/development/architecture
- https://github.com/koharu-rs/koharu/blob/2c78c0cd6eeec4dbf607f0a22e3a7e1f932b6ff3/crates/koharu-pipeline/src/bin/run.rs
- https://github.com/koharu-rs/koharu/blob/2c78c0cd6eeec4dbf607f0a22e3a7e1f932b6ff3/crates/koharu-pipeline/README.md
- https://koharu.rs/en/hardware
- https://koharu.rs/en/installation
