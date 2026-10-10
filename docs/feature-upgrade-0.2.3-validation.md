# Balanced desktop upgrade — 2026-10-05

This local 0.2.3 rebuild adds reading, download and desktop navigation features
over the existing Nyora Web presentation. Shared Web source, canonical source
identities and the portable backup format are unchanged.

## Implemented behavior

- Sidebar quick actions and Cmd/Ctrl+K open a searchable command palette.
  Existing screens, exact-key Continue reading and native comic imports are
  available. Cmd/Ctrl+/ opens shortcut help. Native menus add History, Bookmarks,
  Updates, Stats, Back/Forward and search focus. Fixed preload events and a
  focused-main-window guard prevent routing the app from verification windows.
- Reader keys ignore modified shortcuts, text editing, composition and dialogs.
  Palette keyboard selection, focus trapping and Escape restoration are checked.
- Library search matches titles and alternate titles within the selected
  collection. Source/history filters and Recent/Title/Recently read sorting
  preserve exact source/content identities and lazy card rendering. Reading
  filters explicitly describe recent saved history; clearing history and private
  reading affect this view. Chapter completion is never treated as book completion.
- Pause queue finishes running chapters and holds new work across restart.
  Resume releases pending chapters. Retry failed skips cancelled and
  verification-waiting jobs. Pause/retry commits roll back on failed writes;
  polling waits for mutations and notifications carry their saved snapshot.
- Downloads separates Running, Queued, Failed, Completed and Cancelled groups,
  retains focused row controls during polling and reports native export outcomes
  correctly. Paused waiting rows do not animate as though downloading.
- Main-process Dock/taskbar progress tracks the current chapter batch, excluding
  old completions. Windows supports a paused mode; Linux needs a compatible dock
  and matching desktop entry. Native presentation failures cannot fail downloads.

Queue state is device-only schema-1 data; missing `queuePaused` defaults to false.
New library filters are transient presentation state. Neither enters backup/sync.

## Verification performed

`npm run package:mac` completed on native ARM64 with **344 tests passing** and no
failures or skips. Catalogue conformance verified **605 sources**, including
**260 Cloudflare-labelled sources** and all 175 eligible Wall-B entries.

The full browser smoke passed against the captured bundle: quick actions/help,
reader keyboard boundaries, combined library filters, category-preserving reset,
exact source identities, lazy card growth, minimum-width layout, confirmed queue
controls, polling focus, existing source verification, image recovery, backup UI,
cloud/tracker UI and offline reading. Browser personal storage remains poisoned
in the fixture. Screenshots are under `test-results/library-tools/` and
`test-results/desktop-commands/`; the 860×600 library and shortcut help were
visually inspected.

Mandatory copied-ASAR checks passed for images, Chromium verification, cookie
durability, renderer/helper recovery, downloads/local imports/offline restart,
tracking and encrypted credentials. The offline gate now proves a paused queued
chapter remains idle in a fresh Electron process and completes only after
explicit Resume, through deterministic image callbacks and real storage/decoding.
Receipts enforce `durableQueuePause` and `pausedQueueFreshProcessRestart`.

The rebuilt app was reopened normally from `release/mac-arm64/Nyora.app`.
Normal launch verified its owned native ARM helper, bundled local assets,
cross-origin isolation, denial of unsigned image requests, matching packaged
frontend and retained `app.nyora.desktop.preview/electron` profile. The previously
running app was quit gracefully. Earlier artifacts/receipts are retained under
`release/history/0.2.3-before-feature-upgrade/`.

The helper remains revision `2.0.7-desktop-relay.6`, JAR SHA256
`ef6387af77c4c731c8c7a826448cb0140048d3dc9b066cc09b989069bcbc747e`.
No Kotlin/runtime replacement, version bump, signing change, publication or
automatic legacy-profile migration occurred.

## Artifacts and limits

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | 229181343 | `d60a5e0681e29cfa9e2d4df370c1df31bcd495ba8896bf09f3d66cb5619f5f28` |
| `Nyora-0.2.3-mac-arm64.zip` | 228627762 | `c35d763d791944606b611e37349b59c72ac41842c5fe6115991361351a7433e3` |

Tagged receipts are `release/*-0.2.3-feature-upgrade-darwin-arm64.json` and
`release/build-0.2.3-feature-upgrade-darwin-arm64.log`.
Windows, Linux and Mac Intel runtime/distribution acceptance were not executed.
Native progress state logic is unit-tested; OS presentation varies. Cloudflare
gates use offline fixtures and do not guarantee acceptance by every live site.
Existing-user migration and signed distribution remain separate release gates.

Native progress semantics follow the official
[Electron BrowserWindow API](https://www.electronjs.org/docs/latest/api/browser-window#winsetprogressbarprogress-options).
