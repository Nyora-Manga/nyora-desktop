package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.extension.JvmExtensionRuntime
import com.nyora.hasan72341.shared.net.DesktopSourceRelay
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.reader.PageImageLoader
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.json.JSONObject
import kotlin.test.*

class NativeSourceFreshnessTest {
    @Test fun nativeVerificationRefreshBypassesFreshBrowseAndSearchCaches() {
        for (route in listOf("/sources/popular", "/sources/latest", "/sources/search")) {
            fixture { f ->
                f.enqueueListing()
                assertEquals(200, f.request(route).statusCode())
                assertEquals(1, f.relay.requestCount)
                // A normal read may reuse a genuinely fresh response.
                assertEquals(200, f.request(route).statusCode())
                assertEquals(1, f.relay.requestCount)
                f.enqueueChallenge()
                f.assertChallenge(f.request("$route&refresh=1"))
                assertEquals(2, f.relay.requestCount, "Verification must prove upstream access, not a cache hit")
            }
        }
    }

    @Test fun expiredNativeBrowseSurfacesChallengeSynchronouslyInsteadOfReturningStaleSuccess() {
        fixture { f ->
            f.enqueueListing()
            val warm = f.request("/sources/popular")
            assertEquals(200, warm.statusCode())
            ResponseCache.put(f.browseKey, warm.body(), -1)
            f.enqueueChallenge()
            f.assertChallenge(f.request("/sources/popular"))
            assertEquals(2, f.relay.requestCount)
        }
    }

    @Test fun hostedBrowseStillReturnsStaleCacheAndRevalidatesInBackground() {
        fixture(isolated = false) { f ->
            f.enqueueListing()
            val warm = f.request("/sources/popular")
            assertEquals(200, warm.statusCode())
            ResponseCache.put(f.browseKey, warm.body(), -1)
            f.enqueueChallenge()
            // The private desktop refresh flag must not change hosted behavior.
            assertEquals(200, f.request("/sources/popular&refresh=1").statusCode())
            assertNotNull(f.relay.takeRequest(2, TimeUnit.SECONDS))
            assertNotNull(f.relay.takeRequest(2, TimeUnit.SECONDS), "Hosted stale reads still revalidate")
        }
    }

    @Test fun cachedReaderPagesStillRequireFreshProofWhenRequested() {
        fixture { f ->
            f.enqueueHtml("""<div class="main-col-inner"><div class="reading-content"><div class="page-break"><img src="https://cdn.example/page.webp"></div></div></div>""")
            val route = "/manga/pages&url=%2Fmanga%2Ffixture%2Fchapter-1%2F"
            val warm = f.request(route)
            assertEquals(200, warm.statusCode(), warm.body())
            assertEquals(1, JSONObject(warm.body()).getJSONArray("pages").length())
            assertEquals(200, f.request(route).statusCode())
            assertEquals(1, f.relay.requestCount)
            f.enqueueChallenge()
            f.assertChallenge(f.request("$route&refresh=1"))
            assertEquals(2, f.relay.requestCount)
        }
    }

    private class Fixture(val relay: MockWebServer, val base: String) {
        val id = "data:freshnessfixture"
        val browseKey = "browse:${DataDrivenCatalog.snapshot().fingerprint}:POPULAR:$id:1:"
        private val client = HttpClient.newHttpClient()
        fun request(route: String): HttpResponse<String> {
            val path = route.substringBefore('&')
            val params = route.substringAfter('&', "")
            val builder = HttpRequest.newBuilder(URI("$base$path?id=$id&q=fixture" + if (params.isEmpty()) "" else "&$params"))
                .header("Authorization", "Bearer ${System.getenv("NYORA_HELPER_TOKEN")}").GET()
            return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
        }
        fun enqueueListing() = enqueueHtml("""<div class="page-item-detail"><a href="/manga/fixture/">Fixture</a><div class="post-title">Fixture</div></div>""")
        fun enqueueChallenge() = enqueueHtml("<html><title>Just a moment</title>challenge-platform</html>", challenge = true)
        fun enqueueHtml(html: String, challenge: Boolean = false) {
            val headers = JSONObject().put("content-type", "text/html")
            if (challenge) headers.put("cf-mitigated", "challenge")
            val body = JSONObject().put("status", 200).put("headers", headers)
                .put("bodyBase64", Base64.getEncoder().encodeToString(html.toByteArray()))
            relay.enqueue(MockResponse.Builder().body(body.toString()).build())
        }
        fun assertChallenge(response: HttpResponse<String>) {
            assertEquals(409, response.statusCode(), response.body())
            val error = JSONObject(response.body())
            assertEquals("verification_required", error.getString("code"))
            assertEquals(id, error.getString("sourceId"))
        }
    }

    private fun fixture(isolated: Boolean = true, test: (Fixture) -> Unit) {
        val root = Files.createTempDirectory("nyora-source-freshness")
        val beforeCatalogue = DataDrivenCatalog.snapshot()
        val beforeIsolated = System.getProperty("nyora.desktop.isolated")
        val beforeRoot = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.desktop.isolated", isolated.toString())
        System.setProperty("nyora.data.dir", root.toString())
        val relay = MockWebServer()
        var database: SqlDelightLibraryRepository? = null
        var server: NyoraRestServer? = null
        try {
            DataDrivenCatalog.replace("""{"sources":[{"id":"freshnessfixture","engine":"madara","domain":"source.example","config":{"withoutAjax":true,"stylePage":""}}]}""")
            val entry = requireNotNull(DataDrivenCatalog.find("data:freshnessfixture"))
            database = SqlDelightLibraryRepository(root.resolve("library.db"))
            database.upsertSource(entry.source)
            relay.start()
            val network = HelperNetworkConfig(desktopRelay = DesktopSourceRelay("http://127.0.0.1:${relay.port}/fetch", "relay-test-only-credential-0123456789abcdef"))
            server = NyoraRestServer(
                facade = NyoraFacade(database, JvmExtensionRuntime(networkConfig = network)),
                catalog = SourceCatalogClient(), installer = ExtensionInstaller(root.resolve("extensions")),
                networkConfig = network, pageLoader = PageImageLoader(network),
            )
            test(Fixture(relay, server.start()))
        } finally {
            server?.stop()
            database?.driver?.close()
            relay.close()
            ResponseCache.invalidatePrefix("browse:")
            ResponseCache.invalidatePrefix(ResponseCache.SEARCH_PREFIX)
            DataDrivenCatalog.restore(beforeCatalogue)
            if (beforeIsolated == null) System.clearProperty("nyora.desktop.isolated") else System.setProperty("nyora.desktop.isolated", beforeIsolated)
            if (beforeRoot == null) System.clearProperty("nyora.data.dir") else System.setProperty("nyora.data.dir", beforeRoot)
            root.toFile().deleteRecursively()
        }
    }
}
