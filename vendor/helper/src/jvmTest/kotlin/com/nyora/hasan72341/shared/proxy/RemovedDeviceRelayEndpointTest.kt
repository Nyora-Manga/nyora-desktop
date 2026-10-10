package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.extension.JvmExtensionRuntime
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.repository.LibraryRepository
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.time.Duration
import kotlin.test.Test
import kotlin.test.assertEquals

class RemovedDeviceRelayEndpointTest {

    @Test
    fun legacyRemoteExecutionRelayIsNotExposed() {
        val extensions = Files.createTempDirectory("nyora-removed-relay-test")
        val server = NyoraRestServer(
            facade = NyoraFacade(EmptyRepository(), JvmExtensionRuntime()),
            catalog = SourceCatalogClient(),
            installer = ExtensionInstaller(extensions),
        )
        val client = HttpClient.newHttpClient()
        try {
            val base = server.start()
            val poll = client.send(
                HttpRequest.newBuilder(URI("$base/device/relay/poll"))
                    .timeout(Duration.ofSeconds(2))
                    .GET()
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
            val result = client.send(
                HttpRequest.newBuilder(URI("$base/device/relay/result"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{}"))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )

            assertEquals(404, poll.statusCode())
            assertEquals(404, result.statusCode())
        } finally {
            server.stop()
            extensions.toFile().deleteRecursively()
        }
    }

    private class EmptyRepository : LibraryRepository {
        private var library = Library()
        override fun load(): Library = library
        override fun save(library: Library) { this.library = library }
        override fun upsertManga(manga: Manga) {
            library = library.copy(mangas = listOf(manga) + library.mangas.filterNot { it.id == manga.id })
        }
        override fun upsertSource(source: MangaSource) {
            library = library.copy(sources = listOf(source) + library.sources.filterNot { it.id == source.id })
        }
    }
}
