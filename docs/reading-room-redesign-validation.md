# Desktop reading room redesign

Implemented 2026-10-10 from the approved [design plan](../../docs/superpowers/plans/2026-10-10-electron-design-improvement.md).

## Delivered

- Six primary destinations with Library first and Settings in the sidebar footer; existing routes and numbered shortcuts remain available. History, Bookmarks and Stats move to Library subnavigation. Source browser is accessible from Sources.
- Layered soft-dark surfaces, Sakura accents, light and Pure black support, consistent page headings, contextual header search, and quieter reader controls.
- Library resume card with actual saved title/chapter/page, exact target validation and a History fallback. Compact search/sort/filter controls, actionable first-run Library, and native comic import.
- Source attribution and separate keyboard-accessible Open/Actions controls on covers. Existing native mutation acknowledgement and context-menu behavior retained.
- Search includes locally saved titles without fetching source content while typing. An explicit separate action searches manga sources. Arbitrary text does not execute commands.
- Sources name/language/pin filtering, readable names, pinned grouping and visible pin controls.
- Local chapter search that composes with existing read/download filters, stronger title details hierarchy, and retained chapter identity and native reader state.
- Downloads hides irrelevant controls when empty, offers Browse library, and keeps destructive management inside a secondary disclosure. Existing status groups, confirmations, pause/retry behavior and polling focus remain.
- Wide Settings category/detail layout, narrow drill-down navigation, live appearance preview, and Create backup / Restore backup labels. Cloud and backup behavior is unchanged.
- Discover distinguishes explicit offline, failed requests and valid empty feeds and offers Library/Sources recovery actions.

All implementation lives in `nyora-desktop`; the shared web checkout was not modified. Checked build transformations compose with the existing native adapters. Generated `dist` was rebuilt from these inputs.

## Implementation decisions

The proposed Plus Jakarta Sans/Inter files were not available locally, and this session cannot resolve external download hosts. The app therefore bundles the existing Nyora Poppins semibold font for headings, with native system body text. The font is unmodified and ships with its [OFL license](../frontend/fonts/OFL.txt). Google Fonts requests have been removed from the desktop HTML.

The compact sidebar remains an explicit saved choice; medium windows use a narrower labelled sidebar. Native title bars and window controls are retained. Downloads keeps its existing status groups rather than adding an additional tab state. The existing chapter action menus remain; this change does not add a new bulk-selection data model.

## Checks actually run

- Native menu terminology matches Sources / Create backup / Restore backup; `node --test electron/menu.test.cjs`: **3 passed**.
- `npm run build:frontend`: passed with all screen/card/native transformations composed and fonts included.
- `npm run test:frontend`: **124 tests: 119 passed, 5 failed at setup**. All five failures report `listen EPERM: operation not permitted 127.0.0.1`: four existing browser command-dialog tests and the frontend server boundary test. No test assertion failure was reported in the 119 tests that ran successfully.
- New behavior coverage includes exact chapter resume, unresolved/stale resume fallback, native import cancellation/error, source-qualified local search, bounded search results, cover menu native save acknowledgement, source search/pins, Settings routing, empty Downloads and focus restoration, discovery state distinctions, and chapter search/filter composition.
- `npm run smoke:frontend -- --no-build`: blocked before browser startup by the same socket restriction.
- Direct browser launch without a local server: also blocked; Chrome exited with SIGABRT. No post-change screenshots or live visual pass are claimed.
- Independent code review identified an inherited logo click listener, which was removed by replacing the brand node before binding its Library action, and an unmatched empty-state CSS selector, which was corrected.

## Remaining release verification

Run the existing browser/native checks in a normal local terminal before packaging:

```sh
cd nyora-desktop
npm run test:frontend
npm run smoke:frontend
npm run test:runtime:native
```

The smoke now includes `tests/feature-reading-room-browser.mjs`: empty Library actions and Settings visibility at 860×600 and 1440×900, local source filtering without content requests, bundled font loading, and dark/light Settings captures. The Library browser fixture also checks populated layout, preserved filters, categories, lazy cards and source identity. Planned screenshots are saved under `test-results/reading-room/` when these checks can run.

Live reader visuals, enlarged text/zoom, 500+ title performance, and Windows/Linux window behavior remain unverified. The current implementation is ready for visual review; it is not a signed or release-validated distribution.

## Follow-up polish and settings scrolling — 2026-10-10

The user reported uneven spacing and supplied a screenshot of Settings with its category column scrolled offscreen. Desktop Settings now constrains its layout to the available viewport: preferences scroll inside the detail panel, while the page heading and categories remain in place. On short windows the category list has its own scroll; the existing single-column navigation remains below 901px.

The shared dark-theme selector also outranked the desktop layout/font tokens. Correcting specificity restores the intended 216px sidebar (180px at compact desktop widths) and 56px header. The command trigger now lives once in the header, page headings share a scale, the empty Library panel has a bounded width, and preference rows have quiet separators.

Verification superseding the earlier sandbox limitations:

- `npm run test:frontend`: all 124 tests passed.
- `npm run smoke:frontend`: passed, including wheel scrolling of Settings at 1440×900 and 1024×600 with fixed category/header positions, populated Library placement, native mutation acknowledgements, and reader recovery.
- Actual Electron with an isolated temporary native profile: helper ready; Library, Sources, Discover, Downloads, Settings, appearance and reader preferences captured without horizontal overflow or unnamed buttons. Screenshots: `test-results/polish-after/`; scrolled Settings: `test-results/polish-after/settings-scrolled.png`.
- The running user application was reloaded through its View → Reload menu.

The browser harness now waits for the preceding download error toast to hide before checking source-notice hit targets. The command palette explicitly hides its empty-query remote action in standalone fixtures as well as the complete application.

The extended 30-scenario layout audit leaves one diagnostic-panel issue at 320px: `.desktop-runtime-body` has 4px internal overflow. The other scenarios pass, including desktop sizes. This does not affect the Settings scroll fix or the supported minimum desktop window.

## Pinned Sources controls — 2026-10-10

The Sources landing page now gives its result list a separate scroll area on desktop. Its heading, description, search/language/pin controls and source count remain fixed. The rule is limited to the landing screen; browsing a source retains the existing layout. The regression fixture uses 42 sources and verifies unchanged control positions after wheel scrolling at 1440×900 and 860×600. Captures are `test-results/reading-room/sources-scrolled-1440.png` and `sources-scrolled-860.png`. The running Electron application was reloaded.

## Source catalog and browsing surfaces — 2026-10-10

User feedback identified a wireframe appearance, specifically in catalog/browsing. Pure black previously assigned the same black to the canvas and raised panels; the desktop override now preserves the black canvas with dark neutral raised surfaces. Source dialogs expand to 760px, catalog names wrap, redundant language chips are removed visually (the language remains below the name), action buttons align, and rows cannot compress into overlapping controls. Catalog search has an accessible name and consistent source terminology. Browse source selectors, language controls and empty panels now use matching radii, filled surfaces and solid hairlines.

Validation includes source-dialog containment, untruncated names and row-content bounds at 1280, 860 and 390px, plus a Pure black surface distinction check. Evidence lives in `test-results/reading-room/catalog-polished-*.png`, `catalog-pure-black.png`, and `sources-pure-black.png`. The existing 320px diagnostic-panel overflow remains the only failure in the extended layout audit; source browsing/catalog/picker scenarios pass.

## Cloud Sync form polish — 2026-10-10

Removed the second Cloud Sync heading from the native settings builder. The account panel is bounded to 520px with a 460px form, filled 44px inputs, explicit accessible names, a primary Sign in/Merge and sync action, and a secondary account action. The short introduction sits above the form; the manual-sync and local-files explanation sits beneath it. Signed-in and error states retain native calls, pending-state disabling and password clearing.

The full browser smoke checks a single heading, form width and window fit at 1440×900 and 860×600, then exercises rejected sign-in, successful sign-in, manual sync and sign-out. Screenshots are `test-results/reading-room/cloud-sync-1440.png` and `cloud-sync-860.png`.
