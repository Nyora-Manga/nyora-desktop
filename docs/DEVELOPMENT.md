# Nyora Desktop

Nyora Desktop builds the bundled shared reader from `vendor/web/web/` into ignored `dist/`. The bundled helper source lives in `vendor/helper/`; no sibling or private checkout is required. `frontend/` and `scripts/*overlay.mjs` contain the desktop adapters and UI transformations. See [release automation](RELEASING.md) and [installation/migration](INSTALL.md) for the current 3.x distribution process.

The desktop reading room uses a focused sidebar, a Library resume card, compact
collection controls, local library results in Search, and searchable Sources and
chapters. Cover actions are available by keyboard as well as right-click.
Settings uses category/detail columns in wide windows and drill-down navigation
in smaller windows. Fresh profiles start with soft-dark surfaces; saved appearance,
accent, and density choices remain in effect. Poppins headings are bundled with
an OFL license, and body text uses system fonts, so typography needs no network
request. Community links live in About. See the
[redesign implementation and validation notes](reading-room-redesign-validation.md).

The app uses a separate native browser profile and isolated native helper data directory. The bootstrap hydrates library, history, bookmarks, categories, updates, statistics, source preferences, and device preferences before importing the shared app. Library and source state are authoritative in the local JVM helper; device preferences use an atomic native profile file, with API keys protected by Electron safeStorage. Browser localStorage and IndexedDB are not personal-data fallbacks. Content requests use named preload operations against the local helper, and images use a source-bound native image route.

The desktop app includes persistent downloads, offline chapter reading/export, CBZ/ZIP and image-folder imports through native dialogs, native chapter read marks, search history, and complete per-title reader controls. Download jobs survive restart; cancellation and retries preserve the queue, and only fully validated chapters appear complete. Local media is copied into the application's private offline library. Imported originals remain untouched. Offline image URLs use opaque book IDs and per-launch capabilities.

Settings includes Nyora Cloud email/password sign-in and registration, explicit **Merge and sync**, and sign-out that retains local reading data. The shared engine performs reconciliation, with session tokens exchanged privately with main and saved through OS encryption; the renderer never receives tokens. No background account merge or destructive cloud replacement is performed. AniList supports the same access-token connection as the previous Mac client, including search, linking and progress/status updates. Other provider OAuth connections require verified desktop registrations and are not presented as working sign-ins.

Library writes still resolve after native acknowledgement and cache refresh. Portable `.nyorabk` export and reviewed Merge import use OS file dialogs. Neither filesystem paths nor backup bytes are exposed to the renderer. Import reloads native caches; a failed reload blocks editing until the native state is available. Portable backups cover the shared library, not device-local downloads, imported media, account credentials, search history or supplemental reader overrides. Export downloaded chapters separately as CBZ or a bundle.

The upgrade retains `app.nyora.desktop.preview/electron` and the internal OS credential name from the previous preview. The app is displayed as **Nyora**. Existing native Mac/Windows/Linux profiles are not overwritten or automatically converted; use the portable backup/merge flow and retain the old client until counts and reading progress have been checked. See [existing-user guidance](INSTALL.md).

Desktop menus, persisted window bounds, bounded renderer recovery and safe-read helper recovery support everyday use. A failed write is never automatically replayed. The app stops recovery loops and offers a native recovery choice after repeated failures.

**Search** in the sidebar (Cmd/Ctrl+K) opens quick navigation, Continue
reading when an exact saved chapter is available, and local comic imports.
Cmd/Ctrl+/ opens keyboard help; Cmd/Ctrl+1–9 opens Library, Discover, Browse,
Search, Downloads, History, Bookmarks, Updates and Stats. Reader shortcuts respect
text fields and open dialogs. Library search, source/history filters and Recently
read sorting operate on the saved native library within the selected collection.

Desktop Search, dialogs, navigation and library controls use short transitions.
Search waits for its exit before opening the selected action and safely handles
rapid close/reopen. Reduced-motion preferences remove the added motion and close
Search immediately, including when that preference changes while the app runs.
See the [Search and motion validation](search-motion-0.2.3-validation.md).

Downloads offers **Pause queue**, **Resume queue** and **Retry failed**. Pausing
lets running chapters finish and holds the remaining queue across restart.
Retry failed skips cancelled jobs and sources waiting for verification. Queue
changes are acknowledged only after saving; progress polling retains keyboard
focus. Native Dock/taskbar progress follows the current batch, with paused mode
on Windows and supported Linux docks using the matching desktop entry. Runtime
acceptance is recorded separately for each OS. See the
[feature upgrade validation](feature-upgrade-0.2.3-validation.md).

The Mac ARM build bundles a pinned, checksum-verified Azul Zulu Java 17 runtime, replacing the Temurin runtime that crashed on this host. Every native release target must pass the helper JVM suite and the packaged runtime gates. Per-release reports identify the tested platform, architecture and exact bundled runtime. The app requires macOS 14 or newer. No Intel JVM or system-Java fallback is used. Missing helper startup still fails visibly without browser persistence. See [runtime update and release gates](runtime-updates.md).

From this directory:

```sh
npm ci --cache /tmp/nyora-desktop-npm-cache
npm run setup:runtime
npm run build:frontend
npm run build:helper
npm test
npm run smoke:frontend
npm run dev
```

Electron's binary download must finish during installation. If your npm installation policy skips its install script, run `node node_modules/electron/install.js`. `npm run dev` builds the shared frontend, launches the sandboxed Electron shell with its bundled local HTTP server, and watches web/overlay changes. Refresh the window after rebuilding. `npm start` launches an already built frontend.

The packaged app starts and stops its own server on an available `127.0.0.1` port. It serves frontend assets directly from ASAR and source images through authenticated native services; no separate server installation or command is needed. Image URLs use that exact launch origin and a signature bound to the source and remote URL. Relative media paths resolve against the source, stale proxy URLs are reissued, and parser-specific manga/chapter keys remain unchanged. CDN rewrites retain the source's Chromium cookies and Referer. Reader retries preserve the signed parameters. Public metadata covers use CORS, and desktop MangaBaka requests use its current `.org` API.

Failed online reader images retry automatically after 1, 3 and 8 seconds while
keeping the current chapter and visible page position. Successful pages stay
loaded. Offline or verification-paused pages wait for recovery; leaving the
reader cancels its pending retries. After the automatic budget is exhausted,
**Reload** remains available. Named source reads also retry classified temporary
connection failures, without replaying writes or parser errors.

`npm run test:images` decodes browse covers, details covers and reader pages through the real native helper, production relay, Chromium HTTPS transport and local HTTP server. It uses disposable offline source fixtures. Packaging runs this check against the assembled ASAR and bundled helper before generating installers; failures stop packaging.

The default shared input is `vendor/web`. Set `NYORA_WEB_DIR=/path/to/nyora-web` only when intentionally testing another checkout. The required ORT JavaScript and WASM files are already included under `vendor/web/web/vendor/ort`. Material Web resolves from this package's installed development dependency. `NYORA_SHARED_DIR` similarly overrides the default `vendor/helper` source.

`npm run dev:frontend` independently builds/watches inputs and serves generated assets at `http://127.0.0.1:1420`. The server rejects directory listing, traversal, hidden files, wrong Host headers, and symlink escapes, and sets worker isolation headers. Builds serialize through a recoverable PID lock. Each build snapshots web inputs, desktop overlay files, and transformation scripts before changing them. It verifies overlay/scripts/package/lock stability before promoting the completed output, so a failed or changing build preserves the previous `dist/`.

`npm run smoke:frontend` starts a temporary server and exercises the bundle in headless Chromium with synthetic data. It poisons browser personal-storage access, checks helper-unavailable retry, native-cache hydration, successful and rejected favourite writes, explicit source verification/retry, and native feature screens. It uses installed Google Chrome on macOS when available; otherwise install Playwright Chromium (`npx playwright install chromium`) or set `CHROMIUM_PATH`. Its mocked preload checks do **not** prove native Electron behavior. `npm run test:runtime` runs the separate real native runtime smoke harness and is excluded from default unit tests. Platform evidence is tracked in [the runtime matrix](runtime-matrix.md).

A **Verify source** action is available in the source catalogue, picker and browse header. A source notice offers explicit verification and retry for failed content reads and images, including in the immersive reader. After completing the site's check and closing its window, Nyora automatically retries that source's failed reads, images and verification-paused downloads. Image retries keep the reader position. Its target comes from the native catalogue/challenge record; it never automatically opens a window or replays a mutation. Opening or closing a verification window never marks a challenge solved. The header’s × button hides Discord and website links and remembers the choice across restarts. Restore them in Settings → Appearance → Community links. The duplicate Discord sidebar shortcut is removed. Settings → Advanced contains source selection, session reset and collapsed runtime diagnostics. Close a source window before requesting reset; teardown errors remain visible.

Protected requests run in private, inert Chromium frames using the verification window's persistent source session and the requested origin's top-level cookie partition. This retains partitioned clearance cookies that `Session.fetch` omitted in the native regression fixture. No source scripts run in those transport frames; source service workers are bypassed, headers remain relay-controlled, and redirects return to the relay for validation before following. `npm run test:cf` checks window-issued partitioned cookies, source isolation, read-only POST, redirect cookies, exact CDN grants, service-worker bypass, cancellation and reset against real Chromium. Packaging repeats this against the assembled ASAR; these offline fixtures do not prove every live site's challenge will accept an embedded browser.

Source cookies save automatically after changes and when the verification window closes. There is no manual Save cookies control. Transient storage failures retry automatically with bounded backoff. After you complete verification and close the window, Nyora retries the affected reads and images once, checks fresh parsed content, and removes the prompt when access succeeds. A continuing challenge stays actionable without reopening windows or retrying in a loop. Cookie values never reach the interface. Site expiry remains unchanged. `npm run test:cookies` verifies that window-issued, persistent HttpOnly partitioned cookies survive an immediate forced restart and still authorize content/images. Its old-behavior control reproduces the lost-cookie failure. Packaging requires this test against copied ASAR modules. Desktop controls use the shared themed buttons and inputs, wrap at narrow widths, and keep runtime diagnostics collapsed separately.

Source notices follow the current manga, reader or selected Explore source. Checks
from other sources stay available through their source controls. Search, Downloads,
Settings and source-management screens group multiple checks behind a collapsed
summary. Each notice has an accessible × dismissal; hiding it does not reset a
session or mark a challenge solved. A new verification cycle can show it again.
Guidance is available under **How to verify** instead of repeating across the page.

The native catalogue includes all 260 eligible Cloudflare-labelled sources among 605 entries, including all 175 eligible Wall-B entries hidden from solverless web clients. KlikManga and EpsilonScan are restored only with the isolated Chromium relay: their recorded failure was a Cloudflare challenge, rather than a confirmed parser failure. Exact identity/engine/domain and conflicting health metadata are checked before applying this exception; hosted behavior is unchanged. EpsilonScan is additional to the labelled count because its catalogue row lacks a CF label. Other excluded CF-labelled rows retain the existing engine and health policy; they are not all claimed to be verified dead. `npm run test:catalogue` checks the complete actual helper catalogue against the pinned source/engine/health policy, with all upstream requests forbidden. Packaging requires that check to pass. Site access still depends on the site's checks: [Cloudflare documents limited support for embedded browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/).

Package the current platform's app directory or explicitly configured architecture targets:

```sh
npm run package:dir
npm run package:mac
npm run package:win
npm run package:linux
```

Artifacts go to ignored `release/`. Platform scripts select one ARM64 target: macOS DMG/ZIP, Windows NSIS/ZIP, Linux AppImage/tar.gz. Use the target OS's build tools for its packaging jobs; configuring a target does not establish that its installed app has passed platform acceptance. Packaging is local with publishing disabled and signing credential discovery disabled. It bundles Electron/Chromium, the app's main/preload files, and generated frontend into ASAR. `extraResources` includes the helper JAR and bundled Java 17 runtime, so the installed app has no system Java/Chrome requirement. Run `build:helper` with a verified native JDK 17 on the target platform/architecture first. Packaging checks the staged helper manifest and refuses a platform/architecture mismatch or a multi-architecture request; each target requires its own matching runtime. Every helper build runs the JVM suite and native JIT/library/database restart checks. Packaging verifies the copied runtime again before creating an installer. Failed stages preserve the previous working resources. Packaged binary fuses disable RunAsNode, Node options/inspector arguments, and non-ASAR app loading; ASAR integrity validation is enabled where supported by Electron.

Dependencies are pinned in `package-lock.json`: Electron `44.5.1`, electron-builder `26.15.3`, Material Web `2.5.0`, esbuild `0.28.2`, Playwright `1.63.0`, and Acorn `8.18.0`. Node `>=22.12.0` is required by the selected Electron installer. The build emits `dist/frontend-manifest.json` containing source Git metadata, the exact staged web input tree SHA256, captured overlay/scripts SHA256, package/lock hashes, and runtime pins. Preserve matching input bytes when reproducing artifacts, including any intentionally overridden source checkout.

Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and the stable [electron-builder v26 configuration](https://www.electron.build/v26/docs/configuration/) describe the sandbox, preload, and packaging APIs used here. The runtime gate must still verify these settings in actual packaged apps.

## Application completion checks

`npm run test:offline` exercises the real Electron decoder, offline library and local server with disposable files; `npm run test:recovery` forces actual renderer/helper failures and checks bounded recovery. Both are required against copied ASAR modules during packaging, alongside image, Cloudflare and cookie checks. `npm run test:runtime:native` exercises the complete UI with the real bundled helper and a disposable profile.

The 3.x workflow builds and validates all six native targets before publishing. Initial public installers are unsigned and macOS builds are not notarized; there is no background unsigned updater. Use the release validation reports for exact platform evidence and the installation guide for supported backup migration. The [runtime policy](runtime-updates.md) describes required checks before changing Java/Electron. Keeping the internal app name preserves the credential service used by [Electron's encryption setup](https://github.com/electron/electron/blob/v44.5.1/shell/browser/electron_browser_main_parts.cc#L598); a consistent distribution signature is also needed to avoid repeated [macOS credential prompts](https://www.electronjs.org/docs/latest/api/safe-storage).

OCR/colorization remain experimental. The renderer can fetch its pinned models and use the default Google, OpenAI and Anthropic endpoints; custom AI endpoints are rejected explicitly. Model caches currently belong to the launch-specific loopback origin and may need downloading after restart. Full model inference, paid provider calls and performance budgets are not part of this build's acceptance evidence.

About shows the captured app version and one set of Website, Project on GitHub, Discord and License links, each with its icon and text label. Duplicate social icons, cross-platform marketing and the web-client issue link remain removed.

The latest source repair restores CerberusSeries and KomikLokal using their current site layouts, fixes public WordPress CDN images rejected by an incorrect address mask, and replaces endless loading for unavailable source links with clear actions. KomikLokal is classified as 18+ to match its current catalogue. The native catalogue now has 605 available sources. See the [source repair checks and current build evidence](disabled-sources-0.2.3-validation.md).
