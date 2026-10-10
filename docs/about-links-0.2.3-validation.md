# Nyora 0.2.3 — About screen follow-up

The desktop About screen previously inherited seven links from Nyora Web: a
social icon row plus duplicate text actions. It promoted Discord and linked to
the web client's issue tracker. The overlay now supplies a compact About section
with the installed build version and one set of Website, Project on GitHub,
Discord and License links. Discord was restored once at the user's explicit
request after the initial three-link rebuild. The shared Settings navigation and
theme remain in use.

There is no verified public repository or issue tracker for the new Electron
client yet. The GitHub action therefore opens the public Nyora project, labelled
as such, instead of presenting the web or old native client's source as this
build. The Discord action uses the verified invite
`https://discord.gg/3ZBHA8RtbR`. Duplicate social icons, promotional copy and
cross-platform marketing remain removed from About. The existing header
community dismissal and Appearance preference are retained.

The displayed version is injected from the same captured package bytes recorded
in the frontend build manifest. No new native URL-opening API is introduced.
The resource anchors use the existing main-window HTTPS handoff to the system
browser; source windows retain their restrictions.

This is a local rebuild of 0.2.3. The previous automatic-page-retry build and its
validation receipts are retained under `release/history/0.2.3-before-about/`.

The evidence below describes the initial three-link About rebuild, before the
requested Discord restoration. Its counts and hashes are historical; they do
not establish acceptance of the four-link revision. Current four-link validation
is recorded at the end of this report.

Initial three-link validation on 2026-10-05 (Asia/Kolkata), native Mac ARM:

- All **299 desktop tests passed**, with no failures or skips, and the mandatory
  full browser smoke passed. The About regression reproduced seven duplicate
  anchors before the change; that validated screen had exactly three audited anchors,
  the captured app version, keyboard Tab navigation and a working Settings back
  action. Existing community dismissal and reader recovery checks remain green.
- All **30 responsive layout scenarios passed**, including About at 320, 390,
  760, 900 and 1280 pixels. Links fit, remain reachable and pass hit-testing.
  Desktop and narrow screenshots were visually reviewed in
  `test-results/frontend-layout/about-{width}.png`.
- All **12 native link checks passed against the copied ASAR**: each of the three
  target-blank links hands off once without an Electron popup or navigation away
  from the app; seven unsafe URLs, remote-window popups and remote subframe
  navigation remain denied. The test instruments `shell.openExternal`; it does
  not launch the user's browser. Public destinations independently returned
  HTTP 200. Evidence and a reproducible probe are in `test-results/about-links/`.
- All copied-ASAR runtime gates passed: native images, verification, cookies,
  crash recovery, offline reading/import/export and encrypted accounts. The ARM
  app, DMG and ZIP were rebuilt. The normal app reopened (PID 2271), served the
  updated About chunk and correct build version, and started its private helper
  with the existing profile retained.

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | `bb7eb868962ad08e2a2e5bfdcee17f0d90a799a31eaeeadf7bcada0df9bbb89d` |
| `Nyora-0.2.3-mac-arm64.zip` | `e923e9641945c37d54fb6a7ae597ee491902ceb987d8ab9e6d96763c88182754` |

Receipts recorded for the initial three-link rebuild:
`release/runtime-validation-0.2.3-about-darwin-arm64.json`,
`release/normal-launch-0.2.3-about-darwin-arm64.json`,
`release/artifacts-0.2.3-about-darwin-arm64.json`,
`release/build-validation-0.2.3-about-darwin-arm64.log`, and
`release/about-links-0.2.3-darwin-arm64.json`.


## Current four-link build

Discord appears once in About, opening the Nyora invite in the system browser.
The invite API returned HTTP 200 and the expected Nyora guild on 2026-10-05
(Asia/Kolkata); see `test-results/about-links/discord-invite.json`.

The fresh build passed all **299 desktop tests**, the full browser smoke,
**30 responsive layout scenarios**, all copied-ASAR runtime gates, and
**13 native link checks**, including Discord's single browser handoff. The
normal ARM app reopened (PID 7176) with the existing profile, updated About
assets, native image retries and bundled private helper checked.

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | `176399e179a5c346cb2766c5d1177e1f1973e245d406746150f10c7a168b9b42` |
| `Nyora-0.2.3-mac-arm64.zip` | `641a718214f885f732b17e3de7d5c1c03ef33a3b639fe7bd57a4af859ebad00a` |

Current receipts in `release/`:
`runtime-validation-0.2.3-about-discord-darwin-arm64.json`,
`normal-launch-0.2.3-about-discord-darwin-arm64.json`,
`artifacts-0.2.3-about-discord-darwin-arm64.json`,
`build-validation-0.2.3-about-discord-darwin-arm64.log`, and
`about-discord-links-0.2.3-darwin-arm64.json`.
The previous three-link installers and evidence are preserved in
`release/history/0.2.3-before-about-discord/`.

The later [About icons rebuild](about-icons-0.2.3-validation.md) adds icons beside
these four labels. The text-only installers and their receipts are preserved
under `release/history/0.2.3-before-about-icons/`.
