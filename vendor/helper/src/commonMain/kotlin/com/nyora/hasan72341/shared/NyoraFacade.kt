package com.nyora.hasan72341.shared

import com.nyora.hasan72341.shared.extension.MangaExtensionRuntime
import com.nyora.hasan72341.shared.extension.MangaExtensionService
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.repository.LibraryRepository

/**
 * Single entry point the SwiftUI layer consumes.
 *
 * Methods on this class are *blocking* on purpose — Swift will dispatch the calls
 * onto a background queue and convert results back to `@MainActor` state. We avoid
 * coroutine types in the public surface because they don't bridge cleanly into
 * Swift today.
 */
class NyoraFacade(
    private val repository: LibraryRepository,
    private val runtime: MangaExtensionRuntime,
) {
    fun loadLibrary(): Library = repository.load()

    fun saveLibrary(library: Library) {
        repository.save(library)
    }

    fun installSource(source: MangaSource, installer: (MangaSource) -> MangaSource): MangaSource {
        val installed = installer(source)
        repository.upsertSource(installed)
        return installed
    }

    fun togglePin(sourceId: String) {
        val current = repository.load()
        val updated = current.copy(
            sources = current.sources.map {
                if (it.id == sourceId) it.copy(isPinned = !it.isPinned) else it
            },
        )
        repository.save(updated)
    }

    fun listSources(): List<MangaSource> = repository.load().sources

    fun replaceSources(sources: List<MangaSource>) = repository.replaceSources(sources)

    fun listMangas(): List<Manga> = repository.load().mangas

    fun openExtension(source: MangaSource): MangaExtensionService = runtime.create(source)

    fun upsertManga(manga: Manga) {
        repository.upsertManga(manga)
    }

    fun upsertMangaDetails(manga: Manga, sourceId: String, contentKey: String): Manga =
        repository.upsertMangaDetails(manga, sourceId, contentKey)

    // History + favourites delegate straight to the repository.
    fun history(limit: Int = 100) = repository.history(limit)
    fun recordHistory(mangaId: String, sourceId: String, chapterId: String, chapterTitle: String, page: Int, percent: Float) {
        repository.recordHistory(mangaId, sourceId, chapterId, chapterTitle, page, percent)
    }
    fun removeHistory(mangaId: String) = repository.removeHistory(mangaId)
    fun clearHistory() = repository.clearHistory()
    fun clearDatabase() = repository.clearDatabase()

    fun favourites(): List<Manga> = repository.favourites()
    fun isFavourited(mangaId: String): Boolean = repository.isFavourited(mangaId)
    fun toggleFavourite(mangaId: String): Boolean = repository.toggleFavourite(mangaId)

    fun bookmarks() = repository.bookmarks()
    fun isPageBookmarked(mangaId: String, chapterId: String, page: Int): Boolean =
        repository.isPageBookmarked(mangaId, chapterId, page)
    fun addBookmark(mangaId: String, chapterId: String, chapterTitle: String, page: Int, note: String) =
        repository.addBookmark(mangaId, chapterId, chapterTitle, page, note)
    fun removeBookmark(id: Long) = repository.removeBookmark(id)
    fun removeBookmarkForPage(mangaId: String, chapterId: String, page: Int) =
        repository.removeBookmarkForPage(mangaId, chapterId, page)

    fun cachedPages(chapterUrl: String) = repository.cachedPages(chapterUrl)
    fun cachePages(chapterUrl: String, mangaId: String, pages: List<com.nyora.hasan72341.shared.model.MangaPage>) =
        repository.cachePages(chapterUrl, mangaId, pages)
    fun cachedPages(sourceId: String, chapterUrl: String) =
        repository.cachedPages(sourceScopedChapterKey(sourceId, chapterUrl))
    fun cachePages(
        sourceId: String,
        chapterUrl: String,
        mangaId: String,
        pages: List<com.nyora.hasan72341.shared.model.MangaPage>,
    ) = repository.cachePages(sourceScopedChapterKey(sourceId, chapterUrl), mangaId, pages)
    fun clearChapterPageCache() = repository.clearChapterPageCache()

    fun mangaPrefs(mangaId: String) = repository.mangaPrefs(mangaId)
    fun allMangaPrefs() = repository.allMangaPrefs()
    fun saveMangaPrefs(prefs: com.nyora.hasan72341.shared.repository.MangaPrefsRow) = repository.saveMangaPrefs(prefs)
    fun clearMangaPrefs(mangaId: String) = repository.clearMangaPrefs(mangaId)

    fun allTracking() = repository.allTracking()
    fun saveTracking(row: com.nyora.hasan72341.shared.repository.TrackingRow) = repository.saveTracking(row)

    fun favouriteCategories() = repository.favouriteCategories()
    fun favouritesIn(categoryId: Long) = repository.favouritesIn(categoryId)
    fun categoriesForManga(mangaId: String) = repository.categoriesForManga(mangaId)
    fun createCategory(title: String) = repository.createCategory(title)
    fun renameCategory(id: Long, title: String) = repository.renameCategory(id, title)
    fun deleteCategory(id: Long) = repository.deleteCategory(id)
    fun addToCategory(mangaId: String, categoryId: Long) = repository.addToCategory(mangaId, categoryId)
    fun removeFromCategory(mangaId: String, categoryId: Long) = repository.removeFromCategory(mangaId, categoryId)

    fun updates() = repository.updates()
    fun recordUpdateSync(mangaId: String, sourceId: String, currentChapterCount: Int, latestChapterTitle: String) =
        repository.recordUpdateSync(mangaId, sourceId, currentChapterCount, latestChapterTitle)
    fun markUpdatesSeen(mangaId: String) = repository.markUpdatesSeen(mangaId)
    fun markAllUpdatesSeen() = repository.markAllUpdatesSeen()

    // ── Nyora Sync Sync ──────────────────────────────────────────────────────

    fun nyoraSyncSignIn(email: String, password: String): String? = repository.nyoraSyncSignIn(email, password)
    fun nyoraSyncRegister(email: String, password: String): String? = repository.nyoraSyncRegister(email, password)

    fun nyoraSyncNow() = repository.nyoraSyncNow()

    fun nyoraSyncRestoreFromCloud() = repository.nyoraSyncRestoreFromCloud()

    fun hasLocalSyncableData(): Boolean = repository.hasLocalSyncableData()

    fun nyoraSyncSignOut() = repository.nyoraSyncSignOut()
}

private fun sourceScopedChapterKey(sourceId: String, chapterUrl: String): String =
    "$sourceId\u001f$chapterUrl"
