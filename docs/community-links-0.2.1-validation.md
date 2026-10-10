# Nyora 0.2.1 — dismissible community links

The header has an accessible × button labelled “Hide community links”. It hides
Discord and official-website promotions after the native preference write is
acknowledged. The choice persists across full app restarts without flashing the
links during startup. The duplicate Discord sidebar link is removed.
Settings → Appearance → Community links restores the header links; About keeps
its optional project links. A failed save leaves the controls available for retry.

Validation on 2026-10-04, native Mac ARM:

- All 259 desktop tests passed.
- Browser smoke passed dismissal failure, Enter-key dismissal, focus restoration,
  no external popup and the Appearance restore switch.
- All 25 responsive layout scenarios passed; 900/1280 layouts visually checked.
- Seven real Electron/helper checks passed, including clicking × through the
  actual UI and confirming the choice after full application restart.
- All copied-ASAR package gates passed: images, CF, cookies, recovery, offline
  reading and encrypted accounts. The previous 0.2.0 behavior remains covered.
- Mac ARM app, DMG and ZIP built. Normal 0.2.1 app opened successfully with the
  existing profile retained; local assets and private helper checked (PID 30251).

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.1-mac-arm64.dmg` | `2ee5e72a10110f802fc5fde185b51c93d927c4756aaa564d8775d7b111a9e867` |
| `Nyora-0.2.1-mac-arm64.zip` | `d54f67c1bf480c5fd28267846da8c7848c306abe126e4acd97bf3d479894985f` |

Evidence: `release/runtime-validation-0.2.1-darwin-arm64.json`,
`release/normal-launch-0.2.1-darwin-arm64.json`,
`release/artifacts-0.2.1-darwin-arm64.json`, and
`release/build-validation-0.2.1-darwin-arm64.log`.

Public rollout limitations remain those in the
[full-app acceptance report](full-app-0.2.0-validation.md).
