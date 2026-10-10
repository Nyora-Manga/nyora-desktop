# Desktop migration fixture foundation

These fixtures contain no user profile, credentials, cookies, or copied comics.
They establish reproducible inputs for later migration tests, not evidence that
a desktop migration currently works.

## Authoritative archive

`portable-v1/golden-minimal.nyorabk` is copied **unchanged** from
`nyora-mac/nyora-shared/src/jvmTest/resources/backup/v1/golden-minimal.nyorabk`
at helper HEAD `798da31f4de57c9b69ef5d16d12e6b608aa3a14c`.

- Size: 4,902 bytes.
- SHA-256: `4cb654472016c0fc7c913bf2fb1b41cbf22ea308489cb7034e2e92667aafd7c2`.
- Archive schema: v1, `app.nyora.backup`, `portable-data`.
- Producer metadata inside fixture: `2.0.7`, platform `desktop`. This is fixture
  metadata and does not prove that version was released.
- Nine data sections, each containing one record; empty omissions object.

`portable-v1/provenance.json` records source revision, exact byte hash, section
counts and validation status. Python ZIP/manifest checksum/count checks were
performed for this copy. The Kotlin reference codec and old application export
were **not run** in this task. The original codec test is
`NyoraBackupCodecTest.kt`; execute it on an isolated writable helper checkout
before claiming reference-codec compatibility.

## Synthetic scenarios

`legacy/fresh/scenario.json`, `legacy/guest/scenario.json`, and
`legacy/cloud-linked/scenario.json` are deliberately **scenario descriptions**.
They are not old SQLite databases, serialized platform preferences, `.nyorabk`
archives, or formats accepted by production import. Do not pass them to a
backup picker or add a JSON importer for them.

Guest and cloud-linked scenarios describe duplicate titles on different
canonical sources, an unavailable canonical source, a retired identity and a
local item, category membership, a newer lower-page reread checkpoint,
bookmarks, tracker links, completed CBZs, local media and an interrupted job.
Only the synthetic input contains the retired identity, for explicit one-time
migration/rejection coverage; it must never become a new backup/sync identity.

Cloud-linked is a credential-free account-state scenario: `reconnectRequired`
is true. It contains no usable session. It tests the requirement that migration
does not start synchronization, not successful authentication.

Each media file is a deterministic ZIP containing one generated 2×2 PNG test
page. Hashes are recorded in each scenario. They are standalone fixture data;
no real manga or remote image was downloaded. `profile-layouts.json` maps
platform-relative candidate paths without accessing a real home directory.

## Remaining fixture work

Materialize each scenario through the old application running under a disposable
account/VM, for every cohort in `docs/desktop-release-inventory.md`. Capture a
consistent database snapshot, exact package hash, helper revision, SQL schema,
old export and omission counts, then validate the export with the reference
codec. Add evidence for custom paths, MSIX virtualization, WAL/recovery,
read-only/low-space failures, interrupted migration, re-run idempotency and
legacy absolute extension paths. Keep tokens/cookies outside committed data.

Do not mark a release cohort supported merely because its scenario name is in
the inventory. No actual old installed-profile fixture is available yet.
