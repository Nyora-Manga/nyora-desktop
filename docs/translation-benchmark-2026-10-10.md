# Japanese → English translation comparison

Tested on an Apple M3 Mac with 24 GiB unified memory, macOS 26.6.1. This is a one-page proof of concept, not a representative accuracy benchmark.

## Result

**Nyora translated this page more faithfully; Koharu produced much more readable lettering.** Koharu's native pipeline runs successfully on this Mac, but the tested Qwen 3.5 2B model should not replace Nyora's default translator. Consider adapting Koharu's detection, balloon fitting, cleanup, and renderer while retaining Nyora's translation provider, or test a stronger Koharu LLM first. That hybrid has not been implemented or benchmarked.

| Completed run | Nyora | Koharu, Qwen 3.5 2B |
| --- | --- | --- |
| Warm processing | 13.95 s including DOM overlay layout | 9.81 s pipeline + 0.08 s rasterization |
| Accepted text segments | 7 dialogue blocks | 10 segments including title, one name, and ellipsis |
| Translation | Main meaning generally preserved | Several serious errors despite correct Japanese OCR |
| Layout | Some English becomes tiny in narrow source boxes | Readable lettering using more of the speech balloons |
| Repeat consistency | Identical translations and screenshot files | Identical translations across both passes |

These are single-page measurements, not averages. Nyora includes an online Google call. Koharu is local and uses a different model and detection/rendering pipeline. Koharu's reported render timer excludes renderer construction and PNG encoding; warm end-to-end Electron integration latency is not measured.

## Test configuration

Both engines receive exactly the same 770 × 1080 Japanese manga page: Koharu's `crates/koharu-ml/benches/fixtures/object_detection/1.jpg`, at upstream commit `2c78c0cd6eeec4dbf607f0a22e3a7e1f932b6ff3` (workspace 0.83.5).

- **Nyora:** production shared `engine.js`, `mt.js`, and `overlay.js`, with the existing built desktop worker and self-hosted ONNX Runtime. Tested in isolated, headed Chrome using a local HTTP harness. Only the preference store and image proxy adapter are stubbed. Japanese Manga OCR, default Google translation, no paid LLM refinement or series glossary. This exercises the translation pipeline; it is not an Electron IPC or reader-navigation test.
- **Koharu:** native release pipeline runner, RF-DETR Seg 2XL detection, Manga OCR, Qwen 3.5 2B Q4_K_XL with its F16 vision projector, LaMa inpainting, English target. This deliberately uses a smaller model than the runner's default Gemma 4 12B. Results apply to this configuration.
- Nyora's second run uses a distinct image URL to force detection, OCR, and translation again while keeping its models resident. Koharu's repeat harness creates two fresh scene sessions using one shared production `Pipeline`; it does not reuse an already translated scene.
- No Nyora production code, user library, API keys, or translation preferences were changed for this test.

## Nyora observations

- Fresh isolated browser, including downloads: **102.12 seconds**. An earlier attempt translated successfully in 218.74 seconds but failed at screenshot capture due to a test-harness API mistake; that attempt is retained separately and excluded from completed-run timings. Download timings are network-sensitive.
- Resident-model repeat: **13.95 seconds**, including a fresh Google translation request and DOM overlay layout.
- Nine initial regions; seven accepted Japanese OCR blocks, each producing English text. Both completed runs returned identical translations.
- Main dialogue meaning is generally recoverable on this sample. “Rob a bank” is preserved. “That's right, I need to suggest a realistic method” introduces a first-person subject where a contextual “we” would read more naturally.
- English is fitted to narrow source-text boxes. The school-idol and fishing-job lines become very small despite unused speech-bubble space. This is a clear reader-layout problem.
- The title, character-name labels, sound effects, and orange interjection remain Japanese. The seven translated dialogue blocks should not be mistaken for complete page coverage.
- Background replacement uses sampled-color rectangles and soft shadows. This white-bubble sample is insufficient to judge cleanup over complex artwork.
- Sampled peak RSS summed across the dedicated Chrome process tree: **2,130 MiB**. Sampling began during download, includes browser overhead, and can double-count shared pages; it is not an isolated model-memory measurement.

## Koharu setup observations

The native release runner built successfully in **5m 05s**. The initial run completed detection, OCR, and inpainting, but was intentionally stopped after **513.18 seconds** while the built-in Qwen download was progressing very slowly. It did not produce a completed translation; this is not counted as an inference failure or completed cold run.

The exact pinned Qwen files are approximately 2.01 GB combined (decimal):

| File | Bytes | Expected SHA-256 from Hugging Face linked ETag |
| --- | ---: | --- |
| Qwen3.5-2B-UD-Q4_K_XL.gguf | 1,339,752,704 | `0af96165ea615bea39a04118d63f0b6d35908aea850ee4a51aa6151d851b8b35` |
| mmproj-F16.gguf | 668,227,264 | `7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7` |

Both direct downloads completed and matched the expected SHA-256 values. Parallel ranged downloading and verification took 312.95 seconds. The files populate the same model cache; model selection and inference implementation are unchanged.

## Koharu completed runs

The repeat harness exited successfully and produced two complete 770 × 1080 PNGs. Each pass uses a new scene; model instances remain shared through one pipeline.

| Measurement | First pass, files cached | Second pass, models resident |
| --- | ---: | ---: |
| Pipeline | 14.95 s | 9.81 s |
| Rasterization | 6.42 s | 0.08 s |
| Sum of those timers | 21.37 s | 9.89 s |

The full process, including both passes, startup, rendering setup, and output writes, took 31.87 seconds. Stage timers can overlap/include scheduling waits and should not be summed to infer pipeline time.

macOS `/usr/bin/time -l` reports **2.54 GiB maximum RSS** and **4.14 GiB peak memory footprint** for the native process. Nyora's aggregate Chrome RSS uses a different accounting method, so these do not establish a precise memory ratio. Koharu's downloaded runtime/model cache occupies approximately **3.1 GiB**, separate from the Rust build directory.

Koharu recognizes the seven dialogue blocks plus the title, Ayane's label, and the ellipsis. It leaves several other name labels and the orange interjection untranslated. Its bubble fitting and comic lettering are visibly better on this sample. The white bubble backgrounds do not meaningfully stress inpainting over artwork.

The main quality failure is translation, not OCR. Logged Japanese source text is correct for these examples:

| Source meaning | Nyora output | Koharu Qwen 3.5 2B output |
| --- | --- | --- |
| Part-time work on a shrimp fishing boat | “Shrimp fishing boat part-time job!” | “Beating the fishery boat!” |
| How about becoming school idols? | “What about School☆Idol?” | “How about... school idol scouts?~?” |
| As expected of Shiroko-senpai | “As expected of Shiroko-senpai!” | “You're an excellent senior!~” |
| Rob a bank | “Rob a bank” | “Attacking the bank!” |

The two Koharu runs returned the same translations. The 2B model introduces unsupported wording and drops a character name; these findings should not be generalized to Koharu's default 12B model or other providers, which were not tested.

## Next step

A worthwhile Nyora integration prototype would pass Koharu's recognized text through Nyora's current translation provider, then render the translated strings using Koharu's balloon geometry and cleanup. Before shipping, test more pages, artwork behind text, tall strips, repeated page navigation, cancellation, and helper/model download recovery. The present experiment verifies native feasibility and exposes a model-quality tradeoff; it does not validate production integration.

## Evidence

[Side-by-side images](../test-results/translation-comparison/index.html), [Nyora raw results](../test-results/translation-comparison/nyora.json), and all test harnesses, logs, source hashes, and original fixture are saved in `nyora-desktop/test-results/translation-comparison/`.
