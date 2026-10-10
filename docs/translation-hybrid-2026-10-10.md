# Minimal-download combined translation test

**Result:** Nyora's existing translations can be rendered by Koharu with **zero additional ML model downloads**. The renderer-only prototype runs offline on this Mac with an empty package cache. The tiny school-idol and fishing-job lines become more readable, although some other wrapping remains awkward. This is not yet a production reader integration.

[View the before/after comparison](../test-results/translation-hybrid/index.html).

## What was actually combined

The input is the original 770 × 1080 test page plus the seven Japanese OCR blocks and English strings produced by the earlier live Nyora run. All seven strings are preserved exactly. The experiment replays these results to isolate layout; it does **not** rerun OCR or Google translation and does not establish a new end-to-end translation time.

The helper uses Koharu's real native scene, renderer, and rasterizer at commit `2c78c0cd6eeec4dbf607f0a22e3a7e1f932b6ff3`. It discovers white balloon interiors using image pixels, erases grayscale source text inside the existing text rectangles, and passes the balloon contours to Koharu's layout. The installed Comic Sans MS and Arial fonts avoid additional font downloads on this Mac.

No Koharu detector, Manga OCR checkpoint, Qwen model, vision projector, LaMa model, Torch runtime, llama runtime, or diffusion runtime is initialized by this helper. It does not depend on the large model cache downloaded for the previous comparison.

## Download budget

| Component | Size | Status |
| --- | ---: | --- |
| Nyora detector + Japanese OCR encoder/decoder + vocabulary | 122,689,589 bytes (~123 MB / 117 MiB) | Existing Nyora requirement, unchanged |
| Additional ML model weights | **0 bytes** | Verified with network denied and an empty helper package cache |
| Additional font downloads | **0 bytes on this Mac** | Uses installed fonts |
| Experimental native helper | 36,544,608 bytes (~36.5 MB / 34.9 MiB) | Uncompressed executable; software, not a model |

Nyora's existing browser ONNX Runtime assets are additional app assets and are not included in the model-weight total. An eventual installer size has not been measured. A missing system font on another platform may require a bundled font or a different fallback. Nyora's Google translation still requires internet access; only this cleanup/render stage was tested offline.

## Measurements and checks

Apple M3, 24 GiB RAM, macOS 26.6.1. Timers include pixel analysis, cleanup, scene construction, Koharu lettering/rasterization, and PNG writes, after the helper's initial renderer/rasterizer construction. They exclude Nyora OCR and translation.

| Run | Time | Accepted regions | Render diagnostics |
| --- | ---: | ---: | --- |
| First expanded layout | 216 ms | 7/7 | None |
| Repeated expanded layout | **126 ms** | 7/7 | None |
| Control using original narrow source boxes | 124 ms | 7/7 | One overflow warning |

The full helper process, containing all three passes, took 0.54 seconds. macOS reports 184 MiB maximum RSS and 410 MiB peak footprint for this helper only, excluding Nyora and its models. OS font/Metal caches were already warm from prior work, so the first pass is not a pristine-install cold-start measurement.

- Six focused geometry/cleanup tests passed.
- All seven output strings equal Nyora's recorded translations, including “Shrimp fishing boat part-time job!” and “Rob a bank”.
- The expanded render has no Koharu overflow warnings. The source-box control shows that lettering code alone does not fix the narrow-box problem.
- The first attempt exposed a thin white connection from a balloon into clothing. Eroding white pixels before region labeling fixes the observed connection; the initial failed layout and a regression test are retained.
- The helper succeeded under the supplied macOS `deny network*` sandbox profile. A sandboxed network probe failed. The configured package cache contains no downloaded files.
- The executable's dynamic dependencies are macOS system libraries/frameworks; the experiment does not require the native ML runtime packages from the full pipeline.

## Visual limits and recommendation

The school-idol text grows from Nyora's tiny rendering to a readable two-line placement. The fishing-job text also gets more room. Some long names still acquire unattractive hyphenation, and several other lines become smaller under Koharu's contour-fitting rules. This is a mixed typography result, not an across-the-board improvement.

Keep the lightweight route as the starting point: retain Nyora's models and translation provider, improve bubble geometry and wrapping, and make heavier inpainting optional only if artwork-backed text warrants it. No extra model is needed to explore those improvements.

This page mainly contains white speech balloons. The method does not reconstruct textured/color artwork and deliberately leaves uncertain regions unchanged. In production, fall back to Nyora's existing overlay instead of dropping such translations. Titles, character labels, and sound effects remain subject to Nyora's existing detection coverage. Test more real pages before enabling the hybrid in the app.

## Evidence and source

- [Adapter source and reproduction instructions](../experiments/translation-hybrid/README.md)
- [Raw results and verification](../test-results/translation-hybrid/hybrid.json)
- [Run and memory log](../test-results/translation-hybrid/run.log)
- [Focused test output](../test-results/translation-hybrid/tests.log)
- [Earlier full-engine comparison](translation-benchmark-2026-10-10.md)

## Follow-up integration

The production desktop integration uses Nyora's browser renderer with conservative bubble geometry, rather than shipping this native prototype. See [desktop layout integration](translation-layout-integration-2026-10-10.md) for implemented behavior, validation, and limitations.
