# Nyora 0.2.0 desktop acceptance — 2026-10-04

Built and opened the normal Mac ARM application with the existing Electron profile.
The build is a functional desktop reader with a bundled local HTTP server,
Chromium and isolated native helper. It has no system Java/Chrome dependency.

## Delivered behavior

- Persistent chapter downloads, cancellation/retry and automatic resumption after
  source verification; complete offline books reopen across application restart.
- Native CBZ/ZIP and image-folder import, offline reading, chapter/bundle export,
  durable page positions and reader adjustments. Original imported files remain
  untouched. Damaged stored books are retained and reported; missing pages cannot
  be restored as completed downloads.
- Nyora Cloud sign-in/registration, explicit Merge and sync, and sign-out retaining
  local data. AniList access-token connection, linking and reading updates.
  Account tokens stay in OS-encrypted main-process storage.
- Native chapter marks, recent searches with incognito handling, per-title reader
  controls, consumer menus, remembered window bounds and working screen wake lock.
  Bounded renderer/helper recovery preserves the route; failed writes are never
  replayed automatically.
- Consumer About/Settings text and desktop controls integrated into Nyora Web's
  layout. Source cookies save automatically; no manual Save cookies control.

The end-to-end download test also reproduced a mixed-cookie verification bug:
copying the intercepted ordinary Cookie header prevented Chromium from adding
partitioned clearance. The transport now leaves cookie composition to Chromium.
The failure mechanism matches the exact shipped
[Chromium 152 interceptor implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130/content/browser/devtools/devtools_url_loader_interceptor.cc).

## Validation

`npm run package:mac` completed successfully on native darwin/arm64. No Intel or
Rosetta runtime was used. Electron 44.5.1 includes Chromium 152.0.7977.130; helper
`2.0.7-desktop-relay.6` uses pinned Azul Zulu CA 17.0.20.1+1-LTS.

| Check | Result |
| --- | --- |
| Desktop unit/integration gate | 259 passed; no failures or skips |
| Native helper JVM suite | 230 tests / 40 classes; no failures, errors or skips |
| Shared frontend browser flow | Passed native adapter hydration, cloud/tracker success and rejection, download/offline reading, local import, read marks, failed/successful preference Save, page+adjustments after reload, automatic source verification/image retry |
| Responsive layouts | 25 scenarios across five widths passed |
| Actual Electron main + real helper | 6 passed, including library restart persistence and native screen wake-lock acquire/release |
| Missing-helper/session runtime | 8 passed |
| Assembled app image pipeline | 3 images decode through actual helper + Chromium + signed local HTTP; retries and tampering checked |
| Assembled app Cloudflare transport | 10 native fixture checks passed |
| Assembled app cookie durability | 5 native process phases passed |
| Assembled app recovery | 3 actual renderer/helper crash checks passed |
| Assembled app offline pipeline | Actual native download, import, export, cancellation, mixed-cookie verification resume, signed local images, no-network fresh-process reading and persisted local preferences passed |
| Assembled app credential storage | 5 checks with real OS encryption and separate-process restart passed |
| Authoritative catalogue | 603 eligible sources; all 258 CF-labelled eligible entries, including 175 Wall-B; no upstream requests |
| Normal packaged launch | Existing profile retained; bundled assets served, cross-origin isolation present, unsigned images denied, private helper requires authentication |

The copied ASAR and bundled helper passed all package acceptance gates before
installer creation. Production fuses were applied. Normal app PID at validation:
9495; no diagnostic startup flags were used.

## Artifacts

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `Nyora-0.2.0-mac-arm64.dmg` | 229,269,905 | `4897f1dae57c07d909921cad0284eef9c76645bbb4f83425859d1f95f8493611` |
| `Nyora-0.2.0-mac-arm64.zip` | 228,611,314 | `f4208402475170dee4c95763de76b98b6d25e487ae0a9fbf90c89c4b79d6204d` |

App: `release/mac-arm64/Nyora.app`.
Evidence: `release/runtime-validation-darwin-arm64.json`,
`release/normal-launch-0.2.0-darwin-arm64.json`,
`release/artifacts-0.2.0-darwin-arm64.json`, and
`release/build-validation-0.2.0-darwin-arm64.log`.
Test fixture evidence is in `test-results/runtime-*-smoke/result.json`.

## Existing users and rollout boundaries

The existing `app.nyora.desktop.preview/electron` profile and internal OS
credential identity are retained; the displayed name is Nyora. Older native
Mac/Windows/Linux profiles remain untouched. Use a valid `.nyorabk` v1 backup
and reviewed Merge, then check library counts and reading progress before
retiring an older client. Import old CBZ/ZIP downloads separately and reconnect
accounts. See [migration guidance](../../docs/desktop-validation.md).

This is a local unsigned Mac ARM build (macOS 14+). Public release still needs
signing/notarization, signed update infrastructure, native Windows/Linux app
acceptance, accessibility and installed-version migration cohorts. Fixture
accounts and source responses do not prove live account or every-source
compatibility. Tracker providers beyond AniList need verified desktop OAuth
registrations. OCR/colorization remain experimental; model caches can require
redownload after restart, and full inference/provider calls are untested.
Custom AI endpoints are rejected explicitly. No public release was published.
