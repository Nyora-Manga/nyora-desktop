package com.nyora.hasan72341.shared.repository

import com.nyora.hasan72341.shared.model.MangaPage
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ChapterPageCacheTest {
    @Test
    fun partialPageListsExpireDailyWithoutEvictingAnotherSourcesFreshChapter() {
        val directory = Files.createTempDirectory("nyora-page-cache-age")
        val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
        try {
            val now = System.currentTimeMillis()
            // Same chapter path, independent source keys, one old partial result.
            val oldKey = "data:old\u001f/chapter/1"
            val freshKey = "data:fresh\u001f/chapter/1"
            repository.cachePages(oldKey, "old", listOf(MangaPage(url = "https://old.example/1.jpg")))
            val fresh = listOf(MangaPage(url = "https://fresh.example/1.jpg"), MangaPage(url = "https://fresh.example/2.jpg"))
            repository.cachePages(freshKey, "fresh", fresh)
            val old = repository.database.chapterPagesQueries.selectForChapter(oldKey).executeAsOne()
            repository.database.chapterPagesQueries.upsert(oldKey, "old", old.pages_json, now - 86_400_001L)
            assertNull(repository.cachedPages(oldKey))
            assertEquals(fresh, repository.cachedPages(freshKey))
            repository.cachePages(oldKey, "old", fresh)
            assertEquals(fresh, repository.cachedPages(oldKey))
        } finally { repository.driver.close(); directory.toFile().deleteRecursively() }
    }
}
