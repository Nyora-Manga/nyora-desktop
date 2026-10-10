package com.nyora.hasan72341.shared.extension

import app.nyora.core.model.Manga as EngineManga
import app.nyora.core.model.MangaChapter as EngineMangaChapter
import app.nyora.core.model.MangaListFilter
import app.nyora.core.model.MangaPage as EngineMangaPage
import app.nyora.core.model.MangaTag as EngineMangaTag
import app.nyora.core.model.MangaState as EngineMangaState
import app.nyora.core.model.ContentRating as EngineContentRating
import app.nyora.core.model.SortOrder
import app.nyora.data.engine.ContentType as EngineContentType
import app.nyora.data.engine.FilterCapabilities
import app.nyora.data.engine.ImageRequest
import app.nyora.data.engine.SourceDef
import app.nyora.data.engine.SourceEngine as DataEngine
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaSourceRef
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class DataDrivenExtensionServiceTest {

    @Test
    fun adultSourceAndContentRatingArePreservedInTheSharedNsfwFlag() {
        val safe = DataDrivenCatalog.load().first { !it.source.isNsfw }.source
        val adult = requireNotNull(DataDrivenCatalog.find("data:nhentai_to")).source
        val manga = EngineManga(id = "example", title = "Test Book", url = "/g/123/")
        assertEquals(false, manga.toShared(safe).isNsfw)
        assertTrue(manga.toShared(adult).isNsfw)
        assertTrue(manga.copy(contentRating = EngineContentRating.ADULT).toShared(safe).isNsfw)
        assertTrue(manga.copy(isNsfw = true).toShared(safe).isNsfw)
    }

    @Test
    fun pornComic18BrowseAndDetailsKeepTheLegacyKotatsuMangaId() = runBlocking {
        val entry = requireNotNull(DataDrivenCatalog.find("data:porncomic18"))
        val mangaUrl = "/manga/secret-class/"
        val engine = IdentityEngine(
            source = entry.definition,
            browseManga = EngineManga(
                id = "engine-browse-id",
                title = "Secret Class",
                url = mangaUrl,
                source = entry.definition.id,
            ),
            detailsManga = EngineManga(
                id = "engine-details-id",
                title = "Secret Class",
                url = mangaUrl,
                source = entry.definition.id,
            ),
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val browsed = service.getPopular(page = 1).entries.single()
        val detailed = service.getDetails(mangaUrl).manga

        // Legacy KotatsuParserExtensionService hash of PORNCOMIC18 + mangaUrl.
        assertEquals("-8888176714300257652", browsed.id)
        assertEquals("-8888176714300257652", detailed.id)
        assertEquals(browsed.id, detailed.id)
        assertEquals(mangaUrl, engine.detailsInput?.id)
        assertEquals(mangaUrl, engine.detailsInput?.url)
    }

    @Test
    fun mangaSusukuKeepsTheLegacyKomikindoInfoMangaId() = runBlocking {
        val entry = requireNotNull(DataDrivenCatalog.find("data:mangasusuku"))
        val mangaUrl = "/manga/example"
        val engine = IdentityEngine(
            source = entry.definition,
            browseManga = EngineManga(
                id = "new-engine-id",
                title = "Example",
                url = mangaUrl,
                source = entry.definition.id,
            ),
            detailsManga = EngineManga(
                id = "new-engine-id",
                title = "Example",
                url = mangaUrl,
                source = entry.definition.id,
            ),
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val browsed = service.getPopular(page = 1).entries.single()

        assertEquals("2893531190161962583", browsed.id)
    }

    @Test
    fun mapsEngineMangaIntoASourceQualifiedSharedManga() {
        val source = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }.source
        val mapped = EngineManga(
            id = "/series/a",
            title = "A",
            url = "/series/a",
            source = "asurascans",
        ).toShared(source)

        assertEquals(MangaSourceRef.Script("data:asurascans"), mapped.source)
        assertEquals("-3283707728137281649", mapped.id)
        assertEquals("https://asurascans.com/series/a", mapped.publicUrl)
    }

    @Test
    fun pageHeadersMergeTheSourceRefererBeforePageOverrides() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = PageEngine(
            source = entry.definition,
            pages = listOf(
                EngineMangaPage(
                    url = "first",
                    headers = mapOf("Authorization" to "Bearer page-token"),
                ),
                EngineMangaPage(
                    url = "second",
                    headers = mapOf("Referer" to "https://images.example/reader/"),
                ),
            ),
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val pages = runBlocking {
            service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
        }

        assertEquals(
            mapOf(
                "Referer" to "${entry.source.baseUrl}/",
                "Authorization" to "Bearer page-token",
            ),
            pages[0].headers,
        )
        assertEquals(
            mapOf("Referer" to "https://images.example/reader/"),
            pages[1].headers,
        )
    }

    @Test
    fun resolvedImageRequestHeadersOverridePageAndSourceHeaders() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = PageEngine(
            source = entry.definition,
            pages = listOf(
                EngineMangaPage(
                    url = "reader-page",
                    headers = mapOf("Referer" to "https://page.example/", "X-Page" to "kept"),
                ),
            ),
            resolveRequest = {
                ImageRequest(
                    url = "https://images.example/final.jpg",
                    headers = mapOf("Referer" to "https://resolved.example/", "User-Agent" to "Image UA"),
                )
            },
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val page = runBlocking {
            service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
        }.single()

        assertEquals("https://images.example/final.jpg", page.url)
        assertEquals(
            mapOf(
                "Referer" to "https://resolved.example/",
                "X-Page" to "kept",
                "User-Agent" to "Image UA",
            ),
            page.headers,
        )
    }

    @Test
    fun searchMapsEverySharedFilterAxisIntoTheEngineContract() = runBlocking {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = FilterRecordingEngine(entry.definition)
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        service.search(
            query = "  chosen hero  ",
            page = 3,
            filters = listOf(
                TextSourceFilter("Tags", "action, romance"),
                TextSourceFilter("Excluded tags", "gore, tragedy"),
                TextSourceFilter("Year", "2024"),
                TextSourceFilter("Author", " Jane Doe "),
                SelectSourceFilter("State", 1),
                SelectSourceFilter("Type", 2),
                SelectSourceFilter("Rating", 3),
                TextSourceFilter("Locale", "pt-BR"),
            ),
        )

        assertEquals(2, engine.searchPage)
        assertEquals("chosen hero", engine.searchQuery)
        assertEquals(
            MangaListFilter(
                query = "chosen hero",
                tags = setOf(
                    EngineMangaTag(title = "action", key = "action", source = entry.definition.id),
                    EngineMangaTag(title = "romance", key = "romance", source = entry.definition.id),
                ),
                tagsExclude = setOf(
                    EngineMangaTag(title = "gore", key = "gore", source = entry.definition.id),
                    EngineMangaTag(title = "tragedy", key = "tragedy", source = entry.definition.id),
                ),
                states = setOf(EngineMangaState.ONGOING),
                types = setOf(EngineContentType.MANHWA),
                contentRating = setOf(EngineContentRating.ADULT),
                year = 2024,
                author = "Jane Doe",
                locale = java.util.Locale.forLanguageTag("pt-BR"),
            ),
            engine.searchFilter,
        )
    }

    @Test
    fun filterListExposesEveryEngineFilterOption() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = FilterRecordingEngine(entry.definition)
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val descriptors = service.getFilterList().associateBy { it.name }

        assertEquals(
            setOf("Tags", "Excluded tags", "Year", "Author", "State", "Type", "Rating", "Locale"),
            descriptors.keys,
        )
        assertEquals("text", descriptors.getValue("Tags").typeName)
        assertEquals("text", descriptors.getValue("Excluded tags").typeName)
        assertEquals("text", descriptors.getValue("Year").typeName)
        assertEquals("text", descriptors.getValue("Author").typeName)
        assertEquals(listOf("Any", "ONGOING", "FINISHED", "ABANDONED", "PAUSED", "UPCOMING"), descriptors.getValue("State").values)
        assertEquals(listOf("Any") + EngineContentType.entries.map { it.name }, descriptors.getValue("Type").values)
        assertEquals(listOf("Any", "SAFE", "SUGGESTIVE", "ADULT"), descriptors.getValue("Rating").values)
        assertEquals("text", descriptors.getValue("Locale").typeName)
    }

    @Test
    fun selectedSortReachesTheEngineWithOtherFilters() = runBlocking {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = FilterRecordingEngine(entry.definition)
        val service = DataDrivenExtensionService(entry.source, entry, engine)
        service.search("", 2, listOf(TextSourceFilter("Sort", "ALPHABETICAL_DESC"), TextSourceFilter("Tags", "opaque-123")))
        assertTrue(engine.searchFilter.toString().contains("sortOrder=ALPHABETICAL_DESC"))
        assertEquals("opaque-123", engine.searchFilter?.tags?.single()?.key)
        assertEquals(1, engine.searchPage)
    }

    @Test
    fun blankQueryAndNoSharedFiltersUseTheEngineEmptyFilter() = runBlocking {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = FilterRecordingEngine(entry.definition)
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        service.search(query = "   ", page = 1, filters = emptyList())

        assertEquals(0, engine.searchPage)
        assertEquals(null, engine.searchQuery)
        assertEquals(MangaListFilter.EMPTY, engine.searchFilter)
    }

    @Test
    fun pageImageUrlsResolveConcurrentlyWithABoundOfEightAndKeepReadingOrder() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val active = AtomicInteger()
        val maxActive = AtomicInteger()
        val engine = PageEngine(
            source = entry.definition,
            pages = (0 until 12).map { EngineMangaPage(url = it.toString()) },
            resolve = { page ->
                val current = active.incrementAndGet()
                maxActive.updateAndGet { previous -> maxOf(previous, current) }
                try {
                    val index = page.url.toInt()
                    delay((12 - index) * 10L)
                    "https://images.example/$index.jpg"
                } finally {
                    active.decrementAndGet()
                }
            },
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val pages = runBlocking {
            service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
        }

        assertEquals(
            (0 until 12).map { "https://images.example/$it.jpg" },
            pages.map { it.url },
        )
        assertTrue(maxActive.get() > 1, "page image URLs were resolved serially")
        assertTrue(maxActive.get() <= 8, "more than eight page image URLs resolved at once")
    }

    @Test
    fun pageImageResolutionUsesOneBoundAcrossConcurrentChapterRequests() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val active = AtomicInteger()
        val maxActive = AtomicInteger()
        val engine = PageEngine(
            source = entry.definition,
            pages = (0 until 16).map { EngineMangaPage(url = it.toString()) },
            resolve = { page ->
                val current = active.incrementAndGet()
                maxActive.updateAndGet { previous -> maxOf(previous, current) }
                try {
                    delay(75)
                    "https://images.example/${page.url}.jpg"
                } finally {
                    active.decrementAndGet()
                }
            },
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        runBlocking {
            val first = async { service.getPageList(MangaChapter(id = "one", title = "", url = "/one")) }
            val second = async { service.getPageList(MangaChapter(id = "two", title = "", url = "/two")) }
            first.await()
            second.await()
        }

        assertTrue(maxActive.get() > 1, "page image URLs were resolved serially")
        assertTrue(maxActive.get() <= 8, "concurrent chapters exceeded the global resolution cap")
    }

    @Test
    fun indirectPageResolutionFailureAbortsTheChapterAndRemainsRetryable() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val attempts = AtomicInteger()
        val engine = PageEngine(
            source = entry.definition,
            pages = listOf(
                EngineMangaPage(url = "first"),
                EngineMangaPage(url = "indirect", headers = mapOf("Referer" to "https://reader.example/")),
                EngineMangaPage(url = "third"),
            ),
            resolve = { page ->
                if (page.url == "indirect" && attempts.getAndIncrement() == 0) {
                    error("temporary resolver failure")
                }
                "https://images.example/${page.url}.jpg"
            },
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        assertFailsWith<IllegalStateException> {
            runBlocking {
                service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
            }
        }

        val pages = runBlocking {
            service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
        }

        assertEquals(
            listOf(
                "https://images.example/first.jpg",
                "https://images.example/indirect.jpg",
                "https://images.example/third.jpg",
            ),
            pages.map { it.url },
        )
        assertEquals(mapOf("Referer" to "https://reader.example/"), pages[1].headers)
    }

    @Test
    fun indirectPageCloudflareChallengeIsSurfacedForTheMacSolver() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = PageEngine(
            source = entry.definition,
            pages = listOf(EngineMangaPage(url = "https://reader.example/page/1")),
            resolve = { throw IOException("Cloudflare challenge: images.example") },
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val error = assertFailsWith<IOException> {
            runBlocking {
                service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
            }
        }

        assertEquals("Cloudflare challenge: images.example", error.message)
    }

    @Test
    fun pageResolutionCancellationPropagatesWithoutReturningFallbackPages() {
        val entry = DataDrivenCatalog.load().first { it.source.id == "data:asurascans" }
        val engine = PageEngine(
            source = entry.definition,
            pages = listOf(EngineMangaPage(url = "https://reader.example/page/1")),
            resolve = { throw CancellationException("reader closed") },
        )
        val service = DataDrivenExtensionService(entry.source, entry, engine)

        val error = assertFailsWith<CancellationException> {
            runBlocking {
                service.getPageList(MangaChapter(id = "chapter", title = "", url = "/chapter"))
            }
        }

        assertEquals("reader closed", error.message)
    }

    private class FilterRecordingEngine(
        override val source: SourceDef,
    ) : DataEngine {
        override val availableSortOrders: Set<SortOrder> = emptySet()
        override val capabilities: FilterCapabilities = FilterCapabilities(
            multipleTags = true,
            tagsExclusion = true,
            search = true,
            searchWithFilters = true,
            year = true,
            authorSearch = true,
        )
        var searchPage: Int? = null
        var searchQuery: String? = null
        var searchFilter: MangaListFilter? = null

        override suspend fun getPopular(page: Int): List<EngineManga> = emptyList()
        override suspend fun getLatest(page: Int): List<EngineManga> = emptyList()
        override suspend fun search(
            page: Int,
            query: String?,
            filter: MangaListFilter,
        ): List<EngineManga> {
            searchPage = page
            searchQuery = query
            searchFilter = filter
            return emptyList()
        }

        override suspend fun getAvailableTags(): Set<EngineMangaTag> = emptySet()
        override suspend fun getDetails(manga: EngineManga): EngineManga = manga
        override suspend fun getPageList(chapter: EngineMangaChapter): List<EngineMangaPage> = emptyList()
        override suspend fun getPageImageUrl(page: EngineMangaPage): String = page.url
    }

    private class PageEngine(
        override val source: SourceDef,
        private val pages: List<EngineMangaPage>,
        private val resolve: suspend (EngineMangaPage) -> String = { it.url },
        private val resolveRequest: (suspend (EngineMangaPage) -> ImageRequest)? = null,
    ) : DataEngine {
        override val availableSortOrders: Set<SortOrder> = emptySet()
        override val capabilities: FilterCapabilities = FilterCapabilities()

        override suspend fun getPopular(page: Int): List<EngineManga> = emptyList()
        override suspend fun getLatest(page: Int): List<EngineManga> = emptyList()
        override suspend fun search(
            page: Int,
            query: String?,
            filter: MangaListFilter,
        ): List<EngineManga> = emptyList()

        override suspend fun getAvailableTags(): Set<EngineMangaTag> = emptySet()
        override suspend fun getDetails(manga: EngineManga): EngineManga = manga
        override suspend fun getPageList(chapter: EngineMangaChapter): List<EngineMangaPage> = pages
        override suspend fun getPageImageUrl(page: EngineMangaPage): String = resolve(page)
        override suspend fun resolvePageImageRequest(page: EngineMangaPage): ImageRequest =
            resolveRequest?.invoke(page) ?: ImageRequest(resolve(page))
    }

    private class IdentityEngine(
        override val source: SourceDef,
        private val browseManga: EngineManga,
        private val detailsManga: EngineManga,
    ) : DataEngine {
        override val availableSortOrders: Set<SortOrder> = emptySet()
        override val capabilities: FilterCapabilities = FilterCapabilities()
        var detailsInput: EngineManga? = null

        override suspend fun getPopular(page: Int): List<EngineManga> = listOf(browseManga)
        override suspend fun getLatest(page: Int): List<EngineManga> = emptyList()
        override suspend fun search(
            page: Int,
            query: String?,
            filter: MangaListFilter,
        ): List<EngineManga> = emptyList()

        override suspend fun getAvailableTags(): Set<EngineMangaTag> = emptySet()
        override suspend fun getDetails(manga: EngineManga): EngineManga {
            detailsInput = manga
            return detailsManga
        }
        override suspend fun getPageList(chapter: EngineMangaChapter): List<EngineMangaPage> = emptyList()
        override suspend fun getPageImageUrl(page: EngineMangaPage): String = page.url
    }
}
