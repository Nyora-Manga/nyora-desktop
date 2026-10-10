package com.nyora.hasan72341.shared

import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.JsonStore
import com.nyora.hasan72341.shared.download.DownloadManager
import com.nyora.hasan72341.shared.download.DownloadStatus
import com.nyora.hasan72341.shared.sync.NyoraSync
import com.nyora.hasan72341.shared.proxy.ResponseCacheStore
import com.nyora.hasan72341.shared.scrobbling.ScrobblerService
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import com.nyora.hasan72341.shared.scrobbling.PersistentScrobblerTokenStore
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.*

class IsolatedDesktopHelperTest {
    private val token = "isolated-test-token-0123456789abcdef"

    private fun isolated(block: (Path, Path) -> Unit) {
        val directory = Files.createTempDirectory("nyora-isolation-test")
        val profile = directory.resolve("profile")
        Files.createDirectories(profile)
        val properties = listOf("nyora.desktop.isolated", "nyora.data.dir", "user.home", "nyora.helper.port-file")
        val previous = properties.associateWith { System.getProperty(it) }
        System.setProperty("nyora.desktop.isolated", "true")
        System.setProperty("nyora.data.dir", profile.toString())
        System.setProperty("user.home", directory.resolve("old-home").toString())
        System.setProperty("nyora.helper.port-file", profile.resolve("run/helper.port").toString())
        try { block(profile, directory) } finally {
            previous.forEach { (key, value) -> if (value == null) System.clearProperty(key) else System.setProperty(key, value) }
            directory.toFile().deleteRecursively()
        }
    }

    @Test fun startupLeavesLegacyJsonAndCopiedCredentialsUntouched() = isolated { profile, directory ->
        val oldJson = directory.resolve("old-home/Library/Application Support/Nyora/library.json")
        Files.createDirectories(oldJson.parent)
        val sentinel = "{\"mangas\":[],\"sources\":[]}"
        Files.writeString(oldJson, sentinel)
        Files.writeString(profile.resolve("library.json"), sentinel)
        val credentials = "access_token=test-secret\nuser_id=sentinel\n"
        Files.writeString(profile.resolve("nyora-sync-tokens.properties"), credentials)
        val boot = HelperMain.bootstrap()
        try {
            assertEquals(sentinel, Files.readString(oldJson))
            assertFalse(Files.exists(oldJson.resolveSibling("library.json.migrated")))
            assertEquals(sentinel, Files.readString(profile.resolve("library.json")))
            assertFalse(Files.exists(profile.resolve("library.json.migrated")))
            assertNotNull(boot.repository.nyoraSync) // Explicit authenticated bridge only; no automatic account loading.
            assertFalse(com.nyora.hasan72341.shared.sync.NyoraSyncConfig.isAuthenticated)
            assertFalse(com.nyora.hasan72341.shared.sync.NyoraSyncConfig.isConfigured)
            assertEquals(credentials, Files.readString(profile.resolve("nyora-sync-tokens.properties")))
            assertTrue(SqlDelightLibraryRepository.defaultDatabasePath().startsWith(profile))
            assertTrue(JsonStore.defaultStorePath().startsWith(profile))
            assertTrue(DownloadManager.defaultDownloadsDir().startsWith(profile))
            assertTrue(PersistentScrobblerTokenStore.defaultFile().startsWith(profile))
        } finally { boot.repository.driver.close() }
    }

    @Test fun everyRouteRejectsMissingWrongAndDuplicateBearerCredentials() = isolated { _, _ ->
        val boot = HelperMain.bootstrap()
        val server = HelperMain.createServer(boot)
        try {
            val base = server.start()
            val client = HttpClient.newHttpClient()
            for (route in routes + listOf("/unknown-route", "/desktop/sync")) {
                for (credentials in listOf(emptyList(), listOf("Bearer wrong-token"), listOf("Bearer $token", "Bearer wrong-token"))) {
                    val builder = HttpRequest.newBuilder(URI(base + route)).GET()
                    credentials.forEach { builder.header("Authorization", it) }
                    val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
                    assertEquals(401, response.statusCode(), "$route credentials count ${credentials.size}")
                    assertFalse(response.body().contains(token))
                }
                val preflight = client.send(HttpRequest.newBuilder(URI(base + route)).method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString())
                assertEquals(401, preflight.statusCode(), "$route unauthenticated preflight")
            }
            val health = client.send(HttpRequest.newBuilder(URI("$base/health")).header("Authorization", "Bearer $token").build(), HttpResponse.BodyHandlers.ofString())
            assertEquals(200, health.statusCode())
            assertTrue(health.body().contains("\"isolated\":true"))
            for (route in listOf("/tracker/anilist/search?title=sentinel", "/nyorasync/signin", "/nyorasync/sync", "/nyorasync/signin/status")) {
                val blocked = client.send(HttpRequest.newBuilder(URI(base + route)).header("Authorization", "Bearer $token").POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString())
                assertEquals(503, blocked.statusCode(), route)
            }
        } finally { server.stop(); boot.repository.driver.close() }
    }

    @Test fun extensionDeletionCannotFollowCopiedAbsolutePathOrSymlink() = isolated { profile, directory ->
        val outside = directory.resolve("old-extension.bin")
        Files.writeString(outside, "keep")
        val installer = ExtensionInstaller()
        assertFailsWith<IllegalArgumentException> { installer.uninstall(MangaSource(id="test", name="Test", lang="en", baseUrl="https://example.com", localPath=outside.toString())) }
        assertEquals("keep", Files.readString(outside))
        val extensions = profile.resolve("extensions")
        Files.createDirectories(extensions)
        val link = extensions.resolve("linked")
        Files.createSymbolicLink(link, directory)
        assertFailsWith<IllegalArgumentException> { installer.uninstall(MangaSource(id="test", name="Test", lang="en", baseUrl="https://example.com", localPath=link.resolve("old-extension.bin").toString())) }
        assertEquals("keep", Files.readString(outside))
        val safe = extensions.resolve("safe.bin")
        Files.writeString(safe, "delete")
        installer.uninstall(MangaSource(id="test", name="Test", lang="en", baseUrl="https://example.com", localPath=safe.toString()))
        assertFalse(Files.exists(safe))
    }

    @Test fun isolatedModeRejectsMissingOrRelativeProfileBeforeOpeningStorage() = isolated { _, _ ->
        System.clearProperty("nyora.data.dir")
        assertFailsWith<IllegalArgumentException> { SqlDelightLibraryRepository.defaultDatabasePath() }
        System.setProperty("nyora.data.dir", "relative-profile")
        assertFailsWith<IllegalArgumentException> { SqlDelightLibraryRepository.defaultDatabasePath() }
    }

    @Test fun explicitStorageOverridesCannotEscapeProfile() = isolated { _, directory ->
        val outside = directory.resolve("outside")
        Files.createDirectories(outside)
        assertFailsWith<IllegalArgumentException> { JsonStore(outside.resolve("library.json")) }
        assertFailsWith<IllegalArgumentException> { SqlDelightLibraryRepository(outside.resolve("nyora.db")) }
        val boot = HelperMain.bootstrap()
        try {
            assertFailsWith<IllegalArgumentException> { DownloadManager(boot.facade, rootDir=outside) }
            assertFailsWith<IllegalArgumentException> { ExtensionInstaller(extensionsDir=outside) }
            assertFailsWith<IllegalArgumentException> { NyoraSync(boot.repository, outside) }
            assertFailsWith<IllegalArgumentException> { PersistentScrobblerTokenStore(ScrobblerService.ANILIST, outside.resolve("tokens.properties")) }
        } finally { boot.repository.driver.close() }
        assertFalse(Files.exists(outside.resolve("nyora.db")))
    }

    @Test fun copiedSqliteSidecarSymlinksCannotWriteOutsideProfile() = isolated { profile, directory ->
        val outside = directory.resolve("do-not-write")
        Files.writeString(outside, "sentinel")
        Files.createSymbolicLink(profile.resolve("nyora.db-journal"), outside)
        assertFailsWith<IllegalArgumentException> { SqlDelightLibraryRepository() }
        assertEquals("sentinel", Files.readString(outside))
    }

    @Test fun nativeHelperRetainsUnauthenticatedHealthAndDefaultJsonDiscovery() = isolated { _, directory ->
        System.setProperty("nyora.desktop.isolated", "false")
        val oldJson = directory.resolve("old-home/Library/Application Support/Nyora/library.json")
        Files.createDirectories(oldJson.parent)
        Files.writeString(oldJson, "{\"mangas\":[],\"sources\":[]}")
        val boot = HelperMain.bootstrap()
        val server = HelperMain.createServer(boot)
        try {
            assertFalse(Files.exists(oldJson))
            assertTrue(Files.exists(oldJson.resolveSibling("library.json.migrated")))
            val health = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI(server.start() + "/health")).build(), HttpResponse.BodyHandlers.ofString())
            assertEquals(200, health.statusCode())
            assertEquals("{\"status\":\"ok\"}", health.body())
        } finally { server.stop(); boot.repository.driver.close() }
    }

    @Test fun downloadedArchiveCannotTruncateExternalFileThroughPartSymlink() = isolated { profile, directory ->
        val boot = HelperMain.bootstrap()
        val outside = directory.resolve("keep.cbz")
        Files.writeString(outside, "sentinel")
        val target = profile.resolve("downloads/data_fixture/Manga")
        Files.createDirectories(target)
        Files.createSymbolicLink(target.resolve("Chapter.cbz.part"), outside)
        boot.facade.cachePages("data:fixture", "fixture-chapter", "fixture-manga", emptyList())
        try {
            val entry = boot.downloads.start("data:fixture", "fixture-manga", "fixture-chapter", "Manga", "Chapter")
            val deadline = System.nanoTime() + 5_000_000_000L
            while (System.nanoTime() < deadline && boot.downloads.get(entry.id)?.finishedAt == null) Thread.sleep(10)
            assertEquals(DownloadStatus.FAILED, boot.downloads.get(entry.id)?.status)
            assertEquals("sentinel", Files.readString(outside))
            assertFalse(Files.exists(target.resolve("Chapter.cbz")))
        } finally { boot.repository.driver.close() }
    }

    @Test fun downloadedNamesCannotTraverseAboveTheApprovedProfile() = isolated { _, directory ->
        val boot = HelperMain.bootstrap()
        boot.facade.cachePages("..", "fixture-chapter", "fixture-manga", emptyList())
        try {
            val entry = boot.downloads.start("..", "fixture-manga", "fixture-chapter", "..", "escape")
            val deadline = System.nanoTime() + 5_000_000_000L
            while (System.nanoTime() < deadline && boot.downloads.get(entry.id)?.finishedAt == null) Thread.sleep(10)
            assertEquals(DownloadStatus.FAILED, boot.downloads.get(entry.id)?.status)
            assertFalse(Files.exists(directory.resolve("escape.cbz")))
            assertFalse(Files.exists(directory.resolve("escape.cbz.part")))
        } finally { boot.repository.driver.close() }
    }

    @Test fun cacheStorageOverrideCannotEscapeProfile() = isolated { _, directory ->
        assertFailsWith<IllegalArgumentException> {
            ResponseCacheStore(directory.resolve("outside-cache.snap").toFile())
        }
    }

    private val routes = listOf(
        "/health",
        "/docs",
        "/openapi.yaml",
        "/sources/refresh",
        "/sources/catalogue",
        "/sources/catalog",
        "/sources/install",
        "/sources/uninstall",
        "/sources/pin",
        "/sources/setInstalled",
        "/sources/filters",
        "/sources/popular",
        "/sources/latest",
        "/sources/search",
        "/cloudflare/clearance",
        "/sources",
        "/sources/domain",
        "/manga/details",
        "/manga/pages",
        "/image",
        "/library/history/record",
        "/library/history/remove",
        "/library/history/clear",
        "/library/history",
        "/library/clear",
        "/library/favourites/toggle",
        "/library/favourites/check",
        "/library/favourites",
        "/library/bookmarks/add",
        "/library/bookmarks/remove",
        "/library/bookmarks/check",
        "/library/bookmarks",
        "/library/updates/refresh",
        "/library/updates/seen",
        "/library/updates",
        "/local/scan",
        "/local/chapter",
        "/local/image",
        "/search/global",
        "/library/categories/create",
        "/library/categories/rename",
        "/library/categories/delete",
        "/library/categories/add",
        "/library/categories/remove",
        "/library/categories/manga",
        "/library/categories",
        "/manga/prefs/save",
        "/manga/prefs/clear",
        "/manga/prefs",
        "/downloads/start",
        "/downloads/enqueue",
        "/downloads/cancel",
        "/downloads/clear",
        "/downloads/settings",
        "/settings/network",
        "/downloads",
        "/stats",
        "/suggestions",
        "/manga/alternatives",
        "/backup/export",
        "/backup/plan",
        "/backup/import",
        "/tracker/anilist/search",
        "/tracker/anilist/scrobble",
        "/tracker/myanimelist/search",
        "/tracker/myanimelist/scrobble",
        "/tracker/kitsu/search",
        "/tracker/kitsu/scrobble",
        "/tracker/shikimori/search",
        "/tracker/shikimori/scrobble",
        "/tracker/bangumi/search",
        "/tracker/bangumi/scrobble",
        "/tracker/mangabaka/search",
        "/tracker/mangabaka/scrobble",
        "/tracker/anilist/state",
        "/tracker/myanimelist/state",
        "/tracker/kitsu/state",
        "/tracker/shikimori/state",
        "/tracker/bangumi/state",
        "/tracker/mangabaka/state",
        "/tracker/anilist/authorize",
        "/tracker/anilist/callback",
        "/tracker/myanimelist/authorize",
        "/tracker/myanimelist/callback",
        "/tracker/shikimori/authorize",
        "/tracker/shikimori/callback",
        "/tracker/bangumi/authorize",
        "/tracker/bangumi/callback",
        "/tracker/mangabaka/authorize",
        "/tracker/mangabaka/callback",
        "/tracker/kitsu/login",
        "/nyorasync/status",
        "/nyorasync/signin",
        "/nyorasync/register",
        "/nyorasync/signout",
        "/nyorasync/sync",
        "/nyorasync/restore-from-cloud",
        "/nyorasync/has-local-data",
        "/supabase/status",
        "/supabase/signin",
        "/supabase/register",
        "/supabase/signout",
        "/supabase/sync",
        "/supabase/restore-from-cloud",
        "/supabase/has-local-data",
        "/ota/check",
        "/ota/status",
        "/",
    )
}
