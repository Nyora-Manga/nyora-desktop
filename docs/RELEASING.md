# Release process

`.github/workflows/release.yml` builds on pushes to `main`, pull requests and manual dispatches. Pull requests validate but cannot publish. Native runners cover macOS, Windows and Linux on x64 and ARM64. Runner labels follow [GitHub's hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). [Electron 44 supports 64-bit x64 and ARM64](https://releases.electronjs.org/release/v44.0.0); 32-bit builds are not available.

## Versioning

The checked-in `package.json` contains a release baseline, initially `0.3.0`. CI adds `GITHUB_RUN_NUMBER` to its patch number and writes the same version into the npm lockfile and bundled app. Thus run 1 produces `0.3.1` / tag `v0.3.1`; rerunning that run retains its version. When changing the major/minor line, change the baseline in both package files. Release notes identify the exact source commit.

## Build gates

Each target builds its own JVM helper and trimmed runtime, runs JVM tests and native library/database restart checks, then runs the frontend/Node tests, browser smoke and packaged Electron checks. Packaging uses the verified helper for that exact OS/CPU. The assembled app is exercised before installers are produced. Checks are not skipped to make a release green.

`stage-release.mjs` records artifact sizes and SHA-256 hashes. `publish-release.mjs` independently verifies all six target manifests and refuses missing targets, mixed versions/commits, duplicate filenames or altered bytes. Assets upload to a draft release; it becomes public only after every upload succeeds. A failed matrix creates no public release. A failed upload leaves a draft for a safe retry.

## Distribution mirrors

The `nyora-mac`, `nyora-windows` and `nyora-linux` default branches contain installation instructions and the mirror workflow. Their old native code remains in Git history and a `legacy/native-desktop` branch. Old native release workflows are removed from the default branch.

Each mirror's own `GITHUB_TOKEN` can write only that repository. It reads the canonical release, requires a complete six-target manifest, downloads its two architectures, verifies every SHA-256 hash and publishes both together. Public upstream releases require no cross-repository write token. Mirroring runs on a roughly 15-minute schedule or manual workflow dispatch; GitHub may delay scheduled runs. An already published release is never silently overwritten.

If the canonical source repository remains private, each mirror additionally needs a read-only `DESKTOP_RELEASE_READ_TOKEN` with access to its release assets. Do not use a broad personal write token. This secret is unnecessary for a public canonical repository.

## Runtime selection

The macOS ARM64 Java build uses the pinned verified archive already exercised locally. Other targets use Actions setup-java with native Zulu JDK 17, then validate and record the exact vendor/version and linked-runtime hashes. They must run on matching native runners. Runtime manifests accompany the central release. A native CI failure must be repaired before describing that target as supported in a shipped release.

## Signing and updates

Initial installers are unsigned and macOS builds are not notarized. Installation instructions state this explicitly. No unsigned silent updater is enabled. Adding signing requires platform certificates/secrets and another native validation run; a missing certificate never becomes a false signing claim.
