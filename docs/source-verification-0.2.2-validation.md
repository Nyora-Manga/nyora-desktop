# Nyora 0.2.2 — source verification notices and recovery

The reported manga-details screen displayed unrelated Manhuauss, ManhwaFull and
Philia Scans checks in a large global stack. Notices now follow the current manga,
reader or selected Explore source. Multiple checks on source-management, Search,
Downloads and Settings screens start as one collapsed summary. Each notice has an
accessible × dismissal and optional **How to verify** guidance. Dismissal only
affects presentation; native checks, source controls, cookie saving and automatic
retries continue. Fresh verification cycles can show the notice again.

Two stale-state causes were reproduced and fixed:

- A later failure from another request in the same source invalidated an exact
  successful retry. Native proof now follows the particular request or image.
  Newer failures of that same request still reject older responses. A bounded
  deferred proof handles a single relay-to-helper binding gap without retaining
  response bodies. Genuine window close creates a new proof boundary; repeated
  close events cannot erase a later failure or invalidate a fresh retry.
- An exact successful search with zero matches cleared renderer retry state but
  retained the native Verify prompt. An empty search now completes its own failed
  query only with a recognized current native checkpoint. Empty page lists,
  proactive empty home reads, malformed responses and errors remain inconclusive.

Validation on 2026-10-04, native Mac ARM:

- All **274 desktop tests passed**, with no failures or skips. This includes 26
  native verification tests and the regression joining renderer recovery to native
  verification for a successful zero-match search.
- The full browser smoke passed automatic close-and-retry, source notice scope,
  dismissal without clearing native state, navigation with delayed status polling,
  collapsed Downloads checks, fresh-cycle resurfacing and reader image recovery.
  Space activates guidance without triggering reader shortcuts. Narrow-screen
  Verify and × controls passed hit-testing without sidebar occlusion.
- All 25 responsive layout scenarios passed. Clean evidence is in
  `test-results/source-notices/`; desktop and 390px details were visually checked.
- Packaging passed all copied-ASAR gates: real Chromium images, 10 CF checks,
  5 cookie durability phases, 3 crash-recovery checks, offline download/import/
  export and fresh-process reading, and 5 encrypted-account checks.
- Mac ARM app, DMG and ZIP built. The normal 0.2.2 app was reopened with the
  existing profile retained (PID 51424). Its bundled HTTP assets, isolation headers,
  private helper startup and rejection of unsigned image requests were checked.

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.2-mac-arm64.dmg` | `874904fec9f66720e6d3d8fe4fa5286589af558b99b89fe4569f4a5fc14e113a` |
| `Nyora-0.2.2-mac-arm64.zip` | `b5ea26903559416f6de0b1d2e75f752171c532162592fcfdee62dfb27d621ae9` |

Evidence: `release/runtime-validation-0.2.2-darwin-arm64.json`,
`release/normal-launch-0.2.2-darwin-arm64.json`,
`release/artifacts-0.2.2-darwin-arm64.json`, and
`release/build-validation-0.2.2-darwin-arm64.log`.

Multiple relay failures arriving before their helper errors can be bound remain
conservative; they can still require another verification attempt and a fresh
read. These fixtures do not prove compatibility with every live site's challenge.
Public rollout limitations remain those in the
[full-app acceptance report](full-app-0.2.0-validation.md).
