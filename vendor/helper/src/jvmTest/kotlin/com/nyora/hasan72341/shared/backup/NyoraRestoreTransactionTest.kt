package com.nyora.hasan72341.shared.backup

import com.nyora.hasan72341.shared.repository.NyoraBackupRepository
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NyoraRestoreTransactionTest {
    @Test
    fun `merge uses newest write including tombstones and reread checkpoints`() {
        val current = snapshot(
            archiveId = "11111111-1111-1111-1111-111111111111",
            category = category(title = "Old title", updatedAt = "2026-08-20T10:00:00.000Z"),
            history = history(page = 91, percent = 0.95, updatedAt = "2026-08-20T10:00:00.000Z"),
            bookmark = bookmark(note = "keep", updatedAt = "2026-08-22T10:00:00.000Z"),
        )
        val incoming = snapshot(
            archiveId = "22222222-2222-2222-2222-222222222222",
            category = category(title = "Renamed", updatedAt = "2026-08-21T10:00:00.000Z"),
            history = history(page = 0, percent = 0.0, updatedAt = "2026-08-21T10:00:00.000Z"),
            bookmark = bookmark(
                note = "deleted",
                updatedAt = "2026-08-19T10:00:00.000Z",
                deletedAt = "2026-08-23T10:00:00.000Z",
            ),
        )
        val repository = MemoryBackupRepository(current, availableSources = emptySet())
        val importer = NyoraBackupImporter(repository)

        val plan = importer.plan(NyoraBackupCodec.encode(incoming), NyoraRestoreMode.Merge)

        assertEquals(current, repository.state, "planning must not mutate storage")
        assertEquals("Renamed", plan.preview.categories.single().title)
        assertEquals(CATEGORY_ID, plan.preview.categories.single().id, "category identity must not be title-derived")
        assertEquals(0, plan.preview.history.single().page, "newest checkpoint must win even for a reread reset")
        assertEquals(0.0, plan.preview.history.single().percent)
        assertEquals("2026-08-23T10:00:00.000Z", plan.preview.bookmarks.single().deletedAt)
        assertEquals(listOf(SOURCE_ID), plan.unresolvedSources)
        assertTrue(plan.sections.getValue("categories").updates > 0)
        assertTrue(plan.sections.getValue("bookmarks").deletions > 0)
    }

    @Test
    fun `replace makes portable state match archive exactly`() {
        val current = snapshot(
            archiveId = "11111111-1111-1111-1111-111111111111",
            category = category(title = "Local", updatedAt = "2026-08-23T10:00:00.000Z"),
            history = history(page = 10, percent = 0.5, updatedAt = "2026-08-23T10:00:00.000Z"),
            bookmark = bookmark(note = "local", updatedAt = "2026-08-23T10:00:00.000Z"),
        )
        val incoming = snapshot(
            archiveId = "22222222-2222-2222-2222-222222222222",
            category = category(title = "Archive", updatedAt = "2026-08-20T10:00:00.000Z"),
            history = history(page = 1, percent = 0.1, updatedAt = "2026-08-20T10:00:00.000Z"),
            bookmark = null,
        )
        val repository = MemoryBackupRepository(current)

        val result = NyoraBackupImporter(repository).apply(
            NyoraBackupCodec.encode(incoming),
            NyoraRestoreMode.Replace,
        )

        assertEquals(incoming, repository.state)
        assertEquals(emptyList(), repository.state.bookmarks)
        assertEquals(NyoraRestoreMode.Replace, result.plan.mode)
        assertEquals(listOf("pause", "begin", "write", "commit", "resume", "reconcile"), repository.events)
    }

    private class MemoryBackupRepository(
        initial: NyoraBackupSnapshot,
        private val availableSources: Set<String> = setOf(SOURCE_ID),
    ) : NyoraBackupRepository {
        var state = initial
        val events = mutableListOf<String>()

        override fun readBackupSnapshot(): NyoraBackupSnapshot = state
        override fun availableBackupSourceIds(): Set<String> = availableSources
        override fun replaceBackupSnapshot(snapshot: NyoraBackupSnapshot) {
            events += "write"
            state = snapshot
        }
        override fun <T> inBackupTransaction(block: () -> T): T {
            events += "begin"
            val checkpoint = state
            return try {
                block().also { events += "commit" }
            } catch (failure: Throwable) {
                state = checkpoint
                events += "rollback"
                throw failure
            }
        }
        override fun setBackupSyncPaused(paused: Boolean) {
            events += if (paused) "pause" else "resume"
        }
        override fun reconcileBackupRestore() { events += "reconcile" }
    }

    companion object {
        private const val SOURCE_ID = "data:source"
        private const val MANGA_ID = "ff767544cc03b5b9d6fb245cea2646bf115e7ffaa10143fefa03703a9b8f5d5c"
        private const val CHAPTER_ID = "7d33ab72ea7e112f1eb2e8e049141d0cde8eadee0a52fdb7131012711fab7c44"
        private const val CATEGORY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        private const val BOOKMARK_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

        private fun snapshot(
            archiveId: String,
            category: NyoraBackupCategory,
            history: NyoraBackupHistory,
            bookmark: NyoraBackupBookmark?,
        ) = NyoraBackupSnapshot(
            archiveId = archiveId,
            createdAt = "2026-08-21T08:30:00.000Z",
            appVersion = "test",
            platform = "test",
            sources = listOf(NyoraBackupSource(SOURCE_ID, "r1", true, false, updatedAt = "2026-08-20T00:00:00.000Z")),
            categories = listOf(category),
            manga = listOf(NyoraBackupManga(MANGA_ID, SOURCE_ID, "/manga", "Manga", "2026-08-20T00:00:00.000Z")),
            chapters = listOf(NyoraBackupChapter(CHAPTER_ID, MANGA_ID, "/chapter", "Chapter", "2026-08-20T00:00:00.000Z")),
            library = listOf(NyoraBackupLibrary(MANGA_ID, "2026-08-20T00:00:00.000Z", listOf(CATEGORY_ID))),
            history = listOf(history),
            bookmarks = listOfNotNull(bookmark),
        )

        private fun category(title: String, updatedAt: String) =
            NyoraBackupCategory(CATEGORY_ID, title, 0, updatedAt)

        private fun history(page: Int, percent: Double, updatedAt: String) =
            NyoraBackupHistory(MANGA_ID, CHAPTER_ID, page, percent, updatedAt)

        private fun bookmark(note: String, updatedAt: String, deletedAt: String? = null) =
            NyoraBackupBookmark(BOOKMARK_ID, MANGA_ID, CHAPTER_ID, 1, note, updatedAt, deletedAt)
    }
}
