package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.HelperNetworkSettings
import com.nyora.hasan72341.shared.net.NYORA_BROWSER_UA
import com.nyora.hasan72341.shared.net.injectClearanceCookies
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import kotlin.test.Test
import kotlin.test.AfterTest
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DataDrivenRuntimeIntegrationTest {

    @Test
    fun beeHentaiRebrandUsesToonTopMetadataAndApiServiceWithoutChangingItsId() {
        val source = requireNotNull(DataDrivenCatalog.find("data:beehentai")).source
        assertEquals("ToonTop", source.name)
        assertEquals("https://toontop.io", source.baseUrl.trimEnd('/'))
        assertTrue(source.isNsfw)
        assertIs<ToonDexExtensionService>(JvmExtensionRuntime().create(source))
    }

    @AfterTest
    fun restoreBundledCatalogue() {
        val bundled = requireNotNull(javaClass.classLoader.getResourceAsStream("nyora/catalogue.json"))
            .bufferedReader().use { it.readText() }
        DataDrivenCatalog.replace(bundled)
    }

    @Test
    fun runtimeCreatesDataDrivenServiceForABundledSource() {
        val source = DataDrivenCatalog.load().first().source

        assertIs<DataDrivenExtensionService>(JvmExtensionRuntime().create(source))
    }

    @Test
    fun runtimeRoutesDataDrivenMangaFireToItsNativeService() {
        val source = requireNotNull(DataDrivenCatalog.find("data:mangafire_en")).source

        assertIs<MangaFireExtensionService>(JvmExtensionRuntime().create(source))
    }

    @Test
    fun runtimeRoutesDataDrivenToonilyToItsNativeService() {
        val source = requireNotNull(DataDrivenCatalog.find("data:toonily_me")).source

        assertIs<ToonDexExtensionService>(JvmExtensionRuntime().create(source))
    }

    @Test
    fun runtimeRoutesDataDrivenNatoSourcesToTheirNativeService() {
        val ids = listOf(
            "data:manganato",
            "data:manganelo",
            "data:mangakakalot",
            "data:mangakakalottv",
            "data:mangabat",
        )

        ids.forEach { id ->
            val source = requireNotNull(DataDrivenCatalog.find(id)).source
            assertIs<NatoExtensionService>(JvmExtensionRuntime().create(source), id)
        }
    }

    @Test
    fun runtimeUsesTheHelperNetworkStackForDataDrivenRequests() {
        val certificate = HeldCertificate.Builder()
            .addSubjectAlternativeName("localhost")
            .build()
        val serverCertificates = HandshakeCertificates.Builder()
            .heldCertificate(certificate)
            .build()
        MockWebServer().use { server ->
            server.useHttps(serverCertificates.sslSocketFactory())
            server.start()
            server.enqueue(
                MockResponse.Builder()
                    .body(
                        """
                        <div class="story_item">
                          <a href="/manga/network-test" title="Network Test">
                            <img src="/cover.jpg">
                          </a>
                        </div>
                        """.trimIndent(),
                    )
                    .build(),
            )
            val domain = "${server.url("/").host}:${server.port}"
            DataDrivenCatalog.replace(manga18Catalogue(domain))
            injectClearanceCookies(domain, "nyora_runtime_test=shared-session")
            try {
                val networkConfig = HelperNetworkConfig()
                val runtime = JvmExtensionRuntime(networkConfig = networkConfig)
                val source = requireNotNull(DataDrivenCatalog.find("data:test-source")).source
                val service = runtime.create(source)

                // The runtime caches services, while Settings can change after one is created.
                networkConfig.update(HelperNetworkSettings(sslBypass = true))

                val result = runBlocking { service.getPopular(page = 1) }

                assertEquals(listOf("Network Test"), result.entries.map { it.title })
                val request = server.takeRequest()
                assertEquals(NYORA_BROWSER_UA, request.headers["User-Agent"])
                assertTrue(request.headers["Cookie"].orEmpty().contains("nyora_runtime_test=shared-session"))
                assertEquals("navigate", request.headers["Sec-Fetch-Mode"])
            } finally {
                injectClearanceCookies(domain, "nyora_runtime_test=; Max-Age=0")
            }
        }
    }

    @Test
    fun runtimeRebuildsADataDrivenServiceAfterItsCatalogueEntryChanges() {
        DataDrivenCatalog.replace(catalogue(domain = "old.example", listUrl = "/old"))
        val runtime = JvmExtensionRuntime()
        val first = runtime.create(requireNotNull(DataDrivenCatalog.find("data:test-source")).source)

        DataDrivenCatalog.replace(catalogue(domain = "new.example", listUrl = "/new"))
        val second = runtime.create(requireNotNull(DataDrivenCatalog.find("data:test-source")).source)

        assertNotSame(first, second)
        assertEquals("new.example", second.domain)
    }

    @Test
    fun staleSourceObjectCannotPoisonTheCurrentCatalogueRevisionCache() {
        DataDrivenCatalog.replace(catalogue(domain = "old.example", listUrl = "/old"))
        val staleSource = requireNotNull(DataDrivenCatalog.find("data:test-source")).source
        DataDrivenCatalog.replace(catalogue(domain = "new.example", listUrl = "/new"))
        val currentSource = requireNotNull(DataDrivenCatalog.find("data:test-source")).source
        val runtime = JvmExtensionRuntime()

        val createdFromStaleObject = runtime.create(staleSource)
        val createdFromCurrentObject = runtime.create(currentSource)

        assertEquals("new.example", createdFromStaleObject.domain)
        assertSame(createdFromStaleObject, createdFromCurrentObject)
    }

    @Test
    fun replacementCannotOvertakeAnInFlightServiceCreationFromTheOldRevision() {
        DataDrivenCatalog.replace(catalogue(domain = "old.example", listUrl = "/old"))
        val oldFactoryStarted = CountDownLatch(1)
        val releaseOldFactory = CountDownLatch(1)
        val replacementStarted = CountDownLatch(1)
        val replacementFinished = CountDownLatch(1)
        val runtime = JvmExtensionRuntime(dataDrivenFactory = { source, entry ->
            if (entry.definition.domain == "old.example") {
                oldFactoryStarted.countDown()
                check(releaseOldFactory.await(5, TimeUnit.SECONDS))
            }
            DataDrivenExtensionService(source, entry)
        })
        val pool = Executors.newFixedThreadPool(2)
        try {
            val oldCreation = pool.submit {
                runtime.create(requireNotNull(DataDrivenCatalog.find("data:test-source")).source)
            }
            assertTrue(oldFactoryStarted.await(5, TimeUnit.SECONDS))
            val replacement = pool.submit {
                replacementStarted.countDown()
                DataDrivenCatalog.replace(catalogue(domain = "new.example", listUrl = "/new"))
                replacementFinished.countDown()
            }

            assertTrue(replacementStarted.await(5, TimeUnit.SECONDS))
            assertFalse(replacementFinished.await(100, TimeUnit.MILLISECONDS))
            releaseOldFactory.countDown()
            oldCreation.get(5, TimeUnit.SECONDS)
            replacement.get(5, TimeUnit.SECONDS)

            val current = runtime.create(requireNotNull(DataDrivenCatalog.find("data:test-source")).source)
            assertEquals("new.example", current.domain)
        } finally {
            releaseOldFactory.countDown()
            pool.shutdownNow()
        }
    }

    private fun catalogue(domain: String, listUrl: String): String = """
        {
          "sources": [{
            "id": "test-source",
            "name": "Test Source",
            "lang": "en",
            "engine": "madara",
            "domain": "$domain",
            "config": {"listUrl": "$listUrl"}
          }]
        }
    """.trimIndent()

    private fun manga18Catalogue(domain: String): String = """
        {
          "sources": [{
            "id": "test-source",
            "name": "Test Source",
            "lang": "en",
            "engine": "manga18",
            "domain": "$domain"
          }]
        }
    """.trimIndent()
}
