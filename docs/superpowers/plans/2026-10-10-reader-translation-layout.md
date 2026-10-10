# Desktop translation layout integration

User approved fixing wrapping and integrating the low-download result. The prototype showed that native Koharu contour fitting introduces awkward hyphenation and sometimes shrinks text. Integrate its useful lesson—derive more layout space from white bubble interiors—into Nyora's browser renderer instead of shipping that Rust renderer. This is a Nyora implementation informed by the experiment, not a bundled Koharu engine.

- Keep all existing OCR/translation models, provider settings, and strings unchanged. No extra models, native helper, or fonts.
- Add bounded pixel analysis to the existing translation worker. Erode white regions to close tiny outline gaps, reject open/colored/shared areas, return a few safe interior rectangles, and retain original boxes.
- Separate source-text erasure from transparent English lettering. Compare candidate rectangles against the original at the current zoom and use a wider layout only if its whole-word font size improves. Allow breaks around decorative separators without inserting hyphens or changing text.
- Keep desktop changes in captured frontend overrides; preserve shared web source and unrelated edits.
- Write geometry and browser regression tests before implementation. Cover fallback, thin leaks, multiple blocks, minimum baseline size, exact text, resizing, progress, and destroy/recreate.
- Build, run frontend checks and Electron reader smoke checks, inspect the same page, then reload the user's running app. Record actual validation and limitations.
