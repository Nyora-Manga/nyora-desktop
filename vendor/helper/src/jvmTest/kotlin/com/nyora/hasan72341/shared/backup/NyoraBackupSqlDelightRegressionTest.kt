package com.nyora.hasan72341.shared.backup

import app.cash.sqldelight.db.QueryResult
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import com.nyora.hasan72341.shared.repository.SqlDelightNyoraBackupRepository
import java.nio.file.Files
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.concurrent.thread

class NyoraBackupSqlDelightRegressionTest {
    @Test
    fun `golden tracking opaque identity and optional fields survive restart export and repeated merge`() {
        val bytes = requireNotNull(javaClass.classLoader.getResource("backup/v1/golden-minimal.nyorabk")).readBytes()
        val incoming = NyoraBackupCodec.decode(bytes)
        assertEquals("anilist:1", incoming.tracking.single().id)
        assertEquals(null, incoming.tracking.single().progress)
        assertEquals(null, incoming.tracking.single().score)
        withDatabase { databasePath ->
            val first = SqlDelightLibraryRepository(databasePath)
            incoming.sources.forEach { first.upsertSource(realSource(it.id)) }
            NyoraBackupImporter(SqlDelightNyoraBackupRepository(first) { Instant.parse(MATERIALIZED_AT) })
                .apply(bytes, NyoraRestoreMode.Replace)
            first.driver.close()
            val reopened = SqlDelightLibraryRepository(databasePath)
            try {
                val adapter = SqlDelightNyoraBackupRepository(reopened) { Instant.parse(OBSERVED_AT) }
                assertEquals(incoming.tracking, adapter.readBackupSnapshot().tracking)
                assertEquals(incoming.tracking, adapter.reconcileBackupSnapshot().tracking)
                val exported = NyoraBackupCodec.decode(NyoraBackupCodec.encode(adapter.readBackupSnapshot()))
                assertEquals(incoming.tracking, exported.tracking)
                val repeated = NyoraBackupImporter(adapter).apply(bytes, NyoraRestoreMode.Merge)
                assertEquals(NyoraRestoreSectionPlan(unchanged = 1), repeated.plan.sections.getValue("tracking"))
                assertEquals(0, repeated.applied.getValue("tracking"))
                assertEquals(incoming.tracking, repeated.plan.preview.tracking)
                assertEquals(1, reopened.allTracking().size)
            } finally { reopened.driver.close() }
        }
    }

    @Test
    fun `legacy materialized tracking hash is aligned with its unambiguous imported identity`() {
        val bytes = requireNotNull(javaClass.classLoader.getResource("backup/v1/golden-minimal.nyorabk")).readBytes()
        val incoming = NyoraBackupCodec.decode(bytes)
        withDatabase { databasePath ->
            val first = SqlDelightLibraryRepository(databasePath)
            incoming.sources.forEach { first.upsertSource(realSource(it.id)) }
            NyoraBackupImporter(SqlDelightNyoraBackupRepository(first)).apply(bytes, NyoraRestoreMode.Replace)
            // Reproduce the previous adapter's materialized metadata, not a user archive rewrite.
            val original = incoming.tracking.single()
            val oldBaseline = original.copy(id = "${original.service}:${original.mangaId}", progress = 0.0, score = 0.0)
            first.driver.execute(null, "DROP TABLE IF EXISTS nyora_backup_tracking_identity", 0)
            first.driver.execute(null, "DELETE FROM nyora_backup_materialized WHERE section = 'tracking'", 0)
            first.driver.execute(null, "INSERT INTO nyora_backup_materialized(section, row_id, payload) VALUES ('tracking', ?, ?)", 2) {
                bindString(0, oldBaseline.id)
                bindString(1, kotlinx.serialization.json.Json.encodeToString(NyoraBackupTracking.serializer(), oldBaseline))
            }
            first.driver.close()
            val reopened = SqlDelightLibraryRepository(databasePath)
            try {
                val adapter = SqlDelightNyoraBackupRepository(reopened) { Instant.parse(OBSERVED_AT) }
                assertEquals(incoming.tracking, adapter.readBackupSnapshot().tracking)
                assertEquals(incoming.tracking, adapter.reconcileBackupSnapshot().tracking)
                assertEquals(NyoraRestoreSectionPlan(unchanged = 1), NyoraBackupImporter(adapter).plan(bytes).sections.getValue("tracking"))
            } finally { reopened.driver.close() }
        }
    }

    @Test
    fun `native tracking edits and tombstones retain imported portable identity`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            try {
                repository.upsertSource(realSource(AVAILABLE_SOURCE))
                val base = completeSnapshot().let { snapshot ->
                    snapshot.copy(tracking = snapshot.tracking.map { it.copy(id = "anilist:provider-42", progress = null, score = null) })
                }
                val adapter = SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) }
                NyoraBackupImporter(adapter).apply(NyoraBackupCodec.encode(base), NyoraRestoreMode.Replace)
                val native = repository.allTracking().single()
                repository.saveTracking(native.copy(status = "completed", updatedAt = NATIVE_AT))
                val statusOnly = adapter.reconcileBackupSnapshot().tracking.single()
                assertEquals("anilist:provider-42", statusOnly.id)
                assertEquals("completed", statusOnly.status)
                assertEquals(null, statusOnly.progress)
                assertEquals(null, statusOnly.score)
                repository.saveTracking(native.copy(status = "completed", score = 9f, lastReadChapter = 22.5f, updatedAt = NATIVE_AT))
                val observed = adapter.reconcileBackupSnapshot().tracking.single()
                assertEquals("anilist:provider-42", observed.id)
                assertEquals("completed", observed.status)
                assertEquals(9.0, observed.score)
                assertEquals(22.5, observed.progress)
                repository.removeTracking(native.trackerId, native.mangaId)
                val deleted = adapter.reconcileBackupSnapshot().tracking.single()
                assertEquals("anilist:provider-42", deleted.id)
                assertTrue(deleted.deletedAt != null)
            } finally { repository.driver.close() }
        }
    }

    @Test
    fun `fresh native clocks beat an older matching archive before materialization`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val portableMangaId = NyoraBackupIdentity.mangaId(AVAILABLE_SOURCE, FRESH_MANGA_KEY)
            val portableChapterId = NyoraBackupIdentity.chapterId(portableMangaId, FRESH_CHAPTER_KEY)
            repository.upsertManga(
                Manga(
                    id = FRESH_LOCAL_MANGA_ID,
                    title = "Local 2026 title",
                    url = FRESH_MANGA_KEY,
                    source = MangaSourceRef.Script(AVAILABLE_SOURCE),
                    chapters = listOf(
                        MangaChapter(
                            id = FRESH_LOCAL_CHAPTER_ID,
                            title = "Local chapter",
                            url = FRESH_CHAPTER_KEY,
                        ),
                    ),
                ),
            )
            repository.driver.execute(null, "UPDATE manga SET updated_at = ? WHERE id = ?", 2) {
                bindLong(0, NATIVE_MILLIS)
                bindString(1, FRESH_LOCAL_MANGA_ID)
            }
            repository.upsertHistoryFromSync(
                mangaId = FRESH_LOCAL_MANGA_ID,
                sourceId = AVAILABLE_SOURCE,
                chapterId = FRESH_LOCAL_CHAPTER_ID,
                chapterTitle = "Local chapter",
                page = 17,
                scroll = 0.0,
                percent = 0.7f,
                chaptersCount = 1,
                updatedAt = NATIVE_AT,
            )
            repository.addBookmark(
                FRESH_LOCAL_MANGA_ID,
                FRESH_LOCAL_CHAPTER_ID,
                "Local chapter",
                12,
                "Local 2026 bookmark",
            )
            val localBookmarkId = repository.allBookmarksIncludingDeleted().single().id
            repository.driver.execute(null, "UPDATE bookmark SET updated_at = ? WHERE id = ?", 2) {
                bindLong(0, NATIVE_MILLIS)
                bindLong(1, localBookmarkId)
            }
            val portableBookmarkId = UUID.nameUUIDFromBytes(
                "nyora_backup_bookmark_identity:$localBookmarkId".toByteArray(Charsets.UTF_8),
            ).toString()
            val adapter = SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) }
            val projected = adapter.readBackupSnapshot()
            val remote = projected.copy(
                archiveId = "99999999-9999-9999-9999-999999999999",
                createdAt = OLD_AT,
                manga = projected.manga.map {
                    it.copy(title = "Remote 2020 title", updatedAt = OLD_AT)
                },
                history = projected.history.map {
                    it.copy(page = 2, percent = 0.1, updatedAt = OLD_AT)
                },
                bookmarks = projected.bookmarks.map {
                    it.copy(note = "Remote 2020 bookmark", updatedAt = OLD_AT)
                },
            )

            val plan = NyoraBackupImporter(adapter).plan(
                NyoraBackupCodec.encode(remote),
                NyoraRestoreMode.Merge,
            )

            assertEquals("Local 2026 title", plan.preview.manga.single { it.id == portableMangaId }.title)
            assertEquals(OBSERVED_AT, plan.preview.manga.single { it.id == portableMangaId }.updatedAt)
            assertEquals(17, plan.preview.history.single { it.chapterId == portableChapterId }.page)
            assertEquals(OBSERVED_AT, plan.preview.history.single().updatedAt)
            assertEquals("Local 2026 bookmark", plan.preview.bookmarks.single { it.id == portableBookmarkId }.note)
            assertEquals(OBSERVED_AT, plan.preview.bookmarks.single().updatedAt)
            repository.driver.close()
        }
    }

    @Test
    fun `merge import observes structural category source and library changes before export`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val base = completeSnapshot().let { snapshot ->
                snapshot.copy(
                    categories = snapshot.categories +
                        NyoraBackupCategory(SECOND_CATEGORY_ID, "Second", 8, BASE_AT),
                )
            }
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(base), NyoraRestoreMode.Replace)
            val firstLocalId = repository.favouriteCategories().single { it.title == "Portable category" }.id
            val secondLocalId = repository.favouriteCategories().single { it.title == "Second" }.id
            repository.driver.execute(
                null,
                "UPDATE favourite_category SET title = ? WHERE id = ?",
                2,
            ) {
                bindString(0, "Local category rename")
                bindLong(1, firstLocalId)
            }
            repository.database.mangaSourceQueries.togglePin(AVAILABLE_SOURCE)
            repository.database.mangaSourceQueries.setInstalled(0L, AVAILABLE_SOURCE)
            repository.addToCategory(MANGA_ID, secondLocalId)
            val remote = base.copy(
                archiveId = "99999999-9999-9999-9999-999999999999",
                categories = base.categories.map {
                    if (it.id == CATEGORY_ID) it.copy(title = "Remote category", updatedAt = REMOTE_AT) else it
                },
                sources = base.sources.map {
                    if (it.id == AVAILABLE_SOURCE) {
                        it.copy(catalogueRevision = "remote-r9", installed = true, pinned = true, updatedAt = REMOTE_AT)
                    } else {
                        it
                    }
                },
                library = base.library.map {
                    it.copy(categoryIds = listOf(CATEGORY_ID), updatePolicy = "always", updatedAt = REMOTE_AT)
                },
            )
            val observing = SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) }

            val result = NyoraBackupImporter(observing).apply(
                NyoraBackupCodec.encode(remote),
                NyoraRestoreMode.Merge,
            )

            val category = result.plan.preview.categories.single { it.id == CATEGORY_ID }
            assertEquals("Local category rename", category.title)
            assertEquals(OBSERVED_AT, category.updatedAt)
            val source = result.plan.preview.sources.single { it.id == AVAILABLE_SOURCE }
            assertFalse(source.installed)
            assertFalse(source.pinned)
            assertEquals(mapOf("quality" to JsonPrimitive("high")), source.preferences)
            assertEquals(OBSERVED_AT, source.updatedAt)
            val library = result.plan.preview.library.single()
            assertEquals(listOf(CATEGORY_ID, SECOND_CATEGORY_ID).sorted(), library.categoryIds)
            assertEquals("always", library.updatePolicy)
            assertEquals(OBSERVED_AT, library.updatedAt)
            assertEquals(result.plan.preview, observing.readBackupSnapshot())
            repository.driver.close()
        }
    }

    @Test
    fun `merge plan observes a hard delete before export so older live archive cannot resurrect it`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val base = completeSnapshot()
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(base), NyoraRestoreMode.Replace)
            repository.driver.execute(null, "DELETE FROM manga WHERE id = ?", 1) {
                bindString(0, MANGA_ID)
            }
            val remote = base.copy(
                archiveId = "99999999-9999-9999-9999-999999999999",
                manga = base.manga.map {
                    it.copy(title = "Remote resurrection", updatedAt = REMOTE_AT)
                },
            )
            val observing = SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) }
            val importer = NyoraBackupImporter(observing)

            val plan = importer.plan(NyoraBackupCodec.encode(remote), NyoraRestoreMode.Merge)

            val plannedTombstone = plan.preview.manga.single()
            assertEquals("Portable title", plannedTombstone.title)
            assertEquals(OBSERVED_AT, plannedTombstone.deletedAt)
            val result = importer.apply(NyoraBackupCodec.encode(remote), NyoraRestoreMode.Merge)
            assertEquals(plannedTombstone, result.plan.preview.manga.single())
            assertEquals(plannedTombstone, observing.readBackupSnapshot().manga.single())
            assertTrue(repository.load().mangas.isEmpty())
            repository.driver.close()
        }
    }

    @Test
    fun `planning captures one current observation clock without writing SQLite`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val base = completeSnapshot()
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(base), NyoraRestoreMode.Replace)
            val localCategoryId = repository.favouriteCategories().single().id
            repository.driver.execute(
                null,
                "UPDATE favourite_category SET title = ? WHERE id = ?",
                2,
            ) {
                bindString(0, "Observed in plan")
                bindLong(1, localCategoryId)
            }
            var clockCalls = 0
            val observing = SqlDelightNyoraBackupRepository(repository) {
                clockCalls++
                Instant.parse(if (clockCalls == 1) OBSERVED_AT else LATER_AT)
            }
            val remote = base.copy(
                archiveId = "99999999-9999-9999-9999-999999999999",
                categories = base.categories.map { it.copy(title = "Older remote", updatedAt = REMOTE_AT) },
            )
            val changesBefore = totalChanges(repository)

            val plan = NyoraBackupImporter(observing).plan(
                NyoraBackupCodec.encode(remote),
                NyoraRestoreMode.Merge,
            )

            assertEquals(1, clockCalls)
            assertEquals("Observed in plan", plan.preview.categories.single().title)
            assertEquals(OBSERVED_AT, plan.preview.categories.single().updatedAt)
            assertEquals(changesBefore, totalChanges(repository), "plan must remain SQLite-write-free")
            repository.driver.close()
        }
    }

    @Test
    fun `category rename without a native clock is observed once and survives restart`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val applied = SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) }
            NyoraBackupImporter(applied).apply(
                NyoraBackupCodec.encode(completeSnapshot()),
                NyoraRestoreMode.Replace,
            )
            val localCategoryId = repository.favouriteCategories().single().id
            repository.driver.execute(
                null,
                "UPDATE favourite_category SET title = ? WHERE id = ?",
                2,
            ) {
                bindString(0, "Locally renamed")
                bindLong(1, localCategoryId)
            }

            val first = exportSnapshot(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) },
            ).categories.single()
            assertEquals("Locally renamed", first.title)
            assertEquals(OBSERVED_AT, first.updatedAt)
            repository.driver.close()

            val reloadedRepository = SqlDelightLibraryRepository(databasePath)
            val second = exportSnapshot(
                SqlDelightNyoraBackupRepository(reloadedRepository) { Instant.parse(LATER_AT) },
            ).categories.single()
            assertEquals(first, second)
            reloadedRepository.driver.close()
        }
    }

    @Test
    fun `category membership mutation receives an observation clock and preserves update policy`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val base = completeSnapshot()
            val incoming = base.copy(
                categories = base.categories + NyoraBackupCategory(SECOND_CATEGORY_ID, "Second", 8, BASE_AT),
            )
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(incoming), NyoraRestoreMode.Replace)
            val secondLocalId = repository.favouriteCategories().single { it.title == "Second" }.id
            repository.addToCategory(MANGA_ID, secondLocalId)

            val observed = exportSnapshot(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) },
            ).library.single()
            assertEquals(listOf(CATEGORY_ID, SECOND_CATEGORY_ID).sorted(), observed.categoryIds)
            assertEquals("always", observed.updatePolicy)
            assertEquals(OBSERVED_AT, observed.updatedAt)
            repository.driver.close()
        }
    }

    @Test
    fun `source pin and install mutation receives an observation clock and keeps source preferences`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(completeSnapshot()), NyoraRestoreMode.Replace)
            repository.database.mangaSourceQueries.togglePin(AVAILABLE_SOURCE)
            repository.database.mangaSourceQueries.setInstalled(0L, AVAILABLE_SOURCE)

            val observed = exportSnapshot(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) },
            ).sources.single { it.id == AVAILABLE_SOURCE }
            assertFalse(observed.pinned)
            assertFalse(observed.installed)
            assertEquals(mapOf("quality" to JsonPrimitive("high")), observed.preferences)
            assertEquals(OBSERVED_AT, observed.updatedAt)
            repository.driver.close()
        }
    }

    @Test
    fun `new portable row receives its first observation clock and remains stable`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(completeSnapshot()), NyoraRestoreMode.Replace)
            repository.createCategory("Created later")

            val first = exportSnapshot(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) },
            ).categories.single { it.title == "Created later" }
            assertEquals(OBSERVED_AT, first.updatedAt)
            repository.driver.close()

            val reloadedRepository = SqlDelightLibraryRepository(databasePath)
            val second = exportSnapshot(
                SqlDelightNyoraBackupRepository(reloadedRepository) { Instant.parse(LATER_AT) },
            ).categories.single { it.title == "Created later" }
            assertEquals(first, second)
            reloadedRepository.driver.close()
        }
    }

    @Test
    fun `hard delete tombstone uses first observation clock and remains stable across restart export`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            NyoraBackupImporter(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(MATERIALIZED_AT) },
            ).apply(NyoraBackupCodec.encode(completeSnapshot()), NyoraRestoreMode.Replace)
            repository.driver.execute(null, "DELETE FROM manga WHERE id = ?", 1) {
                bindString(0, MANGA_ID)
            }

            val first = exportSnapshot(
                SqlDelightNyoraBackupRepository(repository) { Instant.parse(OBSERVED_AT) },
            ).manga.single()
            assertEquals(OBSERVED_AT, first.deletedAt)
            repository.driver.close()

            val reloadedRepository = SqlDelightLibraryRepository(databasePath)
            val second = exportSnapshot(
                SqlDelightNyoraBackupRepository(reloadedRepository) { Instant.parse(LATER_AT) },
            ).manga.single()
            assertEquals(first, second)
            reloadedRepository.driver.close()
        }
    }

    @Test
    fun `backup apply waits for an in flight sync operation to quiesce`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val adapter = SqlDelightNyoraBackupRepository(repository)
            val syncEntered = CountDownLatch(1)
            val releaseSync = CountDownLatch(1)
            val applyFinished = CountDownLatch(1)
            val syncThread = thread(name = "backup-review-sync") {
                repository.withSyncOperation {
                    syncEntered.countDown()
                    assertTrue(releaseSync.await(5, TimeUnit.SECONDS))
                }
            }
            assertTrue(syncEntered.await(5, TimeUnit.SECONDS))
            val applyThread = thread(name = "backup-review-apply") {
                NyoraBackupImporter(adapter).apply(
                    NyoraBackupCodec.encode(completeSnapshot()),
                    NyoraRestoreMode.Replace,
                )
                applyFinished.countDown()
            }

            assertFalse(applyFinished.await(150, TimeUnit.MILLISECONDS))
            releaseSync.countDown()
            assertTrue(applyFinished.await(5, TimeUnit.SECONDS))
            syncThread.join()
            applyThread.join()
            assertEquals(completeSnapshot(), adapter.readBackupSnapshot())
            repository.driver.close()
        }
    }

    @Test
    fun `replace restart exactly preserves portable archive without source leakage or placeholders`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            repository.upsertSource(realSource("data:leaked"))
            val adapter = SqlDelightNyoraBackupRepository(repository)
            val incoming = completeSnapshot()

            val result = NyoraBackupImporter(adapter).apply(
                NyoraBackupCodec.encode(incoming),
                NyoraRestoreMode.Replace,
            )

            assertEquals(listOf(UNAVAILABLE_SOURCE), result.plan.unresolvedSources)
            assertEquals(listOf(AVAILABLE_SOURCE), repository.load().sources.map { it.id }.sorted())
            assertFalse(repository.load().sources.any { it.id == UNAVAILABLE_SOURCE })
            repository.driver.close()

            val reloadedRepository = SqlDelightLibraryRepository(databasePath)
            val reloaded = SqlDelightNyoraBackupRepository(reloadedRepository)
            assertEquals(incoming, reloaded.readBackupSnapshot())
            assertEquals(setOf(AVAILABLE_SOURCE), reloaded.availableBackupSourceIds())
            reloadedRepository.driver.close()
        }
    }

    @Test
    fun `newer live row supersedes ledger after restart while archive-only fields survive`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val incoming = completeSnapshot()
            NyoraBackupImporter(SqlDelightNyoraBackupRepository(repository)).apply(
                NyoraBackupCodec.encode(incoming),
                NyoraRestoreMode.Replace,
            )
            repository.driver.execute(
                null,
                "UPDATE manga SET title = ?, updated_at = ? WHERE id = ?",
                3,
            ) {
                bindString(0, "Newer local title")
                bindLong(1, NEWER_MILLIS)
                bindString(2, MANGA_ID)
            }
            repository.driver.close()

            val reloadedRepository = SqlDelightLibraryRepository(databasePath)
            val reloaded = SqlDelightNyoraBackupRepository(reloadedRepository) { Instant.parse(NEWER_AT) }
                .readBackupSnapshot()
            val manga = reloaded.manga.single()
            assertEquals("Newer local title", manga.title)
            assertEquals(NEWER_AT, manga.updatedAt)
            assertEquals("Portable description", manga.description)
            assertEquals("Portable author", manga.author)
            assertEquals("Portable artist", manga.artist)
            assertEquals(listOf("Drama", "Art"), manga.genres)
            reloadedRepository.driver.close()
        }
    }

    @Test
    fun `hard deleted materialized row becomes an observed tombstone instead of resurrecting`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val incoming = completeSnapshot()
            NyoraBackupImporter(SqlDelightNyoraBackupRepository(repository)).apply(
                NyoraBackupCodec.encode(incoming),
                NyoraRestoreMode.Replace,
            )
            repository.driver.execute(null, "DELETE FROM manga WHERE id = ?", 1) {
                bindString(0, MANGA_ID)
            }
            repository.driver.close()

            val firstReload = SqlDelightLibraryRepository(databasePath)
            val firstTombstone = SqlDelightNyoraBackupRepository(firstReload) { Instant.parse(OBSERVED_AT) }
                .readBackupSnapshot().manga.single()
            assertEquals(OBSERVED_AT, firstTombstone.deletedAt)
            assertEquals("Portable description", firstTombstone.description)
            firstReload.driver.close()

            val secondReload = SqlDelightLibraryRepository(databasePath)
            val secondTombstone = SqlDelightNyoraBackupRepository(secondReload) { Instant.parse(OBSERVED_AT) }
                .readBackupSnapshot().manga.single()
            assertEquals(firstTombstone, secondTombstone)
            secondReload.driver.close()
        }
    }

    @Test
    fun `planning does not insert portable identity rows`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            val adapter = SqlDelightNyoraBackupRepository(repository)
            repository.createCategory("Local category")
            val before = rowCount(repository, "nyora_backup_category_identity")
            val changesBefore = totalChanges(repository)

            NyoraBackupImporter(adapter).plan(
                NyoraBackupCodec.encode(emptySnapshot("22222222-2222-2222-2222-222222222222")),
                NyoraRestoreMode.Merge,
            )

            assertEquals(0L, before)
            assertEquals(before, rowCount(repository, "nyora_backup_category_identity"))
            assertEquals(changesBefore, totalChanges(repository), "preview must not write any SQL table")
            repository.driver.close()
        }
    }

    @Test
    fun `legacy cleanup completion survives restart and prevents a second destructive pass`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            SqlDelightNyoraBackupRepository(repository)
            repository.upsertSource(
                MangaSource(
                    id = "mihon:late",
                    name = "Late legacy row",
                    lang = "en",
                    baseUrl = "",
                    engine = SourceEngine.JavaScript,
                ),
            )
            val queue = databasePath.parent.resolve("mihon-resolve-queue.json")
            Files.writeString(queue, "late")
            repository.driver.close()

            val reloaded = SqlDelightLibraryRepository(databasePath)
            SqlDelightNyoraBackupRepository(reloaded)
            assertTrue(reloaded.load().sources.any { it.id == "mihon:late" })
            assertTrue(Files.exists(queue))
            reloaded.driver.close()
        }
    }

    @Test
    fun `sqlite failure rolls back all portable tables and ledger together`() {
        withDatabase { databasePath ->
            val repository = SqlDelightLibraryRepository(databasePath)
            repository.upsertSource(realSource(AVAILABLE_SOURCE))
            val adapter = SqlDelightNyoraBackupRepository(repository)
            val original = completeSnapshot().let { snapshot ->
                snapshot.copy(tracking = snapshot.tracking.map { it.copy(id = "anilist:original-link") })
            }
            NyoraBackupImporter(adapter).apply(NyoraBackupCodec.encode(original), NyoraRestoreMode.Replace)
            repository.driver.execute(
                null,
                """
                CREATE TRIGGER fail_portable_ledger
                BEFORE INSERT ON nyora_backup_row
                WHEN NEW.section = 'tracking'
                BEGIN
                    SELECT RAISE(ABORT, 'injected ledger failure');
                END
                """.trimIndent(),
                0,
            )
            val replacementBase = completeSnapshot(
                archiveId = "99999999-9999-9999-9999-999999999999",
                title = "Must roll back",
                updatedAt = "2026-08-26T10:00:00.000Z",
            )
            val replacement = replacementBase.copy(
                sources = replacementBase.sources.map { it.copy(catalogueRevision = "rollback-r9") },
                categories = replacementBase.categories.map { it.copy(title = "Rollback category") },
                preferences = replacementBase.preferences.map {
                    it.copy(value = buildJsonObject { put("readerMode", "rollback") })
                },
                chapters = replacementBase.chapters.map { it.copy(name = "Rollback chapter") },
                library = replacementBase.library.map { it.copy(updatePolicy = "never") },
                history = replacementBase.history.map { it.copy(page = 99, readDurationSeconds = 999) },
                bookmarks = replacementBase.bookmarks.map { it.copy(note = "Rollback bookmark") },
                tracking = replacementBase.tracking.map { it.copy(id = "anilist:replacement-link", status = "completed") },
            )

            assertFailsWith<Exception> {
                NyoraBackupImporter(adapter).apply(
                    NyoraBackupCodec.encode(replacement),
                    NyoraRestoreMode.Replace,
                )
            }

            assertEquals(original, adapter.readBackupSnapshot())
            assertEquals(original.archiveId, ledgerArchiveId(repository))
            assertEquals("Portable title", repository.load().mangas.single().title)
            assertEquals(1L, rowCount(repository, "tracking"))
            repository.driver.close()
        }
    }

    private fun completeSnapshot(
        archiveId: String = "11111111-1111-1111-1111-111111111111",
        title: String = "Portable title",
        updatedAt: String = BASE_AT,
    ) = NyoraBackupSnapshot(
        archiveId = archiveId,
        createdAt = "2026-08-21T08:30:00.000Z",
        appVersion = "review-test",
        platform = "jvm-test",
        sources = listOf(
            NyoraBackupSource(
                id = AVAILABLE_SOURCE,
                catalogueRevision = "available-r7",
                installed = true,
                pinned = true,
                preferences = mapOf("quality" to JsonPrimitive("high")),
                updatedAt = BASE_AT,
            ),
            NyoraBackupSource(
                id = UNAVAILABLE_SOURCE,
                catalogueRevision = "missing-r3",
                installed = true,
                preferences = mapOf("mirror" to JsonPrimitive("two")),
                updatedAt = BASE_AT,
            ),
        ),
        categories = listOf(NyoraBackupCategory(CATEGORY_ID, "Portable category", 7, BASE_AT)),
        preferences = listOf(
            NyoraBackupPreference(
                key = "reader/$MANGA_ID",
                value = buildJsonObject {
                    put("readerMode", "webtoon")
                    put("brightness", 0.8)
                    put("contrast", 1.1)
                    put("saturation", 0.9)
                    put("hue", 0.2)
                    put("palette", "warm")
                },
                updatedAt = BASE_AT,
            ),
        ),
        manga = listOf(
            NyoraBackupManga(
                id = MANGA_ID,
                sourceId = UNAVAILABLE_SOURCE,
                contentKey = "/portable/manga",
                title = title,
                updatedAt = updatedAt,
                description = "Portable description",
                author = "Portable author",
                artist = "Portable artist",
                genres = listOf("Drama", "Art"),
                coverUrl = "https://example.com/cover.jpg",
            ),
        ),
        chapters = listOf(
            NyoraBackupChapter(
                id = CHAPTER_ID,
                mangaId = MANGA_ID,
                chapterKey = "/portable/chapter",
                name = "Portable chapter",
                updatedAt = updatedAt,
                number = 4.5,
                uploadedAt = "2026-08-19T10:00:00.000Z",
            ),
        ),
        library = listOf(
            NyoraBackupLibrary(
                mangaId = MANGA_ID,
                addedAt = "2026-08-18T10:00:00.000Z",
                categoryIds = listOf(CATEGORY_ID),
                updatePolicy = "always",
                updatedAt = updatedAt,
            ),
        ),
        history = listOf(
            NyoraBackupHistory(
                mangaId = MANGA_ID,
                chapterId = CHAPTER_ID,
                page = 3,
                percent = 0.4,
                updatedAt = updatedAt,
                readDurationSeconds = 321,
            ),
        ),
        bookmarks = listOf(
            NyoraBackupBookmark(
                id = BOOKMARK_ID,
                mangaId = MANGA_ID,
                chapterId = CHAPTER_ID,
                page = 8,
                note = "Portable note",
                updatedAt = updatedAt,
            ),
            NyoraBackupBookmark(
                id = TOMBSTONE_BOOKMARK_ID,
                mangaId = MANGA_ID,
                chapterId = CHAPTER_ID,
                page = 9,
                note = "Deleted portable note",
                updatedAt = BASE_AT,
                deletedAt = "2026-08-24T10:00:00.000Z",
            ),
        ),
        tracking = listOf(
            NyoraBackupTracking(
                id = "anilist:$MANGA_ID",
                mangaId = MANGA_ID,
                service = "anilist",
                status = "reading",
                updatedAt = updatedAt,
                progress = 4.5,
                score = 8.5,
            ),
        ),
        omissions = mapOf("downloads" to 2),
    )

    private fun emptySnapshot(archiveId: String) = NyoraBackupSnapshot(
        archiveId = archiveId,
        createdAt = BASE_AT,
        appVersion = "review-test",
        platform = "jvm-test",
    )

    private fun realSource(id: String) = MangaSource(
        id = id,
        name = id.removePrefix("data:"),
        lang = "en",
        baseUrl = "https://example.com",
        version = "runtime-r1",
        isInstalled = true,
        engine = SourceEngine.JavaScript,
        installedAt = 1_754_000_000_000L,
    )

    private fun exportSnapshot(repository: SqlDelightNyoraBackupRepository): NyoraBackupSnapshot =
        NyoraBackupExporter(
            repository = repository,
            appVersion = "observation-test",
            platform = "jvm-test",
            now = { Instant.parse(OBSERVED_AT) },
            newArchiveId = { UUID.fromString("dddddddd-dddd-dddd-dddd-dddddddddddd") },
        ).snapshot()

    private fun rowCount(repository: SqlDelightLibraryRepository, table: String): Long =
        repository.driver.executeQuery(
            identifier = null,
            sql = "SELECT COUNT(*) FROM $table",
            mapper = { cursor ->
                QueryResult.Value(if (cursor.next().value) cursor.getLong(0) ?: 0L else 0L)
            },
            parameters = 0,
        ).value

    private fun ledgerArchiveId(repository: SqlDelightLibraryRepository): String? =
        repository.driver.executeQuery(
            identifier = null,
            sql = "SELECT archive_id FROM nyora_backup_archive WHERE singleton = 1",
            mapper = { cursor ->
                QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null)
            },
            parameters = 0,
        ).value

    private fun totalChanges(repository: SqlDelightLibraryRepository): Long =
        repository.driver.executeQuery(
            identifier = null,
            sql = "SELECT total_changes()",
            mapper = { cursor ->
                QueryResult.Value(if (cursor.next().value) cursor.getLong(0) ?: 0L else 0L)
            },
            parameters = 0,
        ).value

    private inline fun withDatabase(block: (java.nio.file.Path) -> Unit) {
        val directory = Files.createTempDirectory("nyora-backup-review")
        try {
            block(directory.resolve("library.db"))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    private companion object {
        const val AVAILABLE_SOURCE = "data:available"
        const val UNAVAILABLE_SOURCE = "data:unavailable"
        const val MANGA_ID = "a4ebb8748198630f47d2d4d903f9d469c1ba7b95d32c031a2f6bae85deb90511"
        const val CHAPTER_ID = "70c35492e9e80938d3602326b59a74b42880ba9ffd3464dfb8fbca5009e35c52"
        const val CATEGORY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        const val SECOND_CATEGORY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
        const val BOOKMARK_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        const val TOMBSTONE_BOOKMARK_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
        const val BASE_AT = "2026-08-20T10:00:00.000Z"
        const val NEWER_AT = "2026-08-25T10:00:00.000Z"
        const val NEWER_MILLIS = 1_787_652_000_000L
        const val MATERIALIZED_AT = "2026-08-21T10:00:00.000Z"
        const val OBSERVED_AT = "2026-08-27T10:00:00.000Z"
        const val LATER_AT = "2026-08-28T10:00:00.000Z"
        const val REMOTE_AT = "2026-08-22T10:00:00.000Z"
        const val OLD_AT = "2020-01-02T10:00:00.000Z"
        const val NATIVE_AT = "2026-08-25T10:00:00.000Z"
        const val NATIVE_MILLIS = 1_787_652_000_000L
        const val FRESH_LOCAL_MANGA_ID = "fresh-local-manga"
        const val FRESH_LOCAL_CHAPTER_ID = "fresh-local-chapter"
        const val FRESH_MANGA_KEY = "/fresh/manga"
        const val FRESH_CHAPTER_KEY = "/fresh/chapter"
    }
}
