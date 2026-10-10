package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.CommonMangaExtensionRuntime
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.extension.MangaDetails
import com.nyora.hasan72341.shared.extension.MangaExtensionService
import com.nyora.hasan72341.shared.extension.MangaSearchPage
import com.nyora.hasan72341.shared.extension.SourceFilter
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.repository.HistoryRow
import com.nyora.hasan72341.shared.repository.LibraryRepository
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CatalogueConcurrencySecurityTest {

    @AfterTest
    fun restoreProcessState() {
        val bundled = requireNotNull(javaClass.classLoader.getResourceAsStream("nyora/catalogue.json"))
            .bufferedReader().use { it.readText() }
        DataDrivenCatalog.replace(bundled)
        ResponseCache.invalidate("catalog")
        ResponseCache.invalidatePrefix("browse:")
    }

    @Test
    fun fixedPortHostedServerRejectsCatalogueMutationBeforeDownloading() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val repository = repositoryForCurrentCatalogue()
        var downloaded = false
        val fixedPort = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        val running = server(
            repository = repository,
            replacement = catalogue(SOURCE_ID, "new.example"),
            port = fixedPort,
            onDownload = { downloaded = true },
        )
        try {
            val response = postCatalogue(running.baseUrl)

            assertEquals(403, response.statusCode())
            assertFalse(downloaded)
            assertTrue(repository.load().sources.single().baseUrl.contains("old.example"))
        } finally {
            running.close()
        }
    }

    @Test
    fun preReplacementBrowseCannotRepopulateThePostReplacementCache() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        ResponseCache.invalidatePrefix("browse:")
        val repository = repositoryForCurrentCatalogue()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val newFetches = AtomicInteger()
        val running = server(
            repository = repository,
            replacement = catalogue(SOURCE_ID, "new.example"),
            runtime = runtime(startedBrowse = started, releaseBrowse = release, newBrowseFetches = newFetches),
        )
        val client = HttpClient.newHttpClient()
        val browseUrl = "${running.baseUrl}/sources/popular?id=data%3A$SOURCE_ID&page=1"
        val oldRequest = client.sendAsync(getRequest(browseUrl), HttpResponse.BodyHandlers.ofString())
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS), "old browse did not start")
            assertEquals(200, postCatalogue(running.baseUrl, client).statusCode())
            release.countDown()
            assertEquals(200, oldRequest.get(5, TimeUnit.SECONDS).statusCode())

            val current = client.send(getRequest(browseUrl), HttpResponse.BodyHandlers.ofString())
            assertEquals(200, current.statusCode())
            assertTrue(current.body().contains("new.example"), current.body())
            assertFalse(current.body().contains("old.example"), current.body())
            assertEquals(1, newFetches.get())
        } finally {
            release.countDown()
            running.close()
        }
    }

    @Test
    fun preReplacementPageFetchCannotPersistAfterCatalogueCacheClear() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val repository = repositoryForCurrentCatalogue()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val running = server(
            repository = repository,
            replacement = catalogue(SOURCE_ID, "new.example"),
            runtime = runtime(startedPages = started, releasePages = release),
        )
        val client = HttpClient.newHttpClient()
        val pagesUrl = "${running.baseUrl}/manga/pages?id=data%3A$SOURCE_ID&url=%2Fchapter%2F1&refresh=1"
        val oldRequest = client.sendAsync(getRequest(pagesUrl), HttpResponse.BodyHandlers.ofString())
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS), "old page fetch did not start")
            assertEquals(200, postCatalogue(running.baseUrl, client).statusCode())
            release.countDown()
            oldRequest.get(5, TimeUnit.SECONDS)

            assertTrue(repository.cachedPageUrls().isEmpty(), repository.cachedPageUrls().toString())
            val current = client.send(
                getRequest(pagesUrl.removeSuffix("&refresh=1")),
                HttpResponse.BodyHandlers.ofString(),
            )
            assertTrue(current.body().contains("new.example"), current.body())
            assertFalse(current.body().contains("old.example"), current.body())
        } finally {
            release.countDown()
            running.close()
        }
    }

    @Test
    fun preReplacementDetailsCannotPersistOrRespondWithOldMetadata() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val repository = repositoryForCurrentCatalogue()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val running = server(
            repository = repository,
            replacement = catalogue(SOURCE_ID, "new.example"),
            runtime = runtime(startedDetails = started, releaseDetails = release),
        )
        val client = HttpClient.newHttpClient()
        val detailsUrl = "${running.baseUrl}/manga/details?id=data%3A$SOURCE_ID&url=%2Fmanga%2Fone"
        val oldRequest = client.sendAsync(getRequest(detailsUrl), HttpResponse.BodyHandlers.ofString())
        try {
            assertTrue(started.await(5, TimeUnit.SECONDS), "old details fetch did not start")
            assertEquals(200, postCatalogue(running.baseUrl, client).statusCode())
            release.countDown()

            assertEquals(409, oldRequest.get(5, TimeUnit.SECONDS).statusCode())
            assertNull(repository.manga("/manga/one"))
            val current = client.send(getRequest(detailsUrl), HttpResponse.BodyHandlers.ofString())
            assertEquals(200, current.statusCode())
            assertTrue(current.body().contains("new.example"), current.body())
            assertEquals("new.example", repository.manga("/manga/one")?.title)
        } finally {
            release.countDown()
            running.close()
        }
    }

    @Test
    fun sameIdDomainChangeAcrossRestartDoesNotReuseBrowseOrPageCaches() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        ResponseCache.invalidatePrefix("browse:")
        val repository = repositoryForCurrentCatalogue()
        val first = server(repository, catalogue(SOURCE_ID, "unused.example"), runtime = runtime())
        val client = HttpClient.newHttpClient()
        try {
            assertTrue(get(client, "${first.baseUrl}/sources/popular?id=data%3A$SOURCE_ID&page=1").contains("old.example"))
            assertTrue(get(client, "${first.baseUrl}/manga/pages?id=data%3A$SOURCE_ID&url=%2Fchapter%2F1").contains("old.example"))
        } finally {
            first.close()
        }

        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "new.example"))
        repository.save(repository.load().copy(sources = DataDrivenCatalog.load().map { it.source }))
        val second = server(repository, catalogue(SOURCE_ID, "unused.example"), runtime = runtime())
        try {
            val browse = get(client, "${second.baseUrl}/sources/popular?id=data%3A$SOURCE_ID&page=1")
            val pages = get(client, "${second.baseUrl}/manga/pages?id=data%3A$SOURCE_ID&url=%2Fchapter%2F1")
            assertTrue(browse.contains("new.example"), browse)
            assertTrue(pages.contains("new.example"), pages)
            assertFalse(browse.contains("old.example"), browse)
            assertFalse(pages.contains("old.example"), pages)
        } finally {
            second.close()
        }
    }

    @Test
    fun cloudflareClearanceIsLocalOnlyBoundedAndRequiresABareHost() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val hostedRepository = repositoryForCurrentCatalogue()
        val fixedPort = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        val hosted = server(hostedRepository, catalogue(SOURCE_ID, "unused.example"), port = fixedPort)
        try {
            assertEquals(403, postClearance(hosted.baseUrl, "old.example", "cf_clearance=test").statusCode())
        } finally {
            hosted.close()
        }

        val local = server(repositoryForCurrentCatalogue(), catalogue(SOURCE_ID, "unused.example"))
        try {
            assertEquals(200, postClearance(local.baseUrl, "old.example", "cf_clearance=test").statusCode())
            assertEquals(
                200,
                HttpClient.newHttpClient().send(
                    getRequest("${local.baseUrl}/settings/network"),
                    HttpResponse.BodyHandlers.ofString(),
                ).statusCode(),
            )
            assertEquals(
                400,
                postClearance(local.baseUrl, "https://evil.example/path", "cf_clearance=test").statusCode(),
            )
            assertEquals(
                413,
                postClearance(local.baseUrl, "old.example", "x".repeat(16 * 1024 + 1)).statusCode(),
            )
        } finally {
            local.close()
        }
    }

    @Test
    fun localListenerRejectsPublicProxyHeadersForSensitiveMutationRoutes() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        var downloaded = false
        val running = server(
            repositoryForCurrentCatalogue(),
            catalogue(SOURCE_ID, "new.example"),
            onDownload = { downloaded = true },
        )
        val client = HttpClient.newHttpClient()
        try {
            val catalogue = HttpRequest.newBuilder(URI("${running.baseUrl}/sources/catalogue"))
                .header("Content-Type", "application/json")
                .header("X-Real-IP", "203.0.113.10")
                .POST(HttpRequest.BodyPublishers.ofString("{\"url\":\"https://catalogue.example/new.json\"}"))
                .build()
            val clearance = HttpRequest.newBuilder(URI("${running.baseUrl}/cloudflare/clearance?domain=old.example"))
                .header("X-Forwarded-For", "203.0.113.11, 127.0.0.1")
                .POST(HttpRequest.BodyPublishers.ofString("cf_clearance=test"))
                .build()
            val network = HttpRequest.newBuilder(URI("${running.baseUrl}/settings/network"))
                .header("X-Real-IP", "203.0.113.12")
                .GET()
                .build()

            assertEquals(403, client.send(catalogue, HttpResponse.BodyHandlers.ofString()).statusCode())
            assertEquals(403, client.send(clearance, HttpResponse.BodyHandlers.ofString()).statusCode())
            assertEquals(403, client.send(network, HttpResponse.BodyHandlers.ofString()).statusCode())
            assertFalse(downloaded)
        } finally {
            running.close()
        }
    }

    @Test
    fun managementRoutesRejectForwardedPublicClientsAndBrowserOrigins() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val running = server(repositoryForCurrentCatalogue(), catalogue(SOURCE_ID, "new.example"))
        val client = HttpClient.newHttpClient()
        val requests = listOf(
            "/sources/catalogue" to "{\"url\":\"https://catalogue.example/new.json\"}",
            "/cloudflare/clearance?domain=old.example" to "cf_clearance=test",
            "/settings/network" to "",
            "/sources/refresh" to "",
            "/sources/install?id=data%3A$SOURCE_ID" to "",
            "/sources/uninstall?id=data%3A$SOURCE_ID" to "",
            "/sources/pin?id=data%3A$SOURCE_ID" to "",
            "/sources/setInstalled" to "[]",
        )
        try {
            for ((path, body) in requests) {
                val hostileOrigin = HttpRequest.newBuilder(URI("${running.baseUrl}$path"))
                    .header("Origin", "https://attacker.example")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build()
                val forwardedPublic = HttpRequest.newBuilder(URI("${running.baseUrl}$path"))
                    .header("X-Real-IP", "203.0.113.20")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build()

                assertEquals(
                    403,
                    client.send(hostileOrigin, HttpResponse.BodyHandlers.ofString()).statusCode(),
                    "Origin gate for $path",
                )
                assertEquals(
                    403,
                    client.send(forwardedPublic, HttpResponse.BodyHandlers.ofString()).statusCode(),
                    "forwarded-client gate for $path",
                )
            }
        } finally {
            running.close()
        }
    }

    @Test
    fun managementRoutesRejectPrefixSuffixesAndSpoofedLoopbackProxyHeaders() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val running = server(repositoryForCurrentCatalogue(), catalogue(SOURCE_ID, "new.example"))
        val client = HttpClient.newHttpClient()
        val routes = listOf(
            "/sources/catalogue" to "{\"url\":\"https://catalogue.example/new.json\"}",
            "/cloudflare/clearance?domain=old.example" to "cf_clearance=test",
            "/settings/network" to "",
            "/sources/refresh" to "",
            "/sources/install?id=data%3A$SOURCE_ID" to "",
            "/sources/uninstall?id=data%3A$SOURCE_ID" to "",
            "/sources/pin?id=data%3A$SOURCE_ID" to "",
            "/sources/setInstalled" to "[]",
        )
        try {
            for ((route, body) in routes) {
                val path = route.substringBefore('?')
                val query = route.substringAfter('?', missingDelimiterValue = "")
                val suffix = "$path/attacker" + query.takeIf { it.isNotEmpty() }?.let { "?$it" }.orEmpty()
                val suffixRequest = HttpRequest.newBuilder(URI("${running.baseUrl}$suffix"))
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build()
                val spoofedProxy = HttpRequest.newBuilder(URI("${running.baseUrl}$route"))
                    .header("X-Real-IP", "127.0.0.1")
                    .header("X-Forwarded-For", "127.0.0.1")
                    .header("CF-Connecting-IP", "127.0.0.1")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build()

                assertEquals(
                    403,
                    client.send(suffixRequest, HttpResponse.BodyHandlers.ofString()).statusCode(),
                    "prefix-suffix gate for $route",
                )
                assertEquals(
                    403,
                    client.send(spoofedProxy, HttpResponse.BodyHandlers.ofString()).statusCode(),
                    "spoofed-proxy gate for $route",
                )
            }
        } finally {
            running.close()
        }
    }

    @Test
    fun emptyPagesAreNotPersistedAndClearanceForcesANonemptyRetry() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val repository = repositoryForCurrentCatalogue()
        val calls = AtomicInteger()
        val runtime = CommonMangaExtensionRuntime(jsFactory = { source ->
            sourceService(source, pageCalls = calls, firstPagesEmpty = true)
        })
        val running = server(repository, catalogue(SOURCE_ID, "unused.example"), runtime = runtime)
        val client = HttpClient.newHttpClient()
        val pagesUrl = "${running.baseUrl}/manga/pages?id=data%3A$SOURCE_ID&url=%2Fchapter%2F1"
        try {
            val empty = get(client, "$pagesUrl&refresh=1")
            assertTrue(empty.contains("\"pages\":[]"), empty)
            assertTrue(repository.cachedPageUrls().isEmpty())

            assertEquals(200, postClearance(running.baseUrl, "old.example", "cf_clearance=test", client).statusCode())
            val retried = get(client, pagesUrl)
            assertTrue(retried.contains("old.example"), retried)
            assertEquals(2, calls.get())
            assertTrue(repository.cachedPageUrls().isNotEmpty())
        } finally {
            running.close()
        }
    }

    @Test
    fun clearanceClearsFailedCoverResolutionSoHistoryCanRetry() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val repository = repositoryForCurrentCatalogue()
        repository.historyRows = listOf(
            HistoryRow(
                manga = Manga(
                    id = "history-manga",
                    title = "History title",
                    url = "/manga/history",
                    source = MangaSourceRef.Script("data:$SOURCE_ID"),
                ),
                sourceId = "data:$SOURCE_ID",
                chapterId = "chapter",
                chapterTitle = "Chapter",
                page = 0,
                percent = 0f,
                updatedAt = 1L,
            ),
        )
        val searchCalls = AtomicInteger()
        val runtime = CommonMangaExtensionRuntime(jsFactory = { source -> historyService(source, searchCalls) })
        val running = server(repository, catalogue(SOURCE_ID, "unused.example"), runtime = runtime)
        val client = HttpClient.newHttpClient()
        try {
            val first = get(client, "${running.baseUrl}/library/history")
            assertFalse(first.contains("cover.jpg"), first)
            assertEquals(1, searchCalls.get())

            assertEquals(200, postClearance(running.baseUrl, "old.example", "cf_clearance=test", client).statusCode())
            val second = get(client, "${running.baseUrl}/library/history")
            assertTrue(second.contains("cover.jpg"), second)
            assertEquals(2, searchCalls.get())
        } finally {
            running.close()
        }
    }

    @Test
    fun catalogueReplacementClearsFailedCoverResolutionSoHistoryUsesTheNewDomain() {
        DataDrivenCatalog.replace(catalogue(SOURCE_ID, "old.example"))
        val repository = repositoryForCurrentCatalogue()
        repository.historyRows = listOf(
            HistoryRow(
                manga = Manga(
                    id = "catalogue-history-manga",
                    title = "History title",
                    url = "/manga/history",
                    source = MangaSourceRef.Script("data:$SOURCE_ID"),
                ),
                sourceId = "data:$SOURCE_ID",
                chapterId = "chapter",
                chapterTitle = "Chapter",
                page = 0,
                percent = 0f,
                updatedAt = 1L,
            ),
        )
        val searchCalls = AtomicInteger()
        val runtime = CommonMangaExtensionRuntime(jsFactory = { source -> historyService(source, searchCalls) })
        val running = server(repository, catalogue(SOURCE_ID, "new.example"), runtime = runtime)
        val client = HttpClient.newHttpClient()
        try {
            val first = get(client, "${running.baseUrl}/library/history")
            assertFalse(first.contains("cover.jpg"), first)
            assertEquals(1, searchCalls.get())

            assertEquals(200, postCatalogue(running.baseUrl, client).statusCode())
            val second = get(client, "${running.baseUrl}/library/history")
            assertTrue(second.contains("new.example"), second)
            assertTrue(second.contains("cover.jpg"), second)
            assertEquals(2, searchCalls.get())
        } finally {
            running.close()
        }
    }

    private fun server(
        repository: MemoryRepository,
        replacement: String,
        runtime: CommonMangaExtensionRuntime = runtime(),
        port: Int = 0,
        onDownload: () -> Unit = {},
    ): RunningServer {
        val extensions = Files.createTempDirectory("nyora-catalogue-security")
        val server = NyoraRestServer(
            facade = NyoraFacade(repository, runtime),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
            reseedDataDrivenSources = {
                repository.save(repository.load().copy(sources = DataDrivenCatalog.load().map { it.source }))
            },
            persistDataDrivenCatalogue = {},
            catalogueDownloader = {
                onDownload()
                replacement
            },
            port = port,
        )
        return RunningServer(server, extensions, server.start())
    }

    private fun runtime(
        startedBrowse: CountDownLatch? = null,
        releaseBrowse: CountDownLatch? = null,
        startedPages: CountDownLatch? = null,
        releasePages: CountDownLatch? = null,
        startedDetails: CountDownLatch? = null,
        releaseDetails: CountDownLatch? = null,
        newBrowseFetches: AtomicInteger? = null,
    ) = CommonMangaExtensionRuntime(jsFactory = { source ->
        sourceService(
            source = source,
            startedBrowse = startedBrowse,
            releaseBrowse = releaseBrowse,
            startedPages = startedPages,
            releasePages = releasePages,
            startedDetails = startedDetails,
            releaseDetails = releaseDetails,
            newBrowseFetches = newBrowseFetches,
        )
    })

    private fun sourceService(
        source: MangaSource,
        startedBrowse: CountDownLatch? = null,
        releaseBrowse: CountDownLatch? = null,
        startedPages: CountDownLatch? = null,
        releasePages: CountDownLatch? = null,
        startedDetails: CountDownLatch? = null,
        releaseDetails: CountDownLatch? = null,
        newBrowseFetches: AtomicInteger? = null,
        pageCalls: AtomicInteger? = null,
        firstPagesEmpty: Boolean = false,
    ): MangaExtensionService = object : MangaExtensionService {
        private val marker = source.baseUrl.removePrefix("https://")
        override val supportsLatest = true
        override val domain = marker

        override suspend fun getPopular(page: Int): MangaSearchPage {
            if (marker == "old.example") awaitGate(startedBrowse, releaseBrowse)
            else newBrowseFetches?.incrementAndGet()
            return MangaSearchPage(
                entries = listOf(Manga(id = marker, title = marker, url = "/manga/$marker", coverUrl = "")),
                hasNextPage = false,
            )
        }

        override suspend fun getLatest(page: Int) = getPopular(page)

        override suspend fun search(query: String, page: Int, filters: List<SourceFilter>) = getPopular(page)

        override suspend fun getDetails(url: String): MangaDetails {
            if (marker == "old.example") awaitGate(startedDetails, releaseDetails)
            return MangaDetails(
                manga = Manga(id = url, title = marker, url = url, coverUrl = "https://$marker/cover.jpg"),
                chapters = listOf(MangaChapter(id = "chapter", title = marker, url = "/chapter/1")),
            )
        }

        override suspend fun getPageList(chapter: MangaChapter): List<MangaPage> {
            if (marker == "old.example") awaitGate(startedPages, releasePages)
            val call = pageCalls?.incrementAndGet() ?: 1
            if (firstPagesEmpty && call == 1) return emptyList()
            return listOf(MangaPage(url = "https://$marker/images/page.jpg"))
        }
    }

    private fun historyService(source: MangaSource, calls: AtomicInteger): MangaExtensionService =
        object : MangaExtensionService {
            override val supportsLatest = true
            override val domain = source.baseUrl.removePrefix("https://")
            override suspend fun getPopular(page: Int) = MangaSearchPage(emptyList(), false)
            override suspend fun getLatest(page: Int) = MangaSearchPage(emptyList(), false)
            override suspend fun search(query: String, page: Int, filters: List<SourceFilter>): MangaSearchPage {
                if (calls.incrementAndGet() == 1) return MangaSearchPage(emptyList(), false)
                return MangaSearchPage(
                    listOf(
                        Manga(
                            id = "resolved",
                            title = query,
                            url = "/manga/history",
                            coverUrl = "${source.baseUrl.trimEnd('/')}/cover.jpg",
                        ),
                    ),
                    false,
                )
            }
            override suspend fun getDetails(url: String) = MangaDetails(Manga(id = url, title = url, url = url), emptyList())
            override suspend fun getPageList(chapter: MangaChapter) = emptyList<MangaPage>()
        }

    private fun awaitGate(started: CountDownLatch?, release: CountDownLatch?) {
        if (started == null || release == null) return
        started.countDown()
        check(release.await(5, TimeUnit.SECONDS)) { "test gate timed out" }
    }

    private fun postCatalogue(base: String, client: HttpClient = HttpClient.newHttpClient()) = client.send(
        HttpRequest.newBuilder(URI("$base/sources/catalogue"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString("{\"url\":\"https://catalogue.example/new.json\"}"))
            .build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun postClearance(
        base: String,
        domain: String,
        body: String,
        client: HttpClient = HttpClient.newHttpClient(),
    ) = client.send(
        HttpRequest.newBuilder(
            URI("$base/cloudflare/clearance?domain=${URLEncoder.encode(domain, StandardCharsets.UTF_8)}"),
        ).POST(HttpRequest.BodyPublishers.ofString(body)).build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun get(client: HttpClient, url: String): String =
        client.send(getRequest(url), HttpResponse.BodyHandlers.ofString()).body()

    private fun getRequest(url: String): HttpRequest = HttpRequest.newBuilder(URI(url)).GET().build()

    private fun repositoryForCurrentCatalogue() = MemoryRepository(
        Library(sources = DataDrivenCatalog.load().map { it.source }),
    )

    private fun catalogue(id: String, domain: String): String = """
        {"sources":[{"id":"$id","name":"$id","lang":"en","engine":"madara","domain":"$domain","config":{}}]}
    """.trimIndent()

    private data class RunningServer(
        val server: NyoraRestServer,
        val extensions: java.nio.file.Path,
        val baseUrl: String,
    ) {
        fun close() {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    private class MemoryRepository(initial: Library) : LibraryRepository {
        @Volatile
        private var library = initial
        private val pageCache = ConcurrentHashMap<String, List<MangaPage>>()
        var historyRows: List<HistoryRow> = emptyList()

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
        override fun clearChapterPageCache() { pageCache.clear() }
        override fun history(limit: Int): List<HistoryRow> = historyRows.take(limit)

        fun cachedPageUrls(): List<String> = pageCache.values.flatten().map { it.url }
        fun manga(id: String): Manga? = library.mangas.firstOrNull { it.id == id }
    }

    private companion object {
        const val SOURCE_ID = "race-source"
    }
}
