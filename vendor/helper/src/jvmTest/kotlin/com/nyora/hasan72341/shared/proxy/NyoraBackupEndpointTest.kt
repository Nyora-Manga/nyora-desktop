package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.backup.NyoraBackupCodec
import com.nyora.hasan72341.shared.backup.NyoraBackupSnapshot
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.JvmExtensionRuntime
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.repository.LibraryRepository
import com.nyora.hasan72341.shared.repository.NyoraBackupRepository
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NyoraBackupEndpointTest {
    @Test
    fun `backup endpoints transport binary preview without mutation validate modes and omit resolvers`() {
        val initial = NyoraBackupSnapshot(
            archiveId = "11111111-1111-1111-1111-111111111111",
            createdAt = "2026-08-21T08:30:00.000Z",
            appVersion = "test",
            platform = "test",
        )
        val incoming = initial.copy(archiveId = "22222222-2222-2222-2222-222222222222")
        val backupRepository = MemoryBackupRepository(initial)
        val extensions = Files.createTempDirectory("nyora-backup-endpoint")
        val server = NyoraRestServer(
            facade = NyoraFacade(EmptyLibraryRepository(), JvmExtensionRuntime()),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
            backupRepository = backupRepository,
            backupAppVersion = "test",
            backupPlatform = "jvm-test",
        )
        val client = HttpClient.newHttpClient()
        try {
            val base = server.start()
            val exported = client.send(
                HttpRequest.newBuilder(URI("$base/backup/export")).GET().build(),
                HttpResponse.BodyHandlers.ofByteArray(),
            )
            assertEquals(200, exported.statusCode())
            assertEquals("application/vnd.nyora.backup", exported.headers().firstValue("Content-Type").orElse(""))
            assertTrue(exported.headers().firstValue("Content-Disposition").orElse("").endsWith(".nyorabk\""))
            NyoraBackupCodec.decode(exported.body())

            val invalidMode = post(client, "$base/backup/plan?mode=overwrite", NyoraBackupCodec.encode(incoming))
            assertEquals(400, invalidMode.statusCode())

            val preview = post(client, "$base/backup/plan?mode=merge", NyoraBackupCodec.encode(incoming))
            assertEquals(200, preview.statusCode())
            assertEquals(initial, backupRepository.state, "preview must not mutate")
            assertTrue(preview.body().contains("\"mode\":\"merge\""))

            val applied = post(client, "$base/backup/import?mode=replace", NyoraBackupCodec.encode(incoming))
            assertEquals(200, applied.statusCode())
            assertEquals(incoming.archiveId, backupRepository.state.archiveId)

            for (path in listOf("/backup/resolve", "/backup/resolve/status", "/backup/resolve/one", "/backup/resolve/stop")) {
                assertEquals(404, get(client, "$base$path").statusCode(), path)
            }
        } finally {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    private fun post(client: HttpClient, url: String, bytes: ByteArray) = client.send(
        HttpRequest.newBuilder(URI(url)).POST(HttpRequest.BodyPublishers.ofByteArray(bytes)).build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun get(client: HttpClient, url: String) = client.send(
        HttpRequest.newBuilder(URI(url)).GET().build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private class MemoryBackupRepository(initial: NyoraBackupSnapshot) : NyoraBackupRepository {
        var state = initial
        override fun readBackupSnapshot() = state
        override fun availableBackupSourceIds() = emptySet<String>()
        override fun replaceBackupSnapshot(snapshot: NyoraBackupSnapshot) { state = snapshot }
        override fun <T> inBackupTransaction(block: () -> T): T = block()
        override fun setBackupSyncPaused(paused: Boolean) = Unit
        override fun reconcileBackupRestore() = Unit
    }

    private class EmptyLibraryRepository : LibraryRepository {
        private var library = Library()
        override fun load() = library
        override fun save(library: Library) { this.library = library }
        override fun upsertManga(manga: Manga) { library = library.copy(mangas = library.mangas + manga) }
        override fun upsertSource(source: MangaSource) { library = library.copy(sources = library.sources + source) }
    }
}
