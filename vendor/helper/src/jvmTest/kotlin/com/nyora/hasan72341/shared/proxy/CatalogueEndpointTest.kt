package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.CommonMangaExtensionRuntime
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.extension.JvmExtensionRuntime
import com.nyora.hasan72341.shared.extension.MangaDetails
import com.nyora.hasan72341.shared.extension.MangaExtensionService
import com.nyora.hasan72341.shared.extension.MangaSearchPage
import com.nyora.hasan72341.shared.extension.SourceFilter
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.repository.LibraryRepository
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CatalogueEndpointTest {

    @Test
    fun isolatedRelayKeepsChallengeSourcesAndPreservesImageIdentityAndVerification() {
        val root = Files.createTempDirectory("nyora-isolated-relay-endpoint")
        val previousIsolated = System.getProperty("nyora.desktop.isolated")
        val previousRoot = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.desktop.isolated", "true")
        System.setProperty("nyora.data.dir", root.toString())
        val relayServer = mockwebserver3.MockWebServer()
        var helper: NyoraRestServer? = null
        try {
            DataDrivenCatalog.replace("""{"sources":[
                {"id":"stable","engine":"madara","domain":"source.example"},
                {"id":"challenged","engine":"madara","domain":"source.example","cfWall":"B"},
                {"id":"broken","engine":"madara","domain":"source.example","broken":true},
                {"id":"unsupported","engine":"does-not-exist","domain":"source.example"}
            ]}""")
            assertEquals(2, DataDrivenCatalog.load().size)
            assertEquals(1, DataDrivenCatalog.loadForSolverlessClient().size)
            ResponseCache.invalidatePrefix("catalog:")
            relayServer.start()
            val network = com.nyora.hasan72341.shared.net.HelperNetworkConfig(
                desktopRelay = com.nyora.hasan72341.shared.net.DesktopSourceRelay(
                    "http://127.0.0.1:${relayServer.port}/fetch", "relay-test-only-credential-0123456789abcdef"))
            val repository = MemoryRepository(Library(sources = DataDrivenCatalog.load().map { it.source }))
            helper = NyoraRestServer(
                facade = NyoraFacade(repository, CommonMangaExtensionRuntime(jsFactory = {
                    source -> pageService(source, "verification_required sourceId=${source.id} origin=https://source.example/")
                })),
                catalog = SourceCatalogClient(), installer = ExtensionInstaller(root.resolve("extensions")),
                networkConfig = network, pageLoader = com.nyora.hasan72341.shared.reader.PageImageLoader(network),
            )
            val base = helper.start()
            val client = HttpClient.newHttpClient()
            fun get(path: String, token: String? = System.getenv("NYORA_HELPER_TOKEN")): HttpResponse<String> {
                val builder = HttpRequest.newBuilder(URI(base + path)).header("Origin", "https://desktop.invalid").GET()
                token?.let { builder.header("Authorization", "Bearer $it") }
                return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            }
            assertEquals(401, get("/sources/catalog", null).statusCode())
            assertEquals(401, get("/sources/catalog", "incorrect-credential").statusCode())
            val rows = org.json.JSONObject(get("/sources/catalog").body()).getJSONArray("entries")
            assertEquals(setOf("data:stable", "data:challenged"), (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }.toSet())
            assertEquals("chromium", org.json.JSONObject(get("/health").body()).getString("sourceTransport"))
            val pages = get("/manga/pages?id=data%3Astable&url=%2Fchapter%2F1&refresh=1")
            assertEquals(200, pages.statusCode())
            assertTrue(pages.body().contains("sourceId=data%3Astable"))
            assertEquals(400, get("/image?u=https%3A%2F%2Fsource.example%2Fimage.jpg").statusCode())
            assertEquals(400, get("/image?sourceId=data%3Astable&sourceId=data%3Achallenged&u=https%3A%2F%2Fsource.example%2Fimage.jpg").statusCode())
            assertEquals(404, get("/image?sourceId=data%3Abroken&u=https%3A%2F%2Fsource.example%2Fimage.jpg").statusCode())
            val challenge = "<html><title>Just a moment</title>challenge-platform</html>"
            val encoded = java.util.Base64.getEncoder().encodeToString(challenge.toByteArray())
            relayServer.enqueue(mockwebserver3.MockResponse.Builder().body("""{"status":200,"headers":{"content-type":"text/html"},"bodyBase64":"$encoded"}""").build())
            val image = get("/image?sourceId=data%3Astable&u=https%3A%2F%2Fsource.example%2Fimage.jpg")
            assertEquals(409, image.statusCode())
            assertEquals("verification_required", org.json.JSONObject(image.body()).getString("code"))
            val request = requireNotNull(relayServer.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("data:stable", org.json.JSONObject(request.body!!.utf8()).getString("sourceId"))
            assertEquals(409, get("/sources/search?id=data%3Astable&q=test").statusCode())
            assertEquals(503, get("/cloudflare/clearance").statusCode())
        } finally {
            helper?.stop()
            relayServer.close()
            if (previousIsolated == null) System.clearProperty("nyora.desktop.isolated") else System.setProperty("nyora.desktop.isolated", previousIsolated)
            if (previousRoot == null) System.clearProperty("nyora.data.dir") else System.setProperty("nyora.data.dir", previousRoot)
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun browserCatalogueMembershipDoesNotDependOnNodeChallengeHistory() {
        DataDrivenCatalog.replace("""{"sources":[
            {"id":"stable-source","name":"Stable","lang":"en","engine":"madara","domain":"stable-catalogue.example","config":{}},
            {"id":"solver-source","name":"Solver","lang":"en","engine":"madara","domain":"solver-catalogue.example","cfWall":"B","config":{}}
        ]}""")
        ResponseCache.invalidatePrefix("catalog:")
        val repository = MemoryRepository(Library(sources = DataDrivenCatalog.load().map { it.source }))
        val extensions = Files.createTempDirectory("nyora-stable-catalogue")
        val server = NyoraRestServer(
            facade = NyoraFacade(repository, JvmExtensionRuntime()),
            catalog = SourceCatalogClient(), installer = ExtensionInstaller(extensions),
        )
        try {
            val url = URI("${server.start()}/sources/catalog")
            val client = HttpClient.newHttpClient()
            fun browserIds(): List<String> {
                val response = client.send(HttpRequest.newBuilder(url)
                    .header("Origin", "https://web.nyora.xyz").GET().build(), HttpResponse.BodyHandlers.ofString())
                assertEquals(200, response.statusCode())
                assertEquals("no-store", response.headers().firstValue("Cache-Control").orElse(""))
                val rows = org.json.JSONObject(response.body()).getJSONArray("entries")
                return (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }
            }
            assertEquals(listOf("data:stable-source"), browserIds())
            com.nyora.hasan72341.shared.net.CloudflareInterceptor.noteChallenged("stable-catalogue.example")
            ResponseCache.invalidatePrefix("catalog:")
            assertEquals(listOf("data:stable-source"), browserIds())
        } finally {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    @AfterTest
    fun restoreProcessState() {
        val bundled = requireNotNull(javaClass.classLoader.getResourceAsStream("nyora/catalogue.json"))
            .bufferedReader().use { it.readText() }
        DataDrivenCatalog.replace(bundled)
        ResponseCache.invalidate("catalog")
        ResponseCache.invalidatePrefix("browse:")
    }

    @Test
    fun postCatalogueDownloadsAppliesAndInvalidatesCachesAndFaviconWarmState() {
        DataDrivenCatalog.replace(catalogue("old-source", "old.example"))
        val repository = MemoryRepository(
            Library(sources = DataDrivenCatalog.load().map { it.source }),
        )
        var downloadedUri: URI? = null
        var persistedBody: String? = null
        var reseedCount = 0
        val replacement = catalogue("new-source", "new.example")
        val extensions = Files.createTempDirectory("nyora-catalogue-endpoint-extensions")
        val server = NyoraRestServer(
            facade = NyoraFacade(repository, JvmExtensionRuntime()),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
            reseedDataDrivenSources = {
                reseedCount += 1
                repository.save(repository.load().copy(sources = DataDrivenCatalog.load().map { it.source }))
            },
            persistDataDrivenCatalogue = { persistedBody = it },
            catalogueDownloader = {
                downloadedUri = it
                replacement
            },
        )
        val client = HttpClient.newHttpClient()
        try {
            val base = server.start()
            awaitBody(client, "$base/sources") { it.contains("old.example") && it.contains("google.com/s2/favicons") }
            get(client, "$base/sources/catalog") // populate the old catalogue response cache

            val response = client.send(
                HttpRequest.newBuilder(URI("$base/sources/catalogue"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"url\":\"https://catalogue.example/new.json\"}"))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )

            assertEquals(200, response.statusCode())
            assertTrue(response.body().contains("new-source"))
            assertEquals(URI("https://catalogue.example/new.json"), downloadedUri)
            assertEquals(replacement, persistedBody)
            assertEquals(1, reseedCount)
            assertEquals(1, repository.pageCacheClearCount)
            val refreshedCatalog = get(client, "$base/sources/catalog")
            assertTrue(refreshedCatalog.contains("new-source"))
            assertFalse(refreshedCatalog.contains("old-source"))
            awaitBody(client, "$base/sources") { it.contains("new.example") && it.contains("google.com/s2/favicons") }
        } finally {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    @Test
    fun updatingTheSameSourceDomainInvalidatesItsImageReferer() {
        val sourceId = "referer-source"
        DataDrivenCatalog.replace(catalogue(sourceId, "old.example"))
        val repository = MemoryRepository(
            Library(sources = DataDrivenCatalog.load().map { it.source }),
        )
        val runtime = CommonMangaExtensionRuntime(jsFactory = { source -> pageService(source) })
        val replacement = catalogue(sourceId, "new.example")
        val extensions = Files.createTempDirectory("nyora-catalogue-referer-test")
        val server = NyoraRestServer(
            facade = NyoraFacade(repository, runtime),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
            reseedDataDrivenSources = {
                repository.save(repository.load().copy(sources = DataDrivenCatalog.load().map { it.source }))
            },
            persistDataDrivenCatalogue = {},
            catalogueDownloader = { replacement },
        )
        val client = HttpClient.newHttpClient()
        try {
            val base = server.start()
            val pagesUrl = "$base/manga/pages?id=data%3A$sourceId&url=%2Fchapter%2F1&refresh=1"
            assertTrue(get(client, pagesUrl).contains("old.example"))

            val response = client.send(
                HttpRequest.newBuilder(URI("$base/sources/catalogue"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"url\":\"https://catalogue.example/new.json\"}"))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )

            assertEquals(200, response.statusCode())
            val refreshedPages = get(client, pagesUrl)
            assertTrue(refreshedPages.contains("new.example"))
            assertFalse(refreshedPages.contains("old.example"))
        } finally {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    @Test
    fun installOverlappingFailedCataloguePersistenceCommitsAfterRollback() {
        val sourceId = "shared-source"
        DataDrivenCatalog.replace(catalogue(sourceId, "old.example"))
        val repository = MemoryRepository(
            Library(sources = DataDrivenCatalog.load().map { it.source.copy(isInstalled = false) }),
        )
        val persistenceStarted = CountDownLatch(1)
        val releasePersistence = CountDownLatch(1)
        val catalogueResponse = AtomicReference<HttpResponse<String>?>()
        val catalogueFailure = AtomicReference<Throwable?>()
        val installResponse = AtomicReference<HttpResponse<String>?>()
        val installFailure = AtomicReference<Throwable?>()
        val installFinished = CountDownLatch(1)
        val replacement = catalogue(sourceId, "new.example")
        val extensions = Files.createTempDirectory("nyora-catalogue-install-race")
        val server = NyoraRestServer(
            facade = NyoraFacade(repository, JvmExtensionRuntime()),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
            reseedDataDrivenSources = {
                repository.save(
                    repository.load().copy(
                        sources = DataDrivenCatalog.load().map { it.source.copy(isInstalled = false) },
                    ),
                )
            },
            persistDataDrivenCatalogue = {
                persistenceStarted.countDown()
                check(releasePersistence.await(5, TimeUnit.SECONDS)) {
                    "test did not release catalogue persistence"
                }
                error("disk full")
            },
            catalogueDownloader = { replacement },
        )
        val client = HttpClient.newHttpClient()
        var catalogueThread: Thread? = null
        var installThread: Thread? = null
        var installCompletedBeforeRollback = false
        try {
            val base = server.start()
            catalogueThread = thread(name = "failing-catalogue-request") {
                runCatching {
                    client.send(
                        HttpRequest.newBuilder(URI("$base/sources/catalogue"))
                            .header("Content-Type", "application/json")
                            .POST(
                                HttpRequest.BodyPublishers.ofString(
                                    "{\"url\":\"https://catalogue.example/new.json\"}",
                                ),
                            )
                            .build(),
                        HttpResponse.BodyHandlers.ofString(),
                    )
                }.onSuccess(catalogueResponse::set).onFailure(catalogueFailure::set)
            }
            assertTrue(
                persistenceStarted.await(5, TimeUnit.SECONDS),
                "catalogue persistence did not start",
            )

            installThread = thread(name = "overlapping-source-install") {
                runCatching {
                    client.send(
                        HttpRequest.newBuilder(URI("$base/sources/install?id=data%3A$sourceId"))
                            .POST(HttpRequest.BodyPublishers.noBody())
                            .build(),
                        HttpResponse.BodyHandlers.ofString(),
                    )
                }.onSuccess(installResponse::set).onFailure(installFailure::set)
                installFinished.countDown()
            }
            installCompletedBeforeRollback = installFinished.await(2, TimeUnit.SECONDS)
        } finally {
            releasePersistence.countDown()
            catalogueThread?.join(5_000)
            installThread?.join(5_000)
            server.stop()
            extensions.toFile().deleteRecursively()
        }

        assertFalse(
            installCompletedBeforeRollback,
            "source install escaped the catalogue transaction while rollback was still possible",
        )
        assertFalse(catalogueThread?.isAlive == true, "catalogue request did not finish")
        assertFalse(installThread?.isAlive == true, "source install request did not finish")
        assertEquals(null, catalogueFailure.get(), catalogueFailure.get()?.stackTraceToString())
        assertEquals(null, installFailure.get(), installFailure.get()?.stackTraceToString())
        assertEquals(500, catalogueResponse.get()?.statusCode(), catalogueResponse.get()?.body())
        assertEquals(200, installResponse.get()?.statusCode(), installResponse.get()?.body())
        assertTrue(repository.load().sources.single { it.id == "data:$sourceId" }.isInstalled)
        assertEquals("old.example", DataDrivenCatalog.load().single().definition.domain)
    }

    private fun get(client: HttpClient, url: String): String = client.send(
        HttpRequest.newBuilder(URI(url)).GET().build(),
        HttpResponse.BodyHandlers.ofString(),
    ).body()

    private fun awaitBody(client: HttpClient, url: String, condition: (String) -> Boolean): String {
        val deadline = System.nanoTime() + 5_000_000_000L
        do {
            val body = get(client, url)
            if (condition(body)) return body
            Thread.sleep(10)
        } while (System.nanoTime() < deadline)
        error("Timed out waiting for $url")
    }

    private fun catalogue(id: String, domain: String): String = """
        {"sources":[{"id":"$id","name":"$id","lang":"en","engine":"madara","domain":"$domain","config":{}}]}
    """.trimIndent()

    private fun pageService(source: MangaSource, searchFailure: String? = null): MangaExtensionService = object : MangaExtensionService {
        override val supportsLatest = true
        override val domain = source.baseUrl.removePrefix("https://")
        override suspend fun getPopular(page: Int) = MangaSearchPage(emptyList(), false)
        override suspend fun getLatest(page: Int) = MangaSearchPage(emptyList(), false)
        override suspend fun search(query: String, page: Int, filters: List<SourceFilter>): MangaSearchPage {
            if (searchFailure != null) throw java.io.IOException(searchFailure)
            return MangaSearchPage(emptyList(), false)
        }
        override suspend fun getDetails(url: String) = MangaDetails(
            manga = Manga(id = url, title = url, url = url),
            chapters = emptyList(),
        )
        override suspend fun getPageList(chapter: MangaChapter) =
            listOf(MangaPage(url = "/images/page.jpg"))
    }

    private class MemoryRepository(initial: Library) : LibraryRepository {
        @Volatile
        private var library = initial
        var pageCacheClearCount = 0

        override fun load(): Library = library
        override fun save(library: Library) { this.library = library }
        override fun upsertManga(manga: Manga) {
            save(library.copy(mangas = listOf(manga) + library.mangas.filterNot { it.id == manga.id }))
        }
        override fun upsertSource(source: MangaSource) {
            save(library.copy(sources = listOf(source) + library.sources.filterNot { it.id == source.id }))
        }
        override fun clearChapterPageCache() {
            pageCacheClearCount += 1
        }
    }
}
