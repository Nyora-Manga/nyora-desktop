# Nyora desktop

The canonical Electron desktop application for **macOS, Windows and Linux**. This replaces the separate native desktop clients. Android and iOS are not part of this migration.

[Download releases](https://github.com/Nyora-Manga/nyora-desktop/releases/latest) · [Installation and migration](docs/INSTALL.md) · [Report an issue](https://github.com/Nyora-Manga/nyora-desktop/issues)

## Downloads

Every successful push to `main` builds six native targets:

| Platform | Intel/AMD 64-bit | ARM64 | Distribution repository |
|---|---|---|---|
| macOS | x64 | Apple Silicon | [nyora-mac](https://github.com/Nyora-Manga/nyora-mac) |
| Windows | x64 | Windows on ARM | [nyora-windows](https://github.com/Nyora-Manga/nyora-windows) |
| Linux | x64 | arm64 | [nyora-linux](https://github.com/Nyora-Manga/nyora-linux) |

There are no 32-bit x86 builds. Java, Chromium and the local helper are bundled. The first releases are unsigned/not notarized; see the installation guide for platform-specific steps.

A release is published only after **all six builds pass**. This repository carries every target. Platform repositories mirror their two architectures unchanged, with SHA-256 verification. Their scheduled mirror jobs check about every 15 minutes (GitHub can delay scheduled jobs).

## Build locally

Use a native machine matching the target OS and CPU, Node 24, and npm:

```sh
npm ci
npx playwright install chromium
npm run build:helper
npm run build:frontend
npm start
```

macOS ARM64 uses the checksum-pinned JDK in `runtime-lock.json`. For other platforms set `NYORA_JDK_DIR` to a native **JDK 17** installation before `build:helper`. The finished application includes its own runtime.

Package with `npm run package:mac`, `package:win` or `package:linux` for ARM64; append `:x64` for Intel/AMD. Cross-compiling a helper runtime is deliberately rejected. Linux headless CI runs the packaging command under `xvfb-run -a`.

The repository is self-contained: `vendor/web` and `vendor/helper` capture the current shared frontend and helper inputs. No private sibling checkout, hosted helper or manually assembled development folder is needed. Upstream provenance is recorded in `vendor/provenance.json`. Desktop-specific UI transformations live in `scripts/*overlay.mjs` and `frontend/`.

## Verification and releases

```sh
npm test
npm run smoke:frontend
node tests/search-thumbnails-browser.mjs
npm run test:images
```

[Release process](docs/RELEASING.md) describes CI, versioning, mirrors and required validation. [Development details](docs/DEVELOPMENT.md) cover native data, transport and runtime boundaries. A passing browser fixture is not a substitute for native packaged-app checks.
