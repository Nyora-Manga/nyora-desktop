# Bundled Java runtime policy

The macOS ARM build defaults to the exact Azul Zulu CA archive in
[`runtime-lock.json`](../runtime-lock.json). It replaces the Temurin build that
crashed before Java startup on the development Mac. The working runtime is ARM
Java 17.0.20.1+1-LTS; no Intel/Rosetta or system-security changes are needed.

`npm run setup:runtime` downloads the pinned official archive, checks its exact
byte length and SHA-256, extracts into an isolated staging directory and executes
it before promoting the cache. Cached runtime contents are checked before reuse.
The [official package metadata](https://api.azul.com/metadata/v1/zulu/packages/3691a897-d345-4183-8848-68108a478a98)
publishes the archive checksum. Its size field is rounded; the lock records the
exact length of the archive matching that checksum.

`npm run build:helper` uses this pin automatically. It ignores ambient JAVA_HOME
and disables Gradle's system-JVM detection/download. An explicit NYORA_JDK_DIR is
allowed for controlled builds, but must pass the native architecture/version and
applicable vendor pin. Its manifest does not claim an archive checksum that was
never verified. Other platforms currently require that explicit, validated JDK
on a matching native runner; no runtime is guessed or silently substituted.

Every helper build must pass the JVM test suite, linked-JRE startup, default JIT
and interpreted execution, native ZIP loading, authenticated isolated helper
startup, and a SQLite write followed by helper restart. The test profile is
separate and disposable, with source networking denied. Only then can the staged
helper/JRE replace the previous resources. Failed builds retain the previous
working resources.

Before Electron packaging, the runtime tree hash must match the manifest and the
current host must pass fresh JVM/helper/restart checks and the desktop unit suite.
The complete authenticated native catalogue must match the pinned eligibility
policy, including every eligible Cloudflare source, with upstream networking denied.
The assembled app directory is tested again using its own copied runtime before
any installer/archive is generated. Its ASAR modules and bundled helper must also
pass the real Chromium image pipeline: browse/detail covers and reader pages,
source CDN rewrites, retained cookies/Referer, retry URLs and rejected tampering.
The assembled ASAR must also pass the native Cloudflare transport fixture:
verification-window partitioned cookies, source isolation, approved POST and
redirects, exact CDN media, service-worker bypass, cancellation and reset draining.
Both browser fixtures load the copied production transport. A failed check stops
installer generation; synthetic challenge fixtures do not certify live sites.
Cookie durability is a separate required gate: production automatic and explicit
saves must preserve persistent partitioned clearance through a forced process
restart, while session-only cookies expire and source reset remains isolated.
It reproduces the old delayed-write loss using a disposable negative control.
The built frontend must also pass the browser smoke before the app directory is
assembled. It checks automatic close-and-resume, continued challenges without
retry loops, source button state and in-place reader image recovery. The shared
UI must not require manual cookie saving. Native helper tests ensure verification
reads bypass cached content and expired native browse requests surface failures
in the original request instead of an unrelated background refresh.
The reader fixture also requires bounded automatic image retries, offline and
verification pauses, cancellation on navigation, unchanged successful-image
request counts, and preservation of the visible page when an earlier image
recovers. A manual Reload must remain usable after automatic retries run out.
The offline fixture requires OpenSSL on the build runner; installed users do not
need it. The app packages and manages its own HTTP server. Cross-architecture
packaging is refused. Native Electron UI persistence checks are available as
`npm run test:runtime:native`; the missing-helper and Chromium transport smoke
checks remain separate. Record all results for each release target.

To update Java, review the official vendor release and security notes, change the
explicit URL/checksum/version in the lock, then run setup, helper build, desktop
unit tests, frontend smoke, both runtime modes and transport smoke on each target
OS/architecture. Test the packaged app before signing or publishing. Never add a
fallback to an untested system JVM, skip a failing runtime gate, or weaken OS
security to make an update pass.

A pin is not a permanent freeze: review vendor security updates regularly and
retest after supported OS updates. No runtime can guarantee that every future OS,
hardware or security-policy change will remain compatible. These checks detect
this startup failure before a package is accepted; the app also fails visibly if
its helper cannot start, without opening an older profile or using browser data.


## Full application gates

Packaging additionally runs the copied production offline-store/download/local-file modules through real Electron image decoding and the capability-bound local server. The renderer/helper crash fixture must pass its bounded recovery and no-write-replay checks. New queue/reader/session state must survive restart in disposable profiles. Preserve both the physical userData directory and internal app name when changing the visible product name, so cookies and encrypted credentials continue using the original profile and OS credential service.
