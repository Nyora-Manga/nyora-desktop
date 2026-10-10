package com.nyora.hasan72341.shared.repository

import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaSource

interface LibraryRepository {
    fun load(): Library
    fun save(library: Library)
    fun upsertManga(manga: Manga)

    /** Persist parsed details and return the identity committed by this repository. */
    fun upsertMangaDetails(manga: Manga, sourceId: String, contentKey: String): Manga {
        upsertManga(manga)
        return manga
    }
    fun upsertSource(source: MangaSource)
    fun deleteSource(sourceId: String) {}

    /** Replace source rows exactly, including deleting rows absent from [sources]. */
    fun replaceSources(sources: List<MangaSource>) {
        save(load().copy(sources = sources))
    }

    /** Last-read manga, newest first. */
    fun history(limit: Int = 100): List<HistoryRow> = emptyList()

    /** Upsert a per-manga reading checkpoint. */
    fun recordHistory(
        mangaId: String,
        sourceId: String,
        chapterId: String,
        chapterTitle: String,
        page: Int,
        percent: Float,
    ) {}

    fun removeHistory(mangaId: String) {}
    fun clearHistory() {}
    fun clearDatabase() {}

    /** Manga marked as favourite, newest-favourited first. */
    fun favourites(): List<Manga> = emptyList()

    fun isFavourited(mangaId: String): Boolean = false

    /** Add/remove. Returns the new state (true = now favourited). */
    fun toggleFavourite(mangaId: String): Boolean = false

    /** All bookmarks, newest first. */
    fun bookmarks(): List<BookmarkRow> = emptyList()

    fun bookmarksForChapter(mangaId: String, chapterId: String): List<BookmarkRow> = emptyList()

    fun isPageBookmarked(mangaId: String, chapterId: String, page: Int): Boolean = false

    fun addBookmark(mangaId: String, chapterId: String, chapterTitle: String, page: Int, note: String) {}

    fun removeBookmark(id: Long) {}

    fun removeBookmarkForPage(mangaId: String, chapterId: String, page: Int) {}

    /** Cached page list for a chapter, or null if missing or stale (>7d). */
    fun cachedPages(chapterUrl: String): List<com.nyora.hasan72341.shared.model.MangaPage>? = null

    fun cachePages(chapterUrl: String, mangaId: String, pages: List<com.nyora.hasan72341.shared.model.MangaPage>) {}

    fun clearChapterPageCache() {}

    // Per-manga reader prefs (overrides app-wide defaults).
    fun mangaPrefs(mangaId: String): MangaPrefsRow? = null
    fun allMangaPrefs(): List<MangaPrefsRow> = emptyList()
    fun saveMangaPrefs(prefs: MangaPrefsRow) {}
    fun clearMangaPrefs(mangaId: String) {}

    // Favourite categories
    fun favouriteCategories(): List<FavouriteCategoryRow> = emptyList()
    fun favouritesIn(categoryId: Long): List<com.nyora.hasan72341.shared.model.Manga> = emptyList()
    fun categoriesForManga(mangaId: String): List<FavouriteCategoryRow> = emptyList()
    fun createCategory(title: String): Long = -1L
    fun renameCategory(id: Long, title: String) {}
    fun deleteCategory(id: Long) {}
    fun addToCategory(mangaId: String, categoryId: Long) {}
    fun removeFromCategory(mangaId: String, categoryId: Long) {}

    /** Manga with new chapters since last sync. */
    fun updates(): List<UpdateRow> = emptyList()

    fun recordUpdateSync(
        mangaId: String,
        sourceId: String,
        currentChapterCount: Int,
        latestChapterTitle: String,
    ) {}

    fun markUpdatesSeen(mangaId: String) {}
    fun markAllUpdatesSeen() {}

    // Per-service tracking links + live state (canonical cross-platform schema).
    // Backed by the local tracking store (TS-010); the defaults are empty/no-op so
    // backup export/import round-trips a tracking section losslessly the moment that
    // store exists, without any change to the backup handlers.
    fun allTracking(): List<TrackingRow> = emptyList()
    fun saveTracking(row: TrackingRow) {}

    fun nyoraSyncSignIn(email: String, password: String): String? = "Sync unavailable"
    fun nyoraSyncRegister(email: String, password: String): String? = "Sync unavailable"
    fun nyoraSyncNow() {}
    fun nyoraSyncRestoreFromCloud() {}
    fun hasLocalSyncableData(): Boolean = false
    fun nyoraSyncSignOut() {}
}

data class HistoryRow(
    val manga: Manga,
    val sourceId: String,
    val chapterId: String,
    val chapterTitle: String,
    val page: Int,
    val percent: Float,
    val updatedAt: Long,
)

data class BookmarkRow(
    val id: Long,
    val mangaId: String,
    val mangaTitle: String,
    val mangaCoverUrl: String,
    val chapterId: String,
    val chapterTitle: String,
    val page: Int,
    val note: String,
    val createdAt: Long,
    val mangaSource: com.nyora.hasan72341.shared.model.MangaSourceRef = com.nyora.hasan72341.shared.model.MangaSourceRef.Script(""),
    val mangaUrl: String = "",
    val chapterUrl: String? = null,
)

data class FavouriteCategoryRow(
    val id: Long,
    val title: String,
    val sortKey: Int,
    val createdAt: Long,
    val mangaCount: Int,
)

/**
 * A per-service tracking record in the canonical cross-platform schema
 * (matches the server `nyora_tracking` table and the iOS/Android clients).
 */
data class TrackingRow(
    val trackerId: String,
    val remoteId: String,
    val sourceId: String,
    val mangaId: String,
    val title: String,
    val status: String,           // canonical: reading/planning/completed/paused/dropped/rereading
    val score: Float,
    val lastReadChapter: Float,
    val lastReadVolume: Int,
    val totalChapters: Int,
    val totalVolumes: Int,
    val chapterOffset: Int,
    val startedAt: String,        // ISO-8601, empty = unset
    val finishedAt: String,       // ISO-8601, empty = unset
    val comment: String,
    val updatedAt: String,        // ISO-8601 (LWW clock)
    val deletedAt: String,        // ISO-8601, empty = live (soft-delete tombstone)
)

data class MangaPrefsRow(
    val mangaId: String,
    val readerMode: String,      // empty = inherit app default
    val brightness: Double,
    val contrast: Double,
    val saturation: Double,
    val hue: Double,
    val palette: String,         // empty = none
)

data class UpdateRow(
    val mangaId: String,
    val mangaTitle: String,
    val mangaCoverUrl: String,
    val sourceId: String,
    val newChapters: Int,
    val totalChapters: Int,
    val latestChapterTitle: String,
    val lastSyncedAt: Long,
)
