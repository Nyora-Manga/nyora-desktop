# Disabled-source repair — 2026-10-05

This local 0.2.3 rebuild checks the disabled catalogue entries separately from
uninstalled sources and Cloudflare verification. Before this repair, the native
catalogue exposed 603 of 1,105 definitions. Of 502 excluded definitions, 275 had
implemented engines and a broken flag without a canonical dead-source mark.
That flag alone did not establish whether their current websites were usable.

## Repairs

- **CerberusSeries (`data:legionscans`)** changed from HeanCMS to the
  MangaReader WordPress theme under `/wp/`. Its definition now uses the current
  parser, browse path and search prefix. The source identity remains unchanged.
  A temporary native fixture verified 20 browse results, 231 chapters, 53 page
  URLs and a decoded 1280 × 1820 image through the real helper and local server.
- **KomikLokal (`data:komiklokal`)** now uses its `/komik-dewasa/` listing,
  current card selectors and path-based pagination. Chapter numbers come from
  `data-num` and dates use the site's current format. The current site is adult
  content, so the definition is correctly marked 18+. The advertising-redirect
  source `data:komiklokalcfd` remains disabled.
- **Public WordPress image servers:** the Chromium relay incorrectly rejected
  all `192.0.*.*` addresses as private. The special-purpose prefix is
  `192.0.0.0/24`, with `192.0.2.0/24` reserved separately for documentation.
  Correcting the mask allows the observed public `i1.wp.com` address
  `192.0.77.2`. Exact source/image grants, redirect checks and the other private
  address restrictions remain in force. See the
  [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml).
- **Uninstalled and unavailable source links:** Explore offers an explicit
  Install action for a known uninstalled source, and catalogue/back actions for
  an unavailable source. It no longer leaves an endless loading grid. A source
  is browsed only after installation has committed to native storage.

## Live audit limits

Thirty disabled, Cloudflare-labelled candidates were checked through
the unchanged production Chromium relay using disposable profiles and bounded
homepage GETs. These are availability observations, not full reader acceptance.
Separate bounded browser checks covered KomikGo, KomikPix and ManhwaLover;
TempleScan was checked through its configured API and native transport.

| Source | Observed reason it remains disabled |
| --- | --- |
| KomikGo | Catalogue navigation timed out without a usable response. |
| KomikPix | Redirected to a robot/advertising endpoint without manga rows. |
| ManhwaLover | Chromium rejected the certificate chain. |
| TempleScan | Certificate verification failed for the homepage and configured API; no usable parser response verified. |
| KomikLokal.mom (`data:komiklokalcfd`) | Its domain redirected to unrelated advertising. |
| Old Hijala (`data:hijala`) | Its old Zeistmanga definition is obsolete; the separate MangaReader `data:hijalacom` definition is already enabled. |

No blanket health override, certificate bypass, automatic verification solver,
identity merge, user-profile reset or source JavaScript execution was added.
Sites can change or become unavailable after these checks; this audit does not
claim that every excluded source or every chapter works.

Evidence is retained under `test-results/disabled-sources/`: `health.json`,
`result.json`, `templescan.json`, the parser receipts and bounded probe notes.
Diagnostic JARs temporarily enabled only selected candidates in disposable app
copies; they are not release artifacts.

## Build validation

The final data-engine suite passed **107 tests**, and the rebuilt helper passed
**230 native ARM JVM tests**. The generated catalogue passes schema validation
and the regeneration consistency check. The actual bundled catalogue now exposes
**605 sources, including 260 Cloudflare-labelled sources**; the two existing
native challenge-only exceptions remain unchanged.

Fresh live checks against the **unmodified rebuilt helper** verified both restored
sources, including distinct second browse pages and search:

| Source | Browse / second page | Search matches | Chapters | Reader pages | Decoded first image |
| --- | --- | --- | --- | --- | --- |
| CerberusSeries | 20 / 20 | 1 | 231 | 53 | 1280 × 1820 |
| KomikLokal | 53 / 50 | 10 | 36 | 14 | 720 × 13831 |

These reads used a fresh disposable profile. No existing verification cookies
were borrowed. The receipt is
`test-results/disabled-sources/parser-real-legionscans-komiklokal.json`.
No source/config override was applied in that final probe.

The helper JAR SHA256 is
`ef6387af77c4c731c8c7a826448cb0140048d3dc9b066cc09b989069bcbc747e`.
The bundled relay catalogue SHA256 is
`96f6d330903a4cf2155446233c59329949e6df084dd5a3482f7adcfe519432ff`.

All **309 desktop tests**, the full shared-frontend browser smoke and the
mandatory copied-ASAR runtime gates passed: source images, verification,
cookie durability, renderer/helper crash recovery, downloads/offline restart,
tracking and encrypted credentials. Separate real-browser checks covered
uninstalled-source installation, rejected-write retry, unavailable-source
navigation and switching sources after leaving the unavailable view. The action
buttons were visually checked in the final centered layout.

The final Mac ARM app, DMG and ZIP built successfully. The normal application was
reopened with the existing profile (PID 91669); its bundled assets, source-fix
code, private helper and local server passed the normal-launch checks. App
version, profile path, saved sessions and helper protocol were retained.
The prior installers and receipts are preserved under
`release/history/0.2.3-before-source-fix/`.

| Artifact | SHA256 |
| --- | --- |
| `Nyora-0.2.3-mac-arm64.dmg` | `5c9e826be5d94c9d8cfdd36153ac2f42b62c42d505cdf0b55e978fb57000bee1` |
| `Nyora-0.2.3-mac-arm64.zip` | `74f5ccdecc63733cb784dfcbe646e1bb058243162b8224abf810c5daf71f7ddc` |

Release receipts: `runtime-validation-0.2.3-source-fix-darwin-arm64.json`,
`normal-launch-0.2.3-source-fix-darwin-arm64.json`,
`artifacts-0.2.3-source-fix-darwin-arm64.json`, and
`build-validation-0.2.3-source-fix-darwin-arm64.log` in `release/`.
