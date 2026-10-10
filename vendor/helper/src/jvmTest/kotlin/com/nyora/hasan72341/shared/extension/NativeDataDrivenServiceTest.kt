package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.HelperNetworkSettings
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals

class NativeDataDrivenServiceTest {

    @Test
    fun nativeBrowseAndDetailsUseTheLegacyStableMangaIdentity() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val client = OkHttpClient()
            val baseUrl = server.url("/").toString().trimEnd('/')

            server.enqueue(
                MockResponse.Builder()
                    .body("""{"items":[{"hid":"fire-1","slug":"fire-title","title":"Fire Title"}],"meta":{"hasNext":false}}""")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .body("""{"data":{"hid":"fire-1","slug":"fire-title","title":"Fire Title"}}""")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .body("""{"items":[],"meta":{"lastPage":1}}""")
                    .build(),
            )
            val fire = MangaFireExtensionService(
                dataSource("data:mangafire_en", "mangafire.to"),
                HelperNetworkConfig(),
                clientFactory = { client },
                baseUrlOverride = baseUrl,
            )
            val fireBrowse = fire.getPopular(1).entries.single()
            val fireDetails = fire.getDetails(fireBrowse.url).manga

            assertEquals("6906297880919939313", fireBrowse.id)
            assertEquals(fireBrowse.id, fireDetails.id)

            server.enqueue(
                MockResponse.Builder()
                    .body("""{"data":{"items":[{"id":"toon-1","url":"/toon-title","name":"Toon Title"}],"pagination":{"has_next":false}}}""")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .body("""{"data":{"title":{"id":"toon-1","url":"/toon-title","name":"Toon Title"}}}""")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .body("""{"data":{"chapters":[],"pagination":{"has_next":false}}}""")
                    .build(),
            )
            val toon = ToonDexExtensionService(
                dataSource("data:toonily_me", "toontop.io"),
                HelperNetworkConfig(),
                clientFactory = { client },
                apiUrlOverride = baseUrl,
                siteUrlOverride = baseUrl,
            )
            val toonBrowse = toon.getPopular(1).entries.single()
            val toonDetails = toon.getDetails(toonBrowse.url).manga

            assertEquals("3628026392916723550", toonBrowse.id)
            assertEquals(toonBrowse.id, toonDetails.id)
        }

        val natoCases = linkedMapOf(
            "data:manganato" to "-88357243894273658",
            "data:manganelo" to "-4928346791005383400",
            "data:mangakakalot" to "-3741407860380787571",
            "data:mangakakalottv" to "-7363512028750130229",
        )
        for ((sourceId, expectedId) in natoCases) {
            MockWebServer().use { server ->
                server.start()
                val client = OkHttpClient()
                val baseUrl = server.url("/").toString().trimEnd('/')
                server.enqueue(
                    MockResponse.Builder().body(
                        """
                        <div class="list-comic-item-wrap">
                          <a class="list-story-item" href="$baseUrl/manga/nato-title" title="Nato Title">
                            <img src="$baseUrl/nato.jpg">
                          </a>
                        </div>
                        """.trimIndent(),
                    ).build(),
                )
                server.enqueue(
                    MockResponse.Builder()
                        .body("""{"data":{"chapters":[],"pagination":{"total":0,"has_more":false}}}""")
                        .build(),
                )
                server.enqueue(
                    MockResponse.Builder()
                        .body("""<html><head><meta property="og:title" content="Nato Title"></head><body><h1>Nato Title</h1></body></html>""")
                        .build(),
                )
                val nato = NatoExtensionService(
                    dataSource(sourceId, "natomanga.com"),
                    HelperNetworkConfig(),
                    clientFactory = { client },
                    baseUrlOverride = baseUrl,
                )
                val browsed = nato.getPopular(1).entries.single()
                val detailed = nato.getDetails(browsed.url).manga

                assertEquals(expectedId, browsed.id, sourceId)
                assertEquals(browsed.id, detailed.id, sourceId)
            }
        }
    }

    @Test
    fun nativeDataRoutesExposeTheirEffectiveDomainForCloudflareSetup() {
        val network = HelperNetworkConfig()

        assertEquals(
            "mangafire.to",
            MangaFireExtensionService(dataSource("data:mangafire_en", "mangafire.to"), network).domain,
        )
        assertEquals(
            "toontop.io",
            ToonDexExtensionService(dataSource("data:toonily_me", "toondex.io"), network).domain,
        )
        assertEquals(
            "https://toontop.io/",
            ToonDexExtensionService(dataSource("data:toonily_me", "toondex.io"), network)
                .getHeaders()["Referer"],
        )
        assertEquals(
            "natomanga.com",
            NatoExtensionService(dataSource("data:manganato", "natomanga.com"), network).domain,
        )
    }

    @Test
    fun everyBundledMangaFireDataIdUsesItsCanonicalLanguage() {
        val expected = linkedMapOf(
            "MANGAFIRE_EN" to "en",
            "MANGAFIRE_ES" to "es",
            "MANGAFIRE_ES_LA" to "es-la",
            "MANGAFIRE_FR" to "fr",
            "MANGAFIRE_JA" to "ja",
            "MANGAFIRE_PT_BR" to "pt-br",
        )

        assertEquals(expected, expected.keys.associateWith(::mangaFireLanguageCode))
        assertEquals("es-la", mangaFireLanguageCode("MANGAFIRE_ESLA"))
        assertEquals("pt-br", mangaFireLanguageCode("MANGAFIRE_PTBR"))
    }

    @Test
    fun renamedMangaFireCatalogueIdsKeepTheirHistoricalParserGoldenIds() {
        val mangaUrl = "/title/fire-1-fire-title"

        assertEquals(
            "-6279792482613327253",
            legacyMangaId(legacyParserSourceName("data:mangafire_es_la"), mangaUrl).toString(),
        )
        assertEquals(
            "4059219421060549148",
            legacyMangaId(legacyParserSourceName("data:mangafire_pt_br"), mangaUrl).toString(),
        )
        assertEquals(
            "MANGAFIRE_EN",
            mangaIdRemapSourceName(MangaSourceRef.Script("JS_MANGAFIRE_EN")),
        )
        assertEquals(null, mangaIdRemapSourceName(MangaSourceRef.Script("JS_ASURASCANS_US")))
    }

    @Test
    fun renamedCatalogueIdsKeepHistoricalParserGoldenIds() {
        val mangaUrl = "/manga/test-title/"
        val cases = linkedMapOf(
            "data:maid-id" to "8573540992123617518",
            "data:shiro-doujin" to "-4560892678894670240",
            "data:komikindo-info" to "4590071409664593119",
            "data:mangabat" to "-3164277965060976340",
        )
        assertEquals(
            "4210925046420603624",
            legacyMangaId(
                legacyParserSourceName("data:webtoons"),
                "/en/action/im-the-max-level-newbie/list?title_no=3915",
            ).toString(),
        )
        assertEquals(
            "3915",
            canonicalLegacyMangaUrl("WEBTOONS_EN", "/en/action/title/list?title_no=3915"),
        )
        assertEquals(
            "-7930331079980969865",
            legacyMangaId(
                legacyParserSourceName("data:asurascans"),
                "https://asurascans.com/comics/solo-leveling-89829cb7",
            ).toString(),
        )
        assertEquals(
            "/comics/solo-leveling-89829cb7",
            canonicalLegacyMangaUrl(
                "ASURASCANS_US",
                "https://asurascans.com/comics/solo-leveling-89829cb7",
            ),
        )

        assertEquals(
            cases,
            cases.keys.associateWith { sourceId ->
                legacyMangaId(legacyParserSourceName(sourceId), mangaUrl).toString()
            },
        )
    }

    @Test
    fun everyDataDrivenNatoRouteUsesItsEffectiveCatalogueDomain() {
        val cases = linkedMapOf(
            "data:manganato" to "natomanga.com",
            "data:manganelo" to "www.nelomanga.net",
            "data:mangakakalot" to "www.mangakakalot.gg",
            "data:mangakakalottv" to "www.mangakakalot.gg",
            "data:mangabat" to "www.mangabats.com",
        )

        val actual = cases.mapValues { (id, domain) ->
            NatoExtensionService(dataSource(id, domain), HelperNetworkConfig()).domain
        }

        assertEquals(cases, actual)
    }

    @Test
    fun nativeRoutesKeepTheOriginatingDataDrivenIdentityInBrowseResults() {
        MockWebServer().use { server ->
            server.start()
            val client = OkHttpClient()
            val baseUrl = server.url("/").toString().trimEnd('/')
            server.enqueue(
                MockResponse.Builder().body(
                    """
                    <div class="list-comic-item-wrap">
                      <a class="list-story-item" href="$baseUrl/manga/nato-title" title="Nato Title">
                        <img src="$baseUrl/nato.jpg">
                      </a>
                    </div>
                    """.trimIndent(),
                ).build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .body("""{"items":[{"hid":"fire-1","slug":"fire-title","title":"Fire Title"}],"meta":{"hasNext":false}}""")
                    .build(),
            )
            server.enqueue(
                MockResponse.Builder()
                    .body("""{"data":{"items":[{"id":"toon-1","url":"/toon-title","name":"Toon Title"}],"pagination":{"has_next":false}}}""")
                    .build(),
            )

            val natoSource = dataSource("data:manganato", "natomanga.com")
            val fireSource = dataSource("data:mangafire_en", "mangafire.to")
            val toonSource = dataSource("data:toonily_me", "toontop.io")
            val nato = NatoExtensionService(
                natoSource,
                HelperNetworkConfig(),
                clientFactory = { client },
                baseUrlOverride = baseUrl,
            )
            val fire = MangaFireExtensionService(
                fireSource,
                HelperNetworkConfig(),
                clientFactory = { client },
                baseUrlOverride = baseUrl,
            )
            val toon = ToonDexExtensionService(
                toonSource,
                HelperNetworkConfig(),
                clientFactory = { client },
                apiUrlOverride = baseUrl,
                siteUrlOverride = baseUrl,
            )

            val refs = runBlocking {
                listOf(
                    nato.getPopular(1).entries.single().source,
                    fire.getPopular(1).entries.single().source,
                    toon.getPopular(1).entries.single().source,
                )
            }

            assertEquals(
                listOf(
                    MangaSourceRef.Script(natoSource.id),
                    MangaSourceRef.Script(fireSource.id),
                    MangaSourceRef.Script(toonSource.id),
                ),
                refs,
            )
        }
    }

    @Test
    fun nativeRoutesReadUpdatedNetworkSettingsForEveryRequest() {
        MockWebServer().use { server ->
            server.start()
            val client = OkHttpClient()
            val baseUrl = server.url("/").toString().trimEnd('/')
            val natoSettings = mutableListOf<HelperNetworkSettings>()
            val fireSettings = mutableListOf<HelperNetworkSettings>()
            val toonSettings = mutableListOf<HelperNetworkSettings>()
            val natoConfig = HelperNetworkConfig()
            val fireConfig = HelperNetworkConfig()
            val toonConfig = HelperNetworkConfig()
            val nato = NatoExtensionService(
                dataSource("data:manganato", "natomanga.com"),
                natoConfig,
                clientFactory = { settings -> natoSettings += settings; client },
                baseUrlOverride = baseUrl,
            )
            val fire = MangaFireExtensionService(
                dataSource("data:mangafire_en", "mangafire.to"),
                fireConfig,
                clientFactory = { settings -> fireSettings += settings; client },
                baseUrlOverride = baseUrl,
            )
            val toon = ToonDexExtensionService(
                dataSource("data:toonily_me", "toontop.io"),
                toonConfig,
                clientFactory = { settings -> toonSettings += settings; client },
                apiUrlOverride = baseUrl,
                siteUrlOverride = baseUrl,
            )

            runBlocking {
                server.enqueue(MockResponse.Builder().body(EMPTY_NATO).build())
                nato.getPopular(1)
                natoConfig.update(HelperNetworkSettings(sslBypass = true))
                server.enqueue(MockResponse.Builder().body(EMPTY_NATO).build())
                nato.getPopular(2)

                server.enqueue(MockResponse.Builder().body(EMPTY_FIRE).build())
                fire.getPopular(1)
                fireConfig.update(HelperNetworkSettings(sslBypass = true))
                server.enqueue(MockResponse.Builder().body(EMPTY_FIRE).build())
                fire.getPopular(2)

                server.enqueue(MockResponse.Builder().body(EMPTY_TOON).build())
                toon.getPopular(1)
                toonConfig.update(HelperNetworkSettings(sslBypass = true))
                server.enqueue(MockResponse.Builder().body(EMPTY_TOON).build())
                toon.getPopular(2)
            }

            assertEquals(listOf(false, true), natoSettings.map { it.sslBypass })
            assertEquals(listOf(false, true), fireSettings.map { it.sslBypass })
            assertEquals(listOf(false, true), toonSettings.map { it.sslBypass })
        }
    }

    private fun dataSource(id: String, domain: String) = MangaSource(
        id = id,
        name = id.removePrefix("data:"),
        lang = "en",
        baseUrl = "https://$domain",
        isInstalled = true,
        engine = SourceEngine.JavaScript,
    )

    private companion object {
        const val EMPTY_NATO = "<html><body></body></html>"
        const val EMPTY_FIRE = """{"items":[],"meta":{"hasNext":false}}"""
        const val EMPTY_TOON = """{"data":{"items":[],"pagination":{"has_next":false}}}"""
    }
}
