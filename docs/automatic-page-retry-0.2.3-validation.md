# Nyora 0.2.3 — automatic reader image recovery

Failed online reader images now retry in their existing slots after 1, 3 and 8
seconds. The original image, chapter, reader settings and visible page position
are retained. Successful pages are not fetched again. The placeholder explains
when a retry is running, the device is offline, or the source needs verification.
After three automatic attempts, the existing **Reload** action remains available.

Offline pages wait for the browser's online event. Known active source checks
pause automatic attempts. Closing verification still saves cookies and starts
source recovery automatically. A retry already in flight before the close cannot
stand in for the fresh request needed to validate that verification cycle; one
fresh request follows it, with repeated recovery calls coalesced. Leaving the
reader cancels its pending retries. These changes apply to signed native online
reader images; they do not repeatedly reload the app or damaged offline files.

Named content GETs also retry typed temporary connection/timeout and HTTP
429/502/503/504 failures twice. Parser errors, generic helper HTTP500 responses,
new verification challenges and writes are excluded. Every physical attempt
obtains its own native verification checkpoint. Partial successful recovery no
longer turns a remaining ordinary image failure into another verification prompt.

Validation on 2026-10-05 (Asia/Kolkata), native Mac ARM:

- All **299 desktop tests passed**, with no failures or skips. Regressions cover
  the per-image retry budget, coalescing, offline/verification gates, detachment,
  explicit cancellation during a queued verification retry, fresh native proof
  per request and partial verification recovery.
- The mandatory browser smoke passed. Two transient image failures recovered on
  exactly the third physical request, with the same image and reader, unchanged
  chapter/counter and visible later-page position, and no successful-page refetch.
  Permanent failure stopped at one initial request plus three retries; manual
  Reload still worked. Offline resume, navigation cancellation, verification
  pause/close recovery and signed query preservation passed.
- All copied-ASAR runtime gates passed: native Chromium images, 10 verification
  checks, 5 cookie-durability phases, 3 crash-recovery checks, offline download/
  import/export and fresh-process reading, and 5 encrypted-account checks.
- The helper and Java pins remain unchanged: revision `2.0.7-desktop-relay.6`,
  native ARM Azul Zulu 17.0.20.1+1-LTS. No Intel runtime or system Java is used.

- Mac ARM app, DMG and ZIP built successfully. The normal 0.2.3 app was reopened
  with the existing profile retained (PID 79121). Its bundled frontend and retry
  chunk, isolation headers, private helper and unsigned-image rejection passed.

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | `8cf575d600892a71762bf0e945a3a8d06089a9583a78022554f5aacaa71e33da` |
| `Nyora-0.2.3-mac-arm64.zip` | `6cb815e293c1e2b07396171654a3832eb960f8ce82f331d8df4838a2a5855969` |

This build and its evidence are archived under
`release/history/0.2.3-before-about/`: `runtime-validation-0.2.3-darwin-arm64.json`,
`normal-launch-0.2.3-darwin-arm64.json`, `artifacts-0.2.3-darwin-arm64.json`, and
`build-validation-0.2.3-darwin-arm64.log`. The About follow-up rebuild has its own
[acceptance report](about-links-0.2.3-validation.md).

These bounded retries cannot repair a removed image or guarantee acceptance by
every live source. Public rollout limitations remain those in the
[full-app acceptance report](full-app-0.2.0-validation.md).
