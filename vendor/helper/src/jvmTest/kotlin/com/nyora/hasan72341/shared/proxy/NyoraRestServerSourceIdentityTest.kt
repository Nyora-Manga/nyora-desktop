package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.MangaDetails
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.extension.MangaExtensionRuntime
import com.nyora.hasan72341.shared.extension.MangaExtensionService
import com.nyora.hasan72341.shared.extension.MangaSearchPage
import com.nyora.hasan72341.shared.extension.SourceFilter
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.repository.LibraryRepository
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NyoraRestServerSourceIdentityTest {

    @Test
    fun bookmarksRetainExactMangaAndChapterIdentityAfterHistoryIsCleared() {
        val directory = Files.createTempDirectory("nyora-bookmark-identity")
        val repository = com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository(directory.resolve("library.db"))
        try {
            val source = dataSource("data:bookmark-source")
            repository.upsertSource(source)
            val manga = Manga(
                id = "bookmark-manga", title = "Ambiguous title", url = "/manga/exact-identity/",
                source = MangaSourceRef.Script(source.id),
                chapters = listOf(MangaChapter(id = "stable-chapter-id", title = "Chapter 1", url = "/chapter/exact-chapter/")),
            )
            repository.upsertManga(manga)
            repository.recordHistory(manga.id, source.id, "stable-chapter-id", "Chapter 1", 7, 0.5f)
            repository.addBookmark(manga.id, "stable-chapter-id", "Chapter 1", 7, "")
            repository.clearHistory()
            assertTrue(repository.history().isEmpty())
            assertTrue(repository.favourites().isEmpty())
            withServer(repository, FakeRuntime()) { base ->
                val response = get("$base/library/bookmarks")
                assertEquals(200, response.statusCode(), response.body())
                val entry = org.json.JSONObject(response.body()).getJSONArray("entries").getJSONObject(0)
                assertEquals(source.id, entry.getString("sourceId"))
                assertEquals(manga.url, entry.getString("mangaUrl"))
                assertEquals("/chapter/exact-chapter/", entry.getString("chapterUrl"))
                assertEquals("stable-chapter-id", entry.getString("chapterId"))
                assertEquals(7, entry.getInt("page"))
            }
        } finally {
            repository.driver.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun browserCatalogueHidesWallBSourcesThatRequireALocalSolver() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val sources = DataDrivenCatalog.replace(
                """
                {"sources":[
                  {"id":"browser-wall-a","name":"Wall A","lang":"en","engine":"madara","domain":"wall-a.example","antiBot":"cloudflare","cfWall":"A","config":{}},
                  {"id":"browser-wall-b","name":"Wall B","lang":"en","engine":"madara","domain":"wall-b.example","antiBot":"cloudflare","cfWall":"B","config":{}}
                ]}
                """.trimIndent(),
            ).map { it.source }
            val repository = MemoryRepository(Library(sources = sources))

            withServer(repository, FakeRuntime()) { baseUrl ->
                val request = HttpRequest.newBuilder(URI("$baseUrl/sources"))
                    .header("Origin", "https://reader.example")
                    .GET()
                    .build()
                val response = HttpClient.newHttpClient().send(
                    request,
                    HttpResponse.BodyHandlers.ofString(),
                )

                assertEquals(200, response.statusCode(), response.body())
                assertTrue(response.body().contains("data:browser-wall-a"), response.body())
                assertFalse(response.body().contains("data:browser-wall-b"), response.body())

                val catalogResponse = HttpClient.newHttpClient().send(
                    HttpRequest.newBuilder(URI("$baseUrl/sources/catalog"))
                        .header("Origin", "https://reader.example")
                        .GET()
                        .build(),
                    HttpResponse.BodyHandlers.ofString(),
                )
                assertEquals(200, catalogResponse.statusCode(), catalogResponse.body())
                assertTrue(catalogResponse.body().contains("data:browser-wall-a"), catalogResponse.body())
                assertFalse(catalogResponse.body().contains("data:browser-wall-b"), catalogResponse.body())
            }
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun dataDrivenSourceCanBeInstalledThenUninstalledWithoutDeletingItsDefinition() {
        val source = dataSource("data:toggle-source").copy(
            isInstalled = false,
            canUninstall = false,
        )
        val repository = MemoryRepository(Library(sources = listOf(source)))

        withServer(repository, FakeRuntime()) { baseUrl ->
            val install = post("$baseUrl/sources/install?id=${encoded(source.id)}")
            assertEquals(200, install.statusCode(), install.body())
            assertTrue(repository.load().sources.single().isInstalled)

            val uninstall = delete("$baseUrl/sources/uninstall?id=${encoded(source.id)}")
            assertEquals(200, uninstall.statusCode(), uninstall.body())
            assertEquals(1, repository.load().sources.size)
            assertFalse(repository.load().sources.single().isInstalled)
            assertFalse(repository.load().sources.single().canUninstall)
        }
    }

    @Test
    fun suggestionsUseTheCurrentDataSourceForRenamedLegacyParserIdentities() {
        val fallback = dataSource("data:fallback")
        val current = dataSource("data:manganelo")
        val favourite = Manga(
            id = "favourite",
            title = "Favourite",
            source = MangaSourceRef.Parser("MANGANELO_COM"),
        )
        val repository = MemoryRepository(
            initial = Library(sources = listOf(fallback, current)),
            favouriteRows = listOf(favourite),
        )
        val runtime = FakeRuntime(popularSourceRef = MangaSourceRef.Parser("MANGANELO_COM"))

        withServer(repository, runtime) { baseUrl ->
            val response = get("$baseUrl/suggestions")

            assertEquals(200, response.statusCode(), response.body())
            assertTrue(response.body().contains("\"title\":\"data:manganelo\""), response.body())
            assertTrue(response.body().contains("\"sourceId\":\"data:manganelo\""), response.body())
            assertFalse(response.body().contains("parser:MANGANELO_COM"), response.body())
        }
    }

    @Test
    fun favouriteOnlyMangaReturnsAnOpenableCurrentDataSource() {
        val current = dataSource("data:manganelo")
        val favourite = Manga(
            id = "-4928346791005383400",
            title = "Favourite",
            url = "/manga/nato-title",
            source = MangaSourceRef.Parser("MANGANELO_COM"),
        )
        val repository = MemoryRepository(
            initial = Library(sources = listOf(current)),
            favouriteRows = listOf(favourite),
        )

        withServer(repository, FakeRuntime()) { baseUrl ->
            val response = get("$baseUrl/library/favourites")

            assertEquals(200, response.statusCode(), response.body())
            assertTrue(response.body().contains("data:manganelo"), response.body())
            assertFalse(response.body().contains("MANGANELO_COM"), response.body())
        }
    }

    @Test
    fun legacyManga18HistoryIdentitiesResolveToCurrentDataSources() {
        assertEquals(
            "data:porncomic18",
            openableHistorySourceId(MangaSourceRef.Parser("PORNCOMIC18"), ""),
        )
        assertEquals(
            "data:manga18",
            openableHistorySourceId(MangaSourceRef.Parser("MANGA18"), ""),
        )
        assertEquals(
            "data:porncomic18",
            openableHistorySourceId(MangaSourceRef.Unknown, "parser:PORNCOMIC18"),
        )
        assertEquals(
            "data:porncomic18",
            openableHistorySourceId(MangaSourceRef.Script("JS_PORNCOMIC18"), ""),
        )
    }

    @Test
    fun renamedLegacyParserIdentitiesResolveToTheirCurrentCatalogueIds() {
        val aliases = mapOf(
            "MANGANELO_COM" to "data:manganelo",
            "HMANGABAT" to "data:mangabat",
            "MANGAFIRE_ESLA" to "data:mangafire_es_la",
            "MANGAFIRE_PTBR" to "data:mangafire_pt_br",
            "MAID_ID" to "data:maid-id",
            "SHIRO_DOUJIN" to "data:shiro-doujin",
            "KOMIKINDO_INFO" to "data:mangasusuku",
            "XBATCAT" to "data:xbatcat",
            "KOMIKINDO_CH" to "data:komikindo_ch",
            "WEBTOONS_EN" to "data:webtoons",
        )

        aliases.forEach { (legacy, current) ->
            assertEquals(current, openableHistorySourceId(MangaSourceRef.Parser(legacy), ""), legacy)
            assertEquals(current, openableHistorySourceId(MangaSourceRef.Unknown, "parser:$legacy"), legacy)
        }
    }

    @Test
    fun retiredKomikindoDataRefsResolveToTheLiveMangaSusukuSource() {
        assertEquals(
            "data:mangasusuku",
            openableHistorySourceId(MangaSourceRef.Script("data:komikindo-info"), ""),
        )
        assertEquals(
            "data:mangasusuku",
            openableHistorySourceId(MangaSourceRef.Unknown, "data:komikindo-info"),
        )
    }

    @Test
    fun updatesRefreshOpensTheCurrentPornComicDataSourceId() {
        val source = dataSource("data:porncomic18").copy(name = "18PornComic")
        val favourite = Manga(
            id = "porncomic-favourite",
            title = "PornComic Favourite",
            url = "/comic/porncomic-favourite",
            source = MangaSourceRef.Script("data:porncomic18"),
        )
        val repository = MemoryRepository(
            initial = Library(sources = listOf(source)),
            favouriteRows = listOf(favourite),
        )
        val runtime = FakeRuntime()

        withServer(repository, runtime) { baseUrl ->
            val response = post("$baseUrl/library/updates/refresh")

            assertEquals(200, response.statusCode(), response.body())
            assertTrue(response.body().contains("\"checked\":1"), response.body())
            assertEquals(1, runtime.detailsCalls.getValue(source.id).get())
        }
    }

    @Test
    fun updatesRefreshOpensTheCurrentSourceForARenamedParserIdentity() {
        val source = dataSource("data:manganelo").copy(name = "Manganelo")
        val favourite = Manga(
            id = "legacy-manganelo-favourite",
            title = "Legacy Manganelo Favourite",
            url = "/manga/legacy-manganelo-favourite",
            source = MangaSourceRef.Parser("MANGANELO_COM"),
        )
        val repository = MemoryRepository(
            initial = Library(sources = listOf(source)),
            favouriteRows = listOf(favourite),
        )
        val runtime = FakeRuntime()

        withServer(repository, runtime) { baseUrl ->
            val response = post("$baseUrl/library/updates/refresh")

            assertEquals(200, response.statusCode(), response.body())
            assertTrue(response.body().contains("\"checked\":1"), response.body())
            assertEquals(1, runtime.detailsCalls.getValue(source.id).get())
        }
    }

    @Test
    fun detailsPreserveTheDataDrivenSourceReferenceReturnedByTheService() {
        val source = dataSource("data:identity")
        val repository = MemoryRepository(Library(sources = listOf(source)))
        val runtime = FakeRuntime(detailsSource = MangaSourceRef.Script(source.id))
        withServer(repository, runtime) { baseUrl ->
            val response = get("$baseUrl/manga/details?id=${encoded(source.id)}&url=${encoded("/title")}")

            assertEquals(200, response.statusCode())
            assertEquals(MangaSourceRef.Script(source.id), repository.load().mangas.single().source)
        }
    }

    @Test
    fun equalRelativeChapterUrlsUseSeparateCachesForDifferentSources() {
        val first = dataSource("data:first")
        val second = dataSource("data:second")
        val repository = MemoryRepository(Library(sources = listOf(first, second)))
        val runtime = FakeRuntime()
        withServer(repository, runtime) { baseUrl ->
            val chapter = "/chapter/1"

            assertEquals(200, get("$baseUrl/manga/pages?id=${encoded(first.id)}&url=${encoded(chapter)}").statusCode())
            assertEquals(200, get("$baseUrl/manga/pages?id=${encoded(second.id)}&url=${encoded(chapter)}").statusCode())

            assertEquals(1, runtime.pageCalls.getValue(first.id).get())
            assertEquals(1, runtime.pageCalls.getValue(second.id).get())
            assertEquals(2, repository.pageCache.size)
        }
    }

    private fun withServer(
        repository: LibraryRepository,
        runtime: FakeRuntime,
        block: (String) -> Unit,
    ) {
        val extensions = Files.createTempDirectory("nyora-rest-source-test")
        val server = NyoraRestServer(
            facade = NyoraFacade(repository, runtime),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
        )
        try {
            block(server.start())
        } finally {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    private fun get(url: String): HttpResponse<String> = HttpClient.newHttpClient().send(
        HttpRequest.newBuilder(URI(url)).GET().build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun post(url: String): HttpResponse<String> = HttpClient.newHttpClient().send(
        HttpRequest.newBuilder(URI(url)).POST(HttpRequest.BodyPublishers.noBody()).build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun delete(url: String): HttpResponse<String> = HttpClient.newHttpClient().send(
        HttpRequest.newBuilder(URI(url)).DELETE().build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun encoded(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8)

    private fun dataSource(id: String) = MangaSource(
        id = id,
        name = id,
        lang = "en",
        baseUrl = "https://${id.removePrefix("data:")}.example",
        isInstalled = true,
        engine = SourceEngine.JavaScript,
    )

    private class FakeRuntime(
        private val detailsSource: MangaSourceRef = MangaSourceRef.Unknown,
        private val popularSourceRef: MangaSourceRef? = null,
    ) : MangaExtensionRuntime {
        val pageCalls = ConcurrentHashMap<String, AtomicInteger>()
        val detailsCalls = ConcurrentHashMap<String, AtomicInteger>()

        override fun create(source: MangaSource): MangaExtensionService = object : MangaExtensionService {
            override val supportsLatest: Boolean = true
            override val domain: String = source.baseUrl.removePrefix("https://")
            override suspend fun getPopular(page: Int) = MangaSearchPage(
                entries = popularSourceRef?.let { resultSource ->
                    listOf(
                        Manga(
                            id = "suggestion-${source.id}",
                            title = source.id,
                            source = resultSource,
                        ),
                    )
                }.orEmpty(),
                hasNextPage = false,
            )
            override suspend fun getLatest(page: Int) = MangaSearchPage(emptyList(), false)
            override suspend fun search(query: String, page: Int, filters: List<SourceFilter>) =
                MangaSearchPage(emptyList(), false)
            override suspend fun getDetails(url: String): MangaDetails {
                detailsCalls.computeIfAbsent(source.id) { AtomicInteger() }.incrementAndGet()
                return MangaDetails(
                    manga = Manga(id = url, title = "Title", url = url, source = detailsSource),
                    chapters = emptyList(),
                )
            }
            override suspend fun getPageList(chapter: MangaChapter): List<MangaPage> {
                pageCalls.computeIfAbsent(source.id) { AtomicInteger() }.incrementAndGet()
                return listOf(MangaPage("https://cdn.example/${source.id.removePrefix("data:")}.jpg"))
            }
        }
    }

    private class MemoryRepository(
        initial: Library,
        private val favouriteRows: List<Manga> = emptyList(),
    ) : LibraryRepository {
        @Volatile
        private var library = initial
        val pageCache = ConcurrentHashMap<String, List<MangaPage>>()

        override fun load(): Library = library
        override fun save(library: Library) { this.library = library }
        override fun upsertManga(manga: Manga) {
            save(library.copy(mangas = listOf(manga) + library.mangas.filterNot { it.id == manga.id }))
        }
        override fun upsertSource(source: MangaSource) {
            save(library.copy(sources = listOf(source) + library.sources.filterNot { it.id == source.id }))
        }
        override fun cachedPages(chapterUrl: String): List<MangaPage>? = pageCache[chapterUrl]
        override fun cachePages(chapterUrl: String, mangaId: String, pages: List<MangaPage>) {
            pageCache[chapterUrl] = pages
        }
        override fun clearChapterPageCache() {
            pageCache.clear()
        }
        override fun favourites(): List<Manga> = favouriteRows
    }
}
