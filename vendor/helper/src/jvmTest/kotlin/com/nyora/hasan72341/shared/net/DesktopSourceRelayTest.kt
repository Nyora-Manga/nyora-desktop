package com.nyora.hasan72341.shared.net

import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import kotlin.test.*

class DesktopSourceRelayTest {
    private val token = "relay-test-only-credential-0123456789abcdef"

    @Test fun onlyIsolatedModeReadsAndValidatesRelayEnvironment() {
        assertNull(DesktopSourceRelay.fromEnvironment(false, mapOf("NYORA_DESKTOP_RELAY_URL" to "invalid")))
        assertNull(DesktopSourceRelay.fromEnvironment(true, emptyMap()))
        for (url in listOf("https://127.0.0.1:23456/fetch", "http://localhost:23456/fetch", "http://127.0.0.2:23456/fetch", "http://127.0.0.1:23456/other", "http://user@127.0.0.1:23456/fetch", "http://127.0.0.1:23456/fetch?token=x", "http://127.0.0.1:23456/fetch#x", "http://127.0.0.1/fetch")) {
            assertFailsWith<IllegalArgumentException> { DesktopSourceRelay(url, token) }
        }
        assertFailsWith<IllegalArgumentException> { DesktopSourceRelay("http://127.0.0.1:23456/fetch", "short") }
        assertFailsWith<IllegalArgumentException> { DesktopSourceRelay.fromEnvironment(true, mapOf("NYORA_DESKTOP_RELAY_TOKEN" to token)) }
    }

    @Test fun sourceIdentityAndSafeHeadersReachOnlyAuthenticatedRelay() = MockWebServer().use { server ->
        server.start()
        val relay = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token)
        val fallback = OkHttpClient.Builder().addInterceptor { throw AssertionError("JVM fallback") }.build()
        for (source in listOf("data:one", "data:two")) {
            server.enqueue(reply("valid content", headers=mapOf("content-type" to "text/html", "set-cookie" to "do-not-import=secret")))
            relay.sourceClient(fallback, source).newCall(Request.Builder().url("https://source.example/list")
                .header("Cookie", "host-global=secret").header("Authorization", "Bearer provider-secret")
                .header("X-Nyora-Source", "spoofed").header("User-Agent", "old-jvm").header("Accept", "text/html")
                .header("Referer", "https://source.example/").build()).execute().use { response ->
                    assertEquals("valid content", response.body?.string())
                    assertNull(response.header("Set-Cookie"))
                }
            val recorded = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("Bearer $token", recorded.headers["Authorization"])
            assertEquals("/fetch", recorded.url.encodedPath)
            val payload = Json.parseToJsonElement(recorded.body!!.utf8()).jsonObject
            assertEquals(source, payload["sourceId"]?.jsonPrimitive?.content)
            assertEquals("https://source.example/list", payload["url"]?.jsonPrimitive?.content)
            val headers = payload.getValue("headers").jsonObject
            assertEquals("text/html", headers["Accept"]?.jsonPrimitive?.content)
            assertTrue(headers.keys.none { it.lowercase() in setOf("cookie", "authorization", "host", "user-agent", "x-nyora-source") })
        }
    }

    @Test fun privateUrlsUnknownSourcesAndMutationMethodsFailBeforeRelay() = MockWebServer().use { server ->
        server.start()
        val relay = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token)
        val client = relay.sourceClient(OkHttpClient(), "data:fixture")
        for (url in listOf("http://source.example/list", "https://127.0.0.1/list", "https://10.0.0.1/list", "https://[::1]/list", "https://localhost/list", "https://source.local/list", "https://user:secret@source.example/list")) {
            assertFailsWith<IOException> { client.newCall(Request.Builder().url(url).build()).execute() }
        }
        assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/list?password=secret").build()).execute() }
        assertFailsWith<IllegalArgumentException> { relay.sourceClient(OkHttpClient(), "parser:fixture") }
        assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/account/login").build()).execute() }
        assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/list").delete().build()).execute() }
        assertEquals(0, server.requestCount)
    }

    @Test fun knownReadOnlyMadaraPostPreservesBodyButAccountPostIsRejected() = MockWebServer().use { server ->
        val before = DataDrivenCatalog.snapshot()
        try {
            DataDrivenCatalog.replace("""{"sources":[{"id":"fixture","engine":"madara","domain":"source.example"}]}""")
            server.start()
            val client = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token).sourceClient(OkHttpClient(), "data:fixture")
            server.enqueue(reply("chapters"))
            val body = "action=madara_load_more&page=1"
            client.newCall(Request.Builder().url("https://source.example/wp-admin/admin-ajax.php")
                .post(body.toRequestBody("application/x-www-form-urlencoded".toMediaType())).build()).execute().close()
            val payload = Json.parseToJsonElement(requireNotNull(server.takeRequest()).body!!.utf8()).jsonObject
            assertEquals(body, String(Base64.getDecoder().decode(payload.getValue("bodyBase64").jsonPrimitive.content)))
            assertEquals("POST", payload.getValue("method").jsonPrimitive.content)
            assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/wp-admin/admin-ajax.php")
                .post("action=madara_load_more&password=secret".toRequestBody("application/x-www-form-urlencoded".toMediaType())).build()).execute() }
            assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/graphql")
                .post("{\"query\":\"mutation { login }\"}".toRequestBody("application/json".toMediaType())).build()).execute() }
            assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/wp-admin/admin-ajax.php?token=secret")
                .post(body.toRequestBody("application/x-www-form-urlencoded".toMediaType())).build()).execute() }
            assertEquals(1, server.requestCount)
        } finally { DataDrivenCatalog.restore(before) }
    }

    @Test fun successfulStatusChallengeHtmlNeverBecomesSuccessfulContent() = MockWebServer().use { server ->
        server.start()
        val client = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token).sourceClient(OkHttpClient(), "data:fixture")
        for (response in listOf(reply("<html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/test'></script></html>"), reply("challenge", headers=mapOf("cf-mitigated" to "challenge")))) {
            server.enqueue(response)
            val failure = assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/list?private=value").build()).execute() }
            assertTrue(failure.message.orEmpty().contains("verification_required sourceId=data:fixture"))
            assertFalse(failure.message.orEmpty().contains("private=value"))
        }
    }

    @Test fun relayFailuresNeverProceedToJvmOrAcceptMalformedResponses() = MockWebServer().use { server ->
        server.start()
        val fallback = OkHttpClient.Builder().addInterceptor { throw AssertionError("JVM fallback") }.build()
        val client = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token).sourceClient(fallback, "data:fixture")
        for (response in listOf(MockResponse.Builder().code(401).body("denied").build(), MockResponse.Builder().body("{}").build(), MockResponse.Builder().body("{\"status\":200,\"headers\":{},\"bodyBase64\":\"invalid%%\"}").build())) {
            server.enqueue(response)
            assertFailsWith<IOException> { client.newCall(Request.Builder().url("https://source.example/list").build()).execute() }
        }
    }

    @Test fun swallowedEngineFailureAcrossCoroutineDispatcherStillRequiresVerification() = MockWebServer().use { server ->
        server.start()
        val relay = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token)
        val client = relay.sourceClient(OkHttpClient(), "data:fixture")
        server.enqueue(reply("<html><title>Just a moment</title>challenge-platform</html>"))
        val failure = assertFailsWith<IOException> {
            kotlinx.coroutines.runBlocking {
                relay.sourceOperation {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        runCatching { client.newCall(Request.Builder().url("https://source.example/list").build()).execute() }.getOrNull()
                    }
                    "false success from optional metadata"
                }
            }
        }
        assertTrue(failure.message.orEmpty().contains("verification_required sourceId=data:fixture"))
    }

    @Test fun imageLoaderRequiresExplicitSourceAndNatoCannotSuppressVerification() = MockWebServer().use { server ->
        server.start()
        val network = HelperNetworkConfig(desktopRelay = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token))
        val loader = com.nyora.hasan72341.shared.reader.PageImageLoader(network)
        assertFailsWith<IOException> { loader.loadBytes("https://source.example/image.jpg") }
        assertEquals(0, server.requestCount)
        server.enqueue(reply("<html><title>Just a moment</title>challenge-platform</html>"))
        val source = com.nyora.hasan72341.shared.model.MangaSource(
            id = "data:mangakakalot", name = "fixture", lang = "en", baseUrl = "https://source.example", isInstalled = true,
            engine = com.nyora.hasan72341.shared.model.SourceEngine.JavaScript,
        )
        val service = com.nyora.hasan72341.shared.extension.NatoExtensionService(source, network)
        val failure = assertFailsWith<IOException> { kotlinx.coroutines.runBlocking { service.getDetails("/manga/fixture") } }
        assertTrue(failure.message.orEmpty().contains("verification_required sourceId=data:mangakakalot"))
        assertEquals(1, server.requestCount)
    }

    @Test fun downloadVerificationStopsWithoutPublishingAnEmptyArchive() = MockWebServer().use { server ->
        server.start()
        val root = java.nio.file.Files.createTempDirectory("nyora-relay-download-test")
        try {
            val network = HelperNetworkConfig(desktopRelay = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token))
            val repository = object : com.nyora.hasan72341.shared.repository.LibraryRepository {
                override fun load() = com.nyora.hasan72341.shared.model.Library()
                override fun save(library: com.nyora.hasan72341.shared.model.Library) = Unit
                override fun upsertManga(manga: com.nyora.hasan72341.shared.model.Manga) = Unit
                override fun upsertSource(source: com.nyora.hasan72341.shared.model.MangaSource) = Unit
                override fun cachedPages(chapterUrl: String) = listOf(com.nyora.hasan72341.shared.model.MangaPage(url = "https://source.example/image.jpg"))
            }
            val runtime = com.nyora.hasan72341.shared.extension.CommonMangaExtensionRuntime(jsFactory = { throw AssertionError("Source metadata fallback") })
            val manager = com.nyora.hasan72341.shared.download.DownloadManager(
                com.nyora.hasan72341.shared.NyoraFacade(repository, runtime),
                com.nyora.hasan72341.shared.reader.PageImageLoader(network), root,
            )
            server.enqueue(reply("<html><title>Just a moment</title>challenge-platform</html>"))
            val download = manager.start("data:fixture", "/manga/1", "/chapter/1", "Fixture", "Chapter")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (manager.get(download.id)?.status !in setOf(com.nyora.hasan72341.shared.download.DownloadStatus.FAILED, com.nyora.hasan72341.shared.download.DownloadStatus.COMPLETED) && System.nanoTime() < deadline) Thread.sleep(10)
            val result = requireNotNull(manager.get(download.id))
            assertEquals(com.nyora.hasan72341.shared.download.DownloadStatus.FAILED, result.status)
            assertTrue(result.error.orEmpty().contains("verification_required sourceId=data:fixture"))
            java.nio.file.Files.walk(root).use { files -> assertFalse(files.anyMatch { it.fileName.toString().endsWith(".cbz") }) }
            val request = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("data:fixture", Json.parseToJsonElement(request.body!!.utf8()).jsonObject.getValue("sourceId").jsonPrimitive.content)
        } finally { root.toFile().deleteRecursively() }
    }

    @Test fun actualDataEngineClientTagsChallengeOnlySourceBeforeNetworkInterceptors() = MockWebServer().use { server ->
        val before = DataDrivenCatalog.snapshot()
        try {
            DataDrivenCatalog.replace("""{"sources":[{"id":"fixture","engine":"madara","domain":"source.example","cfWall":"B","config":{"withoutAjax":true}}]}""")
            val entry = requireNotNull(DataDrivenCatalog.find("data:fixture"))
            server.start()
            val network = HelperNetworkConfig(desktopRelay = DesktopSourceRelay("http://127.0.0.1:${server.port}/fetch", token))
            val service = com.nyora.hasan72341.shared.extension.DataDrivenExtensionService(entry.source, entry, network)
            server.enqueue(reply("<html><title>Just a moment</title>challenge-platform</html>"))
            assertFailsWith<IOException> { kotlinx.coroutines.runBlocking { service.getPopular(1) } }
            val request = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("Bearer $token", request.headers["Authorization"])
            val payload = Json.parseToJsonElement(request.body!!.utf8()).jsonObject
            assertEquals("data:fixture", payload.getValue("sourceId").jsonPrimitive.content)
            assertEquals("GET", payload.getValue("method").jsonPrimitive.content)
            assertTrue(payload.getValue("url").jsonPrimitive.content.startsWith("https://source.example/"))
            assertEquals(1, server.requestCount)
        } finally { DataDrivenCatalog.restore(before) }
    }

    private fun reply(body: String, status: Int = 200, headers: Map<String,String> = mapOf("content-type" to "text/html")) = MockResponse.Builder().body(buildJsonObject {
        put("status", status)
        put("bodyBase64", Base64.getEncoder().encodeToString(body.toByteArray()))
        putJsonObject("headers") { headers.forEach { (key,value) -> put(key,value) } }
    }.toString()).build()
}
