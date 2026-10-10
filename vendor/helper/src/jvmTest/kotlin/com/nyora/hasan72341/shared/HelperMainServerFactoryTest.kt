package com.nyora.hasan72341.shared

import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HelperMainServerFactoryTest {

    @Test
    fun syncMutationsRejectAnUnauthenticatedDesktopSession() {
        val dataDirectory = Files.createTempDirectory("nyora-helper-unauthenticated-sync-test")
        val previousDataDirectory = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.data.dir", dataDirectory.toString())

        try {
            val boot = HelperMain.bootstrap()
            val server = HelperMain.createServer(boot)
            val client = HttpClient.newHttpClient()
            try {
                val base = server.start()
                val sync = post(client, "$base/nyorasync/sync")
                val restore = post(client, "$base/nyorasync/restore-from-cloud")

                assertEquals(401, sync.statusCode(), sync.body())
                assertEquals(401, restore.statusCode(), restore.body())
            } finally {
                server.stop()
            }
        } finally {
            if (previousDataDirectory == null) {
                System.clearProperty("nyora.data.dir")
            } else {
                System.setProperty("nyora.data.dir", previousDataDirectory)
            }
            dataDirectory.toFile().deleteRecursively()
        }
    }

    @Test
    fun legacyDesktopSyncReadsMatchTheCanonicalNyoraSyncContract() {
        val dataDirectory = Files.createTempDirectory("nyora-helper-sync-routes-test")
        val previousDataDirectory = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.data.dir", dataDirectory.toString())

        try {
            val boot = HelperMain.bootstrap()
            val server = HelperMain.createServer(boot)
            val client = HttpClient.newHttpClient()
            try {
                val base = server.start()
                val canonicalStatus = get(client, "$base/nyorasync/status")
                val legacyStatus = get(client, "$base/supabase/status")
                val canonicalLocalData = get(client, "$base/nyorasync/has-local-data")
                val legacyLocalData = get(client, "$base/supabase/has-local-data")

                assertEquals(200, canonicalStatus.statusCode(), canonicalStatus.body())
                assertEquals(200, legacyStatus.statusCode(), legacyStatus.body())
                assertEquals(canonicalStatus.body(), legacyStatus.body())
                assertEquals(200, canonicalLocalData.statusCode(), canonicalLocalData.body())
                assertEquals(200, legacyLocalData.statusCode(), legacyLocalData.body())
                assertEquals(canonicalLocalData.body(), legacyLocalData.body())
            } finally {
                server.stop()
            }
        } finally {
            if (previousDataDirectory == null) {
                System.clearProperty("nyora.data.dir")
            } else {
                System.setProperty("nyora.data.dir", previousDataDirectory)
            }
            dataDirectory.toFile().deleteRecursively()
        }
    }

    @Test
    fun createServerAppliesCatalogueAndReseedsTheLiveSourceRegistry() {
        val dataDirectory = Files.createTempDirectory("nyora-helper-factory-test")
        val previousDataDirectory = System.getProperty("nyora.data.dir")
        val previousCatalogue = DataDrivenCatalog.snapshot()
        System.setProperty("nyora.data.dir", dataDirectory.toString())

        try {
            val boot = HelperMain.bootstrap()
            val server = HelperMain.createServer(
                boot = boot,
                catalogueDownloader = { replacementCatalogue },
            )
            val client = HttpClient.newHttpClient()
            try {
                val response = client.send(
                    HttpRequest.newBuilder(URI("${server.start()}/sources/catalogue"))
                        .header("Content-Type", "application/json")
                        .POST(
                            HttpRequest.BodyPublishers.ofString(
                                "{\"url\":\"https://catalogue.example/factory.json\"}",
                            ),
                        )
                        .build(),
                    HttpResponse.BodyHandlers.ofString(),
                )

                assertEquals(200, response.statusCode())
                assertTrue(response.body().contains("factory-source"))
                assertEquals(
                    "https://factory.example",
                    boot.facade.listSources().single { it.id == "data:factory-source" }.baseUrl,
                )
            } finally {
                server.stop()
            }
        } finally {
            DataDrivenCatalog.restore(previousCatalogue)
            if (previousDataDirectory == null) {
                System.clearProperty("nyora.data.dir")
            } else {
                System.setProperty("nyora.data.dir", previousDataDirectory)
            }
            dataDirectory.toFile().deleteRecursively()
        }
    }

    private val replacementCatalogue = """
        {
          "sources": [{
            "id": "factory-source",
            "name": "Factory Source",
            "lang": "en",
            "engine": "madara",
            "domain": "factory.example",
            "config": {}
          }]
        }
    """.trimIndent()

    private fun get(client: HttpClient, url: String): HttpResponse<String> = client.send(
        HttpRequest.newBuilder(URI(url)).GET().build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    private fun post(client: HttpClient, url: String): HttpResponse<String> = client.send(
        HttpRequest.newBuilder(URI(url)).POST(HttpRequest.BodyPublishers.noBody()).build(),
        HttpResponse.BodyHandlers.ofString(),
    )
}
