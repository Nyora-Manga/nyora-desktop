# Desktop Chromium runtime verification

The 3.x release workflow validates macOS, Windows and Linux on native x64 and ARM64 runners. Each [published central release](https://github.com/Nyora-Manga/nyora-desktop/releases) includes six `runtime-validation-PLATFORM-ARCH.json` reports. See [RELEASING.md](RELEASING.md) for the current build gates and [INSTALL.md](INSTALL.md) for installation. A configured target is publishable only after its complete native CI job passes.

The preview evidence below is historical; it describes the local 0.x development runs before six-platform CI was introduced.

The active shell is Electron 44.5.1, selected after the user changed the framework. Tauri/CEF is a superseded experiment; its compile evidence and blockers are recorded in the internal Task0 native report. Existing Electron data and encrypted sessions are retained. Older native-client profiles are not read or automatically converted.

## Active baseline

| Component | Pinned value / implementation |
| --- | --- |
| Electron |44.5.1 (`package-lock.json`) |
| Electron Builder |26.15.3 (`package-lock.json`) |
| Browser identity |Actual `process.versions.chrome` through the restricted runtime-status operation; not inferred from package names |
| Local UI origin |`http://127.0.0.1:<ephemeral-port>/index.html`, served from ASAR by the bundled main-process HTTP server; IPC requires this exact launch origin |
| Browser isolation |Global `app.enableSandbox`; sandbox/context isolation enabled and Node integration disabled for every window |
| Main bridge |Nine fixed methods exposed through sandboxed contextBridge, including an allow-listed native-menu navigation subscription: runtime status, verification open/reset/status, source cookie save, named service request and native backup export/import; caller must be the main window's current top frame at the bundled origin |
| Source sessions |Persistent Chromium partition per SHA256 of canonical `data:<catalogue-id>`; inert per-target-origin request frames preserve CHIPS; no source preload or local UI authority |
| Targeted reset |Close that source window, terminate that partition's connections, clear HTTP auth/storage/cache, then flush; other partitions remain intact |
| Quit durability |Drain pending source operations; flush cookies and DOM storage before normal application exit |
| Cookie durability |Bounded automatic saves after cookie changes; verification close awaits native flushing and transient errors retry with bounded backoff; no manual Save control; original expiry retained |
| Production diagnostics |DevTools disabled; unsafe sandbox/security/remote-debugging/inspector startup switches rejected |
| Smoke diagnostics |Explicit unpackaged `--nyora-smoke`, existing absolute temporary profile, loopback CDP port1024–65535; refused in packaged builds |

## Historical preview evidence and platform gates

| Target | Build/package | Installed/offline launch | Browser/native IPC | Source isolation/restart/reset | Sandbox/signing |
| --- | --- | --- | --- | --- | --- |
| macOS arm64 |Full ARM app, DMG and ZIP built with verified bundled Zulu/helper; copied app runtime passed write/restart gate |v0.2.3 normal packaged ARM app launched with the existing preview profile retained; bundled HTTP assets/isolation and private helper startup confirmed |Passed 8 missing-helper/session checks and 7 actual native-helper/UI checks, browser 152.0.7977.130 |Passed two-source cookie isolation, restart persistence and targeted reset |Actual preload reports rendererSandboxed=true/contextIsolated=true; package fuses verified; signing/notarization not performed |
| Windows arm64 |Not run |Not run |Not run |Not run |Not run; superseded CEF Windows blocker does not establish Electron behavior |
| Linux arm64 |Helper compile/JAR and full JVM tests passed; Electron package not run |Disposable helper process launch/restart passed |Real helper REST and backup broker passed; Electron UI not run |Synthetic helper relay identity/failure checks passed; Chromium runtime not run |Not run; usable Chromium sandbox and system secret store still required |

This run uses native ARM only. Configured x64 targets need later validation on matching runners; no Intel/Rosetta fallback is used.

`node --test electron/policy.test.cjs electron/challenges.test.cjs electron/relay.test.cjs electron/catalogue.test.cjs` passed41/41 tests covering canonical keys, hostile URLs, the actual privileged caller predicate, challenge detection and parser proof, catalogue origins/hash verification, read-only Madara POST policy, retries/bytes/timeouts, dedup/cancellation and private relay authorization/network policy, and reset cancellation/draining. Targeted reset pauses source relay requests and waits for actual native fetch settlement before clearing; an unsettled transport fails reset without clearing. The earlier unpackaged transport smoke covered unpartitioned cookies through `Session.fetch`. The production transport now uses inert Chromium frames because the native CHIPS control demonstrates that `Session.fetch` omits window-issued partitioned clearance. The new native CF fixture runs production relay/verification/transport modules and passes ten checks: HTTP200/403 challenges, partitioned clearance and source isolation, approved POST/headers/UA, redirect cookies and forbidden-hop rejection, exact CDN media, service-worker bypass, oversized response rejection, cancellation and reset without late cookies. Packaging repeats this against the copied ASAR. Only fixture tests preserve a local CONNECT proxy; production selects direct networking. Main/preload syntax checks passed. The 8-check interactive runtime evidence lives in `test-results/runtime-smoke/` (ignored artifacts). These results do not establish signed installed-app or cross-platform support.

The previous v0.1.4 packaging gate passed **190 desktop tests**: 49 frontend, 71 Electron cookie/policy/transport/relay/catalogue/local-server, and 70 helper/broker/lifecycle/media tests, with no failures or skips. These include bounded browser contexts, native cancellation/reset ownership, quit durability with hidden windows, proactive verification and in-place image retries. The frontend browser smoke verifies exact source IDs, automatic close-and-resume, repeated-challenge bounds, keyboard focus preservation, explicit network retry and retained browse search state, and recovery of a replaced reader image without navigation, reader-position loss or refetching successful pages. All 25 responsive layout scenarios pass across five window widths; desktop controls retain the shared theme and wrap without overlap or clipping.

The current native Mac ARM helper passes **230 JVM tests across 40 classes**, with
zero failures/errors/skips. Revision `2.0.7-desktop-relay.6` has JAR SHA256
`7869e2e6ad7335cdad9487e496d275ea181930ddab04904494aaf9bb262db953`.
Four native freshness regressions verify forced fresh popular/latest/search reads,
synchronous expired native browse failure, reader refresh, and unchanged hosted
stale-while-revalidate behavior. Existing source-policy regressions remain green.
The earlier Linux ARM revision `.3` passed 217 JVM tests across 37 classes; `.6`
has not been rebuilt there. That Linux ARM backup broker round trip preserves
exact personal-section and tracking identities, validates export and repeated
Merge, and confirms restart.

Mac uses pinned Azul Zulu CA 17.0.20.1+1-LTS (native ARM), official archive SHA256
`ed54397260c5994b2fc4e31c780f480b947e6532bc6a5ac7754355d5dd4c127d`.
The final linked runtime tree SHA256 is
`32934591f0dcb9a40238752d0b563de8206d28d82261249841ae8689e4b94eb4`.
Its release manifest records successful JIT/interpreter/native ZIP and isolated
SQLite write/restart checks. See [runtime update gates](runtime-updates.md).

## Integration and remaining release gates

Source windows deny unsolicited popups, downloads and permission grants; explicit source verification windows are implemented. Opening one returns `status:"opened"` and never declares a challenge solved. Main records source challenges after the private relay validates request authority. Pending content clears only after the original named helper read returns usable parsed data, or the exact protected image succeeds; unrelated successful requests do not clear it. HTTP200 challenge HTML and opening a verification window remain pending. A private authenticated loopback relay preserves source responses using those same persistent sessions, refuses unlisted origins/private DNS addresses, strips passed credentials and denies POST except approved read-only Madara forms. The trusted compiler processes all 1,105 current catalogue entries. The runtime loader verifies the packaged descriptor file's exact SHA256 before admitting sources; known API/CDN host grammar and configured literal hosts are exact grants. Referer-only configuration does not grant fetch/navigation authority. Exact image URLs in authenticated, parsed helper responses can receive bounded, expiring source-specific media grants, including dynamic CDNs. This does not grant a whole origin, accept renderer enrollment, or permit media POST requests. Unapproved engine POST forms and signed API headers remain blocked; live source compatibility is not established by synthetic fixtures. The image acceptance test joins the actual native helper, production relay, Chromium HTTPS transport and signed local server against offline Atsu fixtures. Browse/detail covers and reader pages decode with source cookies and Referer retained through the CDN rewrite. Tampered targets are rejected. Packaging repeats this against assembled ASAR modules and bundled helper before installer creation. Actual Electron ASAR serving also passes CSS, isolated worker and streaming WASM checks. A complete installed app using live sources remains a separate gate. Mac minimum OS is 14.0, matching the pinned vendor support baseline. Native consumer menus provide navigation, backup actions, editing, reload, zoom and fullscreen. Bounded renderer/helper recovery is implemented; automatic replays are limited to trusted helper GETs. Full keyboard/fullscreen acceptance remains separate. Installed native dialog/backup acceptance, updater delivery, external OAuth/deep-link handoff, signing/notarization and cold-start/resource budgets remain unverified. Automatic existing-profile migration and Replace stay disabled. Native `.nyorabk` export and reviewed Merge are implemented; the broker has real Linux ARM helper/codec evidence, with cohort acceptance still separate.

The eight-check runtime harness deliberately omits helper resources to cover visible missing-helper failure and session isolation, including actual cookie-save IPC returning metadata without values. The separate `test:runtime:native` passed six checks with the real bundled ARM Java/helper: authenticated readiness and Chromium transport, actual shared UI hydration, all 603 emitted catalogue IDs matching packaged authority, fixed service boundaries, native library writes and persistence across full Electron/helper restart. External sources were blocked; the only seeded fixture metadata was written while the helper was stopped. All library mutations used production named IPC. The visible trusted main window also acquires and releases a real screen wake lock; remote windows and other permissions stay denied. Permission handling uses the documented [Electron session callbacks](https://www.electronjs.org/docs/latest/api/session).

The cookie regression uses five isolated native process phases. A negative control reproduces newly issued persistent CHIPS loss when force-quit before the old delayed write. Production automatic and explicit saving preserve window-issued HttpOnly partitioned clearance across force-quit/restart, with protected content and image bytes fetched using the production transport. Session-only cookies expire normally, and resetting one source remains durable while retaining the other. Packaging repeats this using copied ASAR modules. Save receipts do not prove that a site's challenge has been passed. The implementation uses Electron's documented [cookie change events and flushStore](https://www.electronjs.org/docs/latest/api/cookies).

The verification close lifecycle has an opaque ID; the frontend retries each closed cycle once, waits for automatic session persistence, and clears notices only from native proof. Successful source buttons return to Open website. Continued challenges offer Verify source; ordinary loading failures offer Try again without reopening a window. Main-owned verification reads bypass helper caches. Requests already in flight when a new relay challenge appears cannot clear that newer challenge; renderer read ordering also preserves newer failures. Failed reader images recover in their existing slots, and Explore preserves its current mode, query and page. The built browser workflow is now a required packaging gate.

The public HTTPS validator blocks direct IP hosts, local/reserved names, credentials, unusual ports and privileged schemes. It is not DNS-rebinding protection or a source-authority lookup. Remote sessions have no preload API or direct file/loopback request routes. The local HTTP server checks Host, Origin and fetch metadata, and signs each source/target image query with a per-launch secret. Asset traversal and symlink escapes are denied. Image disconnects abort the helper HTTP request; shutdown drains work before stopping owned processes. This does not claim per-request cancellation of the JVM source fetch.

Implementation follows Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security), [persistent session and reset APIs](https://www.electronjs.org/docs/latest/api/session), and [navigation events](https://www.electronjs.org/docs/latest/api/web-contents).

The previous v0.1.4 Mac ARM DMG/ZIP were generated only after the assembled ASAR and its own bundled helper pass cover/details/reader image decoding, retries and target-tampering rejection, the copied transport passes ten native CF checks, and the copied cookie coordinator passes all five native durability phases. That earlier evidence is retained in its task report; the runtime-validation JSON now records 0.2.0. The normal packaged app was then opened with its existing preview profile: HTTP frontend assets and isolation headers passed, unsigned images were rejected, and the private helper required authentication. No debug switches or profile reset were used. Artifact checksums are in `release/artifacts-0.1.4-darwin-arm64.json`.


## Full-app release: 0.2.0

The Mac ARM app, DMG and ZIP are built and the normal app is running with the
existing Electron profile retained. The mandatory packaging suite passes 259
desktop tests. Copied ASAR/helper gates also pass native images, 10 CF checks,
5 cookie phases, 3 crash recovery checks, complete offline download/import/export
and fresh-process no-network reading, plus 5 real OS-encrypted account checks.
The offline gate additionally reproduces and prevents the mixed ordinary-cookie
plus partitioned-clearance regression. Missing stored pages are reported as
damaged, and offline reader preferences and page progress survive restart.

Cloud and AniList account flows, local imports, downloads and reader controls now
have native implementations. About/Settings retain Nyora Web's layout with
consumer desktop controls. Existing-profile automatic conversion, signed updates
and native Windows/Linux acceptance remain rollout gates. See the
[0.2.0 acceptance report](full-app-0.2.0-validation.md) for scope and artifact hashes.


## Previous release: 0.2.1

Community header links now have a persistent × dismissal and an Appearance
restore switch; the duplicate Discord sidebar link is removed. All 259 desktop
tests, 25 layout scenarios, seven actual native UI/helper checks and all copied
ASAR package gates passed. The normal Mac ARM app was reopened with the existing
profile. See [0.2.1 evidence and artifact hashes](community-links-0.2.1-validation.md).

## Previous release: 0.2.2

Verification notices follow the active source and can be dismissed. Multiple
checks stay behind a collapsed summary on management screens. Native proof now
tracks each failed request/image independently, and a fresh exact search returning
zero matches no longer leaves an unretryable prompt. All 274 desktop tests, full
browser smoke, 25 layout scenarios and all copied-ASAR package gates passed.
The normal Mac ARM app was reopened with the existing profile retained. See
[0.2.2 evidence, limitations and hashes](source-verification-0.2.2-validation.md).


## Current release: 0.2.3

Failed reader images retry automatically with a bounded budget, retain the same
image and visible reading position, pause offline or during verification, and
cancel when the reader closes. Manual Reload remains usable after exhaustion.
Post-verification recovery dispatches fresh proof and does not mislabel temporary
remaining failures as a new challenge. All 299 desktop tests, the full browser
smoke and all copied-ASAR runtime gates passed. Mac ARM app/DMG/ZIP were built,
and the normal app reopened with the existing profile and bundled local server.
See [0.2.3 evidence, limitations and hashes](automatic-page-retry-0.2.3-validation.md).

The 0.2.3 About follow-up rebuild retains the version and profile, displays the
captured build version, and replaces duplicate promotional links with three
verified project resources. All 299 desktop tests, full browser smoke, 30 layout
scenarios, copied-ASAR runtime gates and 12 native link-handoff checks passed.
The updated normal app was reopened. Current hashes are in the
[About follow-up report](about-links-0.2.3-validation.md); the prior 0.2.3 artifacts
and receipts are retained under `release/history/0.2.3-before-about/`.

The current About rebuild adds Discord once alongside Website, Project on GitHub
and License. It passes the same 299-test packaging suite and 30 layouts, plus
13 copied-ASAR native link checks. Current hashes and receipts are recorded in
the [About report](about-links-0.2.3-validation.md#current-four-link-build).

The latest local 0.2.3 rebuild adds shared icons beside the four About labels and
allows a single row where desktop width permits. All 299 tests, browser smoke,
30 layouts and mandatory copied-ASAR runtime gates passed; the normal app was
reopened with its existing profile. Latest hashes and evidence are in the
[About icons report](about-icons-0.2.3-validation.md).

The subsequent local 0.2.3 source rebuild restores CerberusSeries and KomikLokal,
corrects the public WordPress CDN address mask, and handles unavailable source
links without endless loading. Its native catalogue has 605 sources, including
260 Cloudflare-labelled entries. All 309 desktop, 230 JVM and 107 data-engine
tests passed, along with browser checks and mandatory copied-ASAR runtime gates.
Both restored sources passed live browse, second-page, search, chapter and image
checks using the rebuilt helper. The Mac ARM app, DMG and ZIP were rebuilt and
the normal app reopened with its existing profile. Current hashes, live audit
limits and remaining failures are in the
[source repair report](disabled-sources-0.2.3-validation.md).

The latest local 0.2.3 balanced feature rebuild adds quick actions/shortcut help,
library search/filter/sort, durable queue pause/retry and native progress. All
344 tests, the browser suite and copied-ASAR gates passed on Mac ARM; paused
queue restart is now explicitly checked. The normal app was reopened with the
same profile. Other platform acceptance remains unchanged. See the
[feature validation report](feature-upgrade-0.2.3-validation.md).

The Search and motion follow-up renames quick actions to Search and adds brief,
reduced-motion-aware transitions. All 347 tests, captured-bundle browser checks
and copied-ASAR gates passed on native Mac ARM. The normal app was reopened with
its retained profile and bundled helper/local server. Current artifacts and
evidence are in the [Search and motion report](search-motion-0.2.3-validation.md).
