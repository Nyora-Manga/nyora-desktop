# Search and motion update — 2026-10-05

This local 0.2.3 rebuild renames the desktop quick-action entry and dialog to
**Search**, including accessible names and shortcut help. Cmd/Ctrl+K retains its
existing behavior. The native menu labels online title search as **Search manga**.

Search opens and closes with brief fade/position transitions. Navigation, buttons,
library controls and generic dialogs receive restrained feedback using the
existing theme. Reader pages and download polling rows are excluded. Reduced-motion
preferences disable the added motion, including changes while Search is open.

Search restores keyboard focus when closed, waits for exit before performing a
selected action exactly once, and safely handles rapid close/reopen. Unmounting
cancels pending actions and reopening. No shared Web source, data format, helper
revision or runtime dependency changed.

## Verification

`npm run package:mac` completed on native ARM64: **347 tests passed**, with no
failures or skips. The captured-bundle browser suite checks Search naming, rapid
reopen, focus restoration, keyboard selection and reduced-motion behavior alongside
the existing reading, library and download checks. Focused actual-browser tests
also cover delayed action execution, repeated Enter and live motion preferences.
The settled 860×600 Search screenshot was visually inspected.

All copied-ASAR gates passed: local images, Chromium verification, cookie
durability, renderer/helper recovery, downloads and paused-queue offline restart,
tracking and encrypted credentials. Catalogue conformance still reports 605
eligible sources, including 260 Cloudflare-labelled entries and 175 Wall-B entries.

The rebuilt app was reopened normally from `release/mac-arm64/Nyora.app`.
Normal startup verified the owned ARM helper, bundled local assets, cross-origin
isolation, unsigned-image rejection and matching packaged frontend. The existing
`app.nyora.desktop.preview/electron` profile was retained. Previous artifacts and
receipts are preserved under `release/history/0.2.3-before-search-motion/`.

The helper remains `2.0.7-desktop-relay.6`, JAR SHA256
`ef6387af77c4c731c8c7a826448cb0140048d3dc9b066cc09b989069bcbc747e`.

## Artifacts

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | 229215292 | `5c6d716b381e6c49622db7ffd6aa35443d03d7d9579b0bccad1adde994bfc93d` |
| `Nyora-0.2.3-mac-arm64.zip` | 228628913 | `914f828024260209fc7a9522c268f329852ccea6c96eb026eeb036a7033ece62` |

Tagged evidence is `release/*-0.2.3-search-motion-darwin-arm64.json` and
`release/build-0.2.3-search-motion-darwin-arm64.log`. Windows, Linux and Mac Intel
runtime acceptance was not repeated. Builds remain local and unsigned; no
publication, version change or automatic legacy-profile migration occurred.
