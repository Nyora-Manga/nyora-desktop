# Nyora portable backup v1

`.nyorabk` files are UTF-8 ZIP archives. Version 1 always contains these lower-case entries:

```text
manifest.json
sources.json
categories.json
preferences.json
manga.ndjson
chapters.ndjson
library.ndjson
history.ndjson
bookmarks.ndjson
tracking.ndjson
```

The manifest identifies the archive as `app.nyora.backup`, has `schemaVersion: 1`, and records the byte length, row count, and lower-case SHA-256 checksum for every data section. Registry sections are JSON arrays; larger entity sections are LF-terminated NDJSON. Writers use stable entry order and zero ZIP timestamps.

Portable remote sources are exactly `data:<catalogue-id>`. `local`, retired parser/Mihon aliases, numeric IDs, and platform serializations are not portable. Manga IDs are the lower-case SHA-256 of UTF-8 `sourceId + NUL + contentKey`; chapter IDs are SHA-256 of UTF-8 `mangaId + NUL + chapterKey`.

Readers validate all archive paths, duplicate entries, sizes, manifest counts/lengths/checksums, timestamps, canonical identities, and cross-section references before returning a snapshot. No decoder mutates persistence.
