package com.nyora.hasan72341.shared.backup

import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.repository.MangaPrefsRow
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import com.nyora.hasan72341.shared.repository.SqlDelightNyoraBackupRepository
import com.nyora.hasan72341.shared.repository.TrackingRow
import java.nio.file.Files
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NyoraBackupAdapterTest {
    @Test
    fun `export maps every portable SQLDelight section to canonical identities`() {
        val directory = Files.createTempDirectory("nyora-backup-adapter")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            val sourceId = "data:mangadex"
            val contentKey = "/title/blue-period"
            val mangaId = NyoraBackupIdentity.mangaId(sourceId, contentKey)
            val chapterKey = "/chapter/1"
            val chapterId = NyoraBackupIdentity.chapterId(mangaId, chapterKey)
            repository.upsertSource(
                MangaSource(
                    id = sourceId,
                    name = "MangaDex",
                    lang = "en",
                    baseUrl = "https://mangadex.org",
                    version = "catalogue-r7",
                    isInstalled = true,
                    isPinned = true,
                    engine = SourceEngine.JavaScript,
                    installedAt = 1_725_000_000_000L,
                ),
            )
            repository.upsertManga(
                Manga(
                    id = "local-row-17",
                    title = "Blue Period",
                    url = contentKey,
                    source = MangaSourceRef.Script(sourceId),
                    authors = listOf("Tsubasa Yamaguchi"),
                    chapters = listOf(
                        MangaChapter(
                            id = "local-chapter-3",
                            title = "Chapter 1",
                            number = 1f,
                            url = chapterKey,
                            uploadDate = 1_700_000_000_000L,
                        ),
                    ),
                ),
            )
            assertTrue(repository.toggleFavourite("local-row-17"))
            val categoryId = repository.createCategory("Painting")
            repository.addToCategory("local-row-17", categoryId)
            repository.recordHistory("local-row-17", sourceId, "local-chapter-3", "Chapter 1", 2, 0.25f)
            repository.addBookmark("local-row-17", "local-chapter-3", "Chapter 1", 4, "palette")
            repository.saveMangaPrefs(MangaPrefsRow("local-row-17", "paged", 0.9, 1.0, 1.0, 0.0, ""))
            repository.saveTracking(
                TrackingRow(
                    trackerId = "anilist",
                    remoteId = "123",
                    sourceId = sourceId,
                    mangaId = "local-row-17",
                    title = "Blue Period",
                    status = "reading",
                    score = 8f,
                    lastReadChapter = 1f,
                    lastReadVolume = 1,
                    totalChapters = 0,
                    totalVolumes = 0,
                    chapterOffset = 0,
                    startedAt = "",
                    finishedAt = "",
                    comment = "",
                    updatedAt = "2026-08-21T08:30:00.000Z",
                    deletedAt = "",
                ),
            )

            val snapshot = NyoraBackupExporter(
                repository = SqlDelightNyoraBackupRepository(repository),
                appVersion = "test",
                platform = "jvm-test",
                now = { Instant.parse("2026-08-21T08:30:00Z") },
                newArchiveId = { UUID.fromString("11111111-1111-1111-1111-111111111111") },
            ).snapshot()

            assertEquals(listOf(sourceId), snapshot.sources.map { it.id })
            assertEquals("catalogue-r7", snapshot.sources.single().catalogueRevision)
            assertEquals(listOf(mangaId), snapshot.manga.map { it.id })
            assertEquals(contentKey, snapshot.manga.single().contentKey)
            assertEquals(listOf(chapterId), snapshot.chapters.map { it.id })
            assertEquals(chapterKey, snapshot.chapters.single().chapterKey)
            assertEquals(listOf(mangaId), snapshot.library.map { it.mangaId })
            assertEquals(listOf(mangaId), snapshot.history.map { it.mangaId })
            assertEquals(listOf(chapterId), snapshot.history.map { it.chapterId })
            assertEquals(listOf(mangaId), snapshot.bookmarks.map { it.mangaId })
            assertEquals(listOf(chapterId), snapshot.bookmarks.map { it.chapterId })
            assertEquals(listOf(mangaId), snapshot.tracking.map { it.mangaId })
            assertEquals(1, snapshot.categories.size)
            assertEquals(1, snapshot.preferences.size)
            UUID.fromString(snapshot.categories.single().id)
            UUID.fromString(snapshot.bookmarks.single().id)
            assertEquals(snapshot, NyoraBackupCodec.decode(NyoraBackupCodec.encode(snapshot)))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `newer tombstones and stable UUID mappings survive repository restart`() {
        val directory = Files.createTempDirectory("nyora-backup-ledger")
        val databasePath = directory.resolve("library.db")
        val sourceId = "data:source"
        val mangaId = NyoraBackupIdentity.mangaId(sourceId, "/manga")
        val chapterId = NyoraBackupIdentity.chapterId(mangaId, "/chapter")
        val categoryId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        val bookmarkId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        val tombstoneAt = "2026-08-23T10:00:00.000Z"
        val incoming = NyoraBackupSnapshot(
            archiveId = "22222222-2222-2222-2222-222222222222",
            createdAt = "2026-08-21T08:30:00.000Z",
            appVersion = "test",
            platform = "test",
            sources = listOf(NyoraBackupSource(sourceId, "r1", updatedAt = "2026-08-20T00:00:00.000Z")),
            categories = listOf(NyoraBackupCategory(categoryId, "Stable", 0, "2026-08-20T00:00:00.000Z")),
            manga = listOf(NyoraBackupManga(mangaId, sourceId, "/manga", "Manga", "2026-08-20T00:00:00.000Z")),
            chapters = listOf(NyoraBackupChapter(chapterId, mangaId, "/chapter", "Chapter", "2026-08-20T00:00:00.000Z")),
            library = listOf(NyoraBackupLibrary(mangaId, "2026-08-20T00:00:00.000Z", listOf(categoryId))),
            bookmarks = listOf(
                NyoraBackupBookmark(
                    id = bookmarkId,
                    mangaId = mangaId,
                    chapterId = chapterId,
                    page = 3,
                    updatedAt = tombstoneAt,
                    deletedAt = tombstoneAt,
                ),
            ),
        )
        try {
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(SqlDelightLibraryRepository(databasePath)),
            ).apply(NyoraBackupCodec.encode(incoming), NyoraRestoreMode.Replace)

            val reloaded = SqlDelightNyoraBackupRepository(SqlDelightLibraryRepository(databasePath))
                .readBackupSnapshot()

            assertEquals(categoryId, reloaded.categories.single().id)
            assertEquals(bookmarkId, reloaded.bookmarks.single().id)
            assertEquals(tombstoneAt, reloaded.bookmarks.single().deletedAt)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `one time cleanup removes unresolved retired rows and queue but retains canonical rows`() {
        val directory = Files.createTempDirectory("nyora-backup-cleanup")
        val databasePath = directory.resolve("library.db")
        try {
            val repository = SqlDelightLibraryRepository(databasePath)
            val canonical = Manga(
                id = "canonical",
                title = "Canonical",
                url = "/canonical",
                source = MangaSourceRef.Script("data:source"),
            )
            val unresolved = Manga(
                id = "unresolved",
                title = "Unresolved",
                url = "/unresolved",
                source = MangaSourceRef.Parser("MIHON_123"),
            )
            repository.upsertSource(MangaSource("data:source", "Source", "en", "https://example.com"))
            repository.upsertSource(MangaSource("mihon:123", "Retired", "en", ""))
            repository.upsertManga(canonical)
            repository.upsertManga(unresolved)
            assertTrue(repository.toggleFavourite(unresolved.id))
            val missing = repository.createCategory("Missing Source")
            repository.addToCategory(unresolved.id, missing)
            val queue = directory.resolve("mihon-resolve-queue.json")
            Files.writeString(queue, "[]")

            SqlDelightNyoraBackupRepository(repository)

            assertEquals(listOf("canonical"), repository.load().mangas.map { it.id })
            assertFalse(repository.load().sources.any { it.id == "mihon:123" })
            assertFalse(repository.favouriteCategories().any { it.title == "Missing Source" })
            assertFalse(Files.exists(queue))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }
}
