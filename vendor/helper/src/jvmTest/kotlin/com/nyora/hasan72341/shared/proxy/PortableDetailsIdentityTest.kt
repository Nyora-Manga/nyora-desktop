package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.backup.*
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.extension.JvmExtensionRuntime
import com.nyora.hasan72341.shared.net.DesktopSourceRelay
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.reader.PageImageLoader
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import com.nyora.hasan72341.shared.repository.SqlDelightNyoraBackupRepository
import java.net.URI
import java.net.URLEncoder
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

class PortableDetailsIdentityTest {
    @Test fun detailsIdentityDoesNotMatchOtherSourcesOrKeysAndLegacyModeKeepsParserIds() {
        val root = Files.createTempDirectory("nyora-portable-match-boundary")
        val beforeIsolated = System.getProperty("nyora.desktop.isolated")
        val beforeRoot = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.desktop.isolated", "true")
        System.setProperty("nyora.data.dir", root.toString())
        val repository = SqlDelightLibraryRepository(root.resolve("library.db"))
        try {
            val golden = requireNotNull(javaClass.classLoader.getResource("backup/v1/golden-minimal.nyorabk")).readBytes()
            NyoraBackupImporter(SqlDelightNyoraBackupRepository(repository)).apply(golden, NyoraRestoreMode.Replace)
            val retained = repository.load().mangas.single()
            val differentSource = retained.copy(id = "native-other-source", source = com.nyora.hasan72341.shared.model.MangaSourceRef.Script("data:other"))
            assertEquals(differentSource.id, repository.upsertMangaDetails(differentSource, "data:other", retained.url).id)
            val differentKey = retained.copy(id = "native-other-key", url = "/manga/other")
            assertEquals(differentKey.id, repository.upsertMangaDetails(differentKey, "data:mangadex", differentKey.url).id)
            val mismatchedResult = retained.copy(id = "native-mismatched-result", url = "https://elsewhere.example/manga/berserk")
            assertEquals(mismatchedResult.id, repository.upsertMangaDetails(mismatchedResult, "data:mangadex", retained.url).id)
            assertEquals(retained.id, repository.favourites().single().id)
            System.setProperty("nyora.desktop.isolated", "false")
            val legacy = retained.copy(id = "native-legacy-parser")
            assertEquals(legacy.id, repository.upsertMangaDetails(legacy, "data:mangadex", retained.url).id)
            assertEquals(5, repository.load().mangas.size)
        } finally {
            repository.driver.close()
            if (beforeIsolated == null) System.clearProperty("nyora.desktop.isolated") else System.setProperty("nyora.desktop.isolated", beforeIsolated)
            if (beforeRoot == null) System.clearProperty("nyora.data.dir") else System.setProperty("nyora.data.dir", beforeRoot)
            root.toFile().deleteRecursively()
        }
    }

    @Test fun importedMangaOpenedThroughActualRelayDetailsKeepsPortableForeignKeysAndResponseIds() {
        val root = Files.createTempDirectory("nyora-portable-details")
        val beforeCatalogue = DataDrivenCatalog.snapshot()
        val beforeIsolated = System.getProperty("nyora.desktop.isolated")
        val beforeRoot = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.desktop.isolated", "true")
        System.setProperty("nyora.data.dir", root.toString())
        val relay = MockWebServer()
        var repository: SqlDelightLibraryRepository? = null
        var server: NyoraRestServer? = null
        try {
            DataDrivenCatalog.replace("""{"sources":[{"id":"mangadex","engine":"madara","domain":"source.example","cfWall":"B","config":{"withoutAjax":true,"stylePage":""}}]}""")
            val entry = requireNotNull(DataDrivenCatalog.find("data:mangadex"))
            val golden = requireNotNull(javaClass.classLoader.getResource("backup/v1/golden-minimal.nyorabk")).readBytes()
            val incoming = NyoraBackupCodec.decode(golden)
            val manga = incoming.manga.single()
            val chapter = incoming.chapters.single()
            val database = SqlDelightLibraryRepository(root.resolve("library.db"))
            repository = database
            database.driver.execute(null, "PRAGMA foreign_keys = ON", 0)
            database.upsertSource(entry.source)
            val backup = SqlDelightNyoraBackupRepository(database)
            NyoraBackupImporter(backup).apply(golden, NyoraRestoreMode.Replace)
            relay.start()
            val relayToken = "relay-test-only-credential-0123456789abcdef"
            val network = HelperNetworkConfig(desktopRelay = DesktopSourceRelay("http://127.0.0.1:${relay.port}/fetch", relayToken))
            server = NyoraRestServer(
                facade = NyoraFacade(database, JvmExtensionRuntime(networkConfig = network)),
                catalog = SourceCatalogClient(), installer = ExtensionInstaller(root.resolve("extensions")),
                networkConfig = network, pageLoader = PageImageLoader(network), backupRepository = backup,
            )
            val base = server.start()
            val client = HttpClient.newHttpClient()
            fun request(path: String, post: Boolean = false, token: String? = System.getenv("NYORA_HELPER_TOKEN")): HttpResponse<String> {
                val builder = HttpRequest.newBuilder(URI(base + path))
                token?.let { builder.header("Authorization", "Bearer $it") }
                if (post) builder.POST(HttpRequest.BodyPublishers.noBody()) else builder.GET()
                return client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            }
            fun encoded(value: String) = URLEncoder.encode(value, Charsets.UTF_8)
            val detailsRoute = "/manga/details?id=${encoded(manga.sourceId)}&url=${encoded(manga.contentKey)}"
            assertEquals(401, request(detailsRoute, token = null).statusCode())
            assertEquals(401, request(detailsRoute, token = "wrong-credential").statusCode())
            assertEquals(0, relay.requestCount)
            val html = """<html><body><h1>Berserk</h1><div class="listing-chapters_wrap"><ul><li class="wp-manga-chapter"><a href="${chapter.chapterKey}">Chapter 1</a></li></ul></div></body></html>"""
            val body = Base64.getEncoder().encodeToString(html.toByteArray())
            relay.enqueue(MockResponse.Builder().body("""{"status":200,"headers":{"content-type":"text/html"},"bodyBase64":"$body"}""").build())
            val response = request(detailsRoute)
            assertEquals(200, response.statusCode(), response.body())
            val details = JSONObject(response.body())
            val returnedMangaId = details.getJSONObject("manga").getString("id")
            val returnedChapterId = details.getJSONArray("chapters").getJSONObject(0).getString("id")
            assertEquals(manga.id, returnedMangaId, "API must return committed portable manga ID")
            assertEquals(chapter.id, returnedChapterId, "API must return committed portable chapter ID")
            assertEquals(chapter.id, details.getJSONObject("manga").getJSONArray("chapters").getJSONObject(0).getString("id"))
            assertEquals(manga.id, database.load().mangas.single().id)
            assertEquals(chapter.id, database.load().mangas.single().chapters.single().id)
            assertEquals(manga.id, database.favourites().single().id)
            assertEquals(manga.id, database.history().single().manga.id)
            assertEquals(manga.id, database.bookmarks().single().mangaId)
            assertEquals(chapter.id, database.bookmarks().single().chapterId)
            val forwarded = requireNotNull(relay.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("Bearer $relayToken", forwarded.headers["Authorization"])
            assertEquals(manga.sourceId, JSONObject(forwarded.body!!.utf8()).getString("sourceId"))
            assertEquals(1, relay.requestCount)
            val identity = "mangaId=${encoded(returnedMangaId)}"
            assertTrue(JSONObject(request("/library/favourites/check?$identity").body()).getBoolean("favourited"))
            assertFalse(JSONObject(request("/library/favourites/toggle?$identity", post = true).body()).getBoolean("favourited"))
            assertTrue(JSONObject(request("/library/favourites/toggle?$identity", post = true).body()).getBoolean("favourited"))
            assertEquals(200, request("/library/history/record?$identity&sourceId=${encoded(manga.sourceId)}&chapterId=${encoded(returnedChapterId)}&page=13", post = true).statusCode())
            assertEquals(200, request("/library/bookmarks/add?$identity&chapterId=${encoded(returnedChapterId)}&page=99&note=attached", post = true).statusCode())
            assertEquals(13, database.history().single().page)
            assertTrue(database.bookmarks().all { it.mangaId == manga.id && it.chapterId == chapter.id })
            assertEquals(2, database.bookmarks().size)
            val exported = client.send(HttpRequest.newBuilder(URI("$base/backup/export"))
                .header("Authorization", "Bearer ${System.getenv("NYORA_HELPER_TOKEN")}").GET().build(), HttpResponse.BodyHandlers.ofByteArray())
            assertEquals(200, exported.statusCode())
            val portable = NyoraBackupCodec.decode(exported.body())
            assertEquals(manga.id, portable.manga.single().id)
            assertEquals(chapter.id, portable.chapters.single().id)
            assertEquals(manga.id, portable.library.single().mangaId)
            assertEquals(manga.id, portable.history.single().mangaId)
            assertEquals(chapter.id, portable.history.single().chapterId)
            assertTrue(portable.bookmarks.all { it.mangaId == manga.id && it.chapterId == chapter.id })
            assertEquals(incoming.tracking, portable.tracking)
            val repeated = NyoraBackupImporter(backup).plan(exported.body(), NyoraRestoreMode.Merge)
            assertTrue(repeated.sections.values.all { it.additions + it.updates + it.deletions == 0 }, repeated.sections.toString())
        } finally {
            server?.stop()
            repository?.driver?.close()
            relay.close()
            DataDrivenCatalog.restore(beforeCatalogue)
            ResponseCache.invalidatePrefix("catalog:")
            ResponseCache.invalidatePrefix("browse:")
            if (beforeIsolated == null) System.clearProperty("nyora.desktop.isolated") else System.setProperty("nyora.desktop.isolated", beforeIsolated)
            if (beforeRoot == null) System.clearProperty("nyora.data.dir") else System.setProperty("nyora.data.dir", beforeRoot)
            root.toFile().deleteRecursively()
        }
    }
}
