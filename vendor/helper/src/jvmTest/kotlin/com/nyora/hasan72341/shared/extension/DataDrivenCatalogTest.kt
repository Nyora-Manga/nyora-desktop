package com.nyora.hasan72341.shared.extension

import app.nyora.data.engine.EngineRegistry
import app.nyora.core.model.SortOrder
import app.nyora.data.engine.EngineConfig
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertIs
import kotlin.test.assertTrue

class DataDrivenCatalogTest {

    @Test
    fun retiredRowsCannotShadowTheirCanonicalReplacement() {
        val original = DataDrivenCatalog.snapshot()
        val retired = """{"id":"komikindo-info","engine":"mangareader","domain":"retired.example","broken":false}"""
        val current = """{"id":"mangasusuku","engine":"mangareader","domain":"current.example","broken":false}"""
        try {
            for (rows in listOf(listOf(retired, current), listOf(current, retired))) {
                val entries = DataDrivenCatalog.replace("""{"sources":[${rows.joinToString(",")}]}""")
                assertEquals(listOf("data:mangasusuku"), entries.map { it.source.id })
                assertNull(DataDrivenCatalog.find("data:komikindo-info"))
                assertEquals(
                    "data:mangasusuku",
                    currentDataSourceIdForLegacyParser("KOMIKINDO_INFO"),
                )
            }
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun declaredFormatsRemainSeparateFromTheAdultContentRating() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entries = DataDrivenCatalog.replace("""{"sources":[
                {"id":"mixed-adult","engine":"madara","domain":"mixed.example","nsfw":true,"contentType":"HENTAI","config":{"availableContentTypes":["MANGA","MANHWA","MANHUA","HENTAI","MANGA"]}},
                {"id":"unknown-adult","engine":"madara","domain":"unknown.example","nsfw":true,"contentType":"HENTAI"},
                {"id":"known-comics","engine":"madara","domain":"comics.example","nsfw":true,"contentType":"COMICS"}
            ]}""").associateBy { it.definition.id }
            assertEquals(listOf("MANGA", "MANHWA", "MANHUA"), entries.getValue("mixed-adult").supportedFormats)
            assertEquals(emptyList(), entries.getValue("unknown-adult").supportedFormats)
            assertEquals(listOf("COMICS"), entries.getValue("known-comics").supportedFormats)
            assertTrue(entries.values.all { it.source.isNsfw })
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun publicSourceIdsAreLowercaseWhileEngineDefinitionsKeepTheirIdentity() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entry = DataDrivenCatalog.replace("""{"sources":[{"id":"Mixed_CASE","engine":"madara","domain":"example.com"}]}""").single()
            assertEquals("data:mixed_case", entry.source.id)
            assertEquals("Mixed_CASE", entry.definition.id)
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun invalidAndCaseCollidingCatalogueIdsLeaveTheLiveCatalogueIntact() {
        val original = DataDrivenCatalog.snapshot()
        for (ids in listOf(listOf("same", "SAME"), listOf("bad/id"), listOf(""), listOf(" spaced "))) {
            val rows = ids.joinToString(",") { """{"id":"$it","engine":"madara","domain":"example.com"}""" }
            assertFailsWith<IllegalArgumentException> {
                DataDrivenCatalog.replace("""{"sources":[$rows]}""")
            }
            assertEquals(original, DataDrivenCatalog.snapshot())
        }
    }

    @Test
    fun rawConfigPreservesScalarListNestedAndExplicitCompatibilityValues() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entry = DataDrivenCatalog.replace(
                """
                {
                  "sources": [{
                    "id": "raw-values",
                    "engine": "madara",
                    "domain": "raw.example",
                    "config": {
                      "pageSize": 17,
                      "enabled": true,
                      "nullable": null,
                      "values": ["alpha", 3, false, null, {"deep": "value"}],
                      "nested": {"flag": true, "numbers": [1, 2]},
                      "authUrl": "/login",
                      "selectRequiredLogin": ".login-required"
                    },
                    "configComplex": {"extra": {"token": "kept"}}
                  }]
                }
                """.trimIndent(),
            ).single()

            assertEquals(17, entry.definition.rawConfig["pageSize"])
            assertEquals(true, entry.definition.rawConfig["enabled"])
            assertNull(entry.definition.rawConfig["nullable"])
            assertEquals(
                listOf("alpha", 3, false, null, mapOf("deep" to "value")),
                entry.definition.rawConfig["values"],
            )
            assertEquals(
                mapOf("flag" to true, "numbers" to listOf(1, 2)),
                entry.definition.rawConfig["nested"],
            )
            assertEquals("/login", entry.definition.rawConfig["authUrl"])
            assertEquals(".login-required", entry.definition.rawConfig["selectRequiredLogin"])
            assertEquals(mapOf("token" to "kept"), entry.definition.rawConfig["extra"])
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun antiBotMetadataSurvivesWhileSolverlessCatalogueExcludesOnlyWallB() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val local = DataDrivenCatalog.replace(
                """
                {"sources":[
                  {"id":"wall-b","engine":"madara","domain":"b.example","antiBot":"cloudflare","cfWall":"B","needsCustomLogic":false},
                  {"id":"wall-a","engine":"madara","domain":"a.example","antiBot":"cloudflare","cfWall":"A","needsCustomLogic":false},
                  {"id":"custom","engine":"madara","domain":"custom.example","needsCustomLogic":true}
                ]}
                """.trimIndent(),
            )

            assertEquals(listOf("data:wall-b", "data:wall-a", "data:custom"), local.map { it.source.id })
            assertEquals("cloudflare", local[0].definition.rawConfig["antiBot"])
            assertEquals("B", local[0].definition.rawConfig["cfWall"])
            assertEquals(false, local[0].definition.rawConfig["needsCustomLogic"])
            assertEquals(true, local[2].definition.rawConfig["needsCustomLogic"])
            assertEquals(
                listOf("data:wall-a", "data:custom"),
                DataDrivenCatalog.loadForSolverlessClient().map { it.source.id },
            )
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun brokenRowsAreExcludedWhetherOrNotTheyCarryAReason() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entries = DataDrivenCatalog.replace(
                """
                {"sources":[
                  {"id":"broken-without-reason","engine":"madara","domain":"one.example","broken":true},
                  {"id":"broken-with-reason","engine":"madara","domain":"two.example","broken":true,"brokenReason":"retired"},
                  {"id":"healthy","engine":"madara","domain":"healthy.example","broken":false}
                ]}
                """.trimIndent(),
            )

            assertEquals(listOf("data:healthy"), entries.map { it.source.id })
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun dataDrivenPatchKeysMatchCaseInsensitivelyWithoutChangingStableIds() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entries = DataDrivenCatalog.replace(
                """
                {"sources":[
                  {"id":"MANGABAT","engine":"madara","domain":"stale.example"},
                  {"id":"COMIC1000","engine":"madara","domain":"dead.example"},
                  {"id":"astrascans","name":"Old Astra","engine":"madara","domain":"old-astra.example"},
                  {"id":"asurascans_us","engine":"madara","domain":"dead-alias.example"}
                ]}
                """.trimIndent(),
            )

            assertEquals(listOf("data:mangabat", "data:astrascans"), entries.map { it.source.id })
            val ddPatched = entries[0]
            assertEquals("MANGABAT", ddPatched.definition.id)
            assertEquals("www.mangabats.com", ddPatched.definition.domain)
            assertEquals("https://www.mangabats.com", ddPatched.source.baseUrl)
            val directPatched = entries[1]
            assertEquals("astrascans", directPatched.definition.id)
            assertEquals("astracomic.com", directPatched.definition.domain)
            assertEquals("Astra Comic", directPatched.source.name)
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun madaraTypedConfigPreservesSortCapabilitiesAndFlatSelectors() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entry = DataDrivenCatalog.replace(
                """
                {"sources":[{
                  "id":"madara-config","engine":"madara","domain":"madara.example",
                  "config":{
                    "sortOrders":["POPULARITY","UPDATED_ASC"],
                    "capabilities":{"multipleTags":false,"tagsExclusion":false,"search":false,"searchWithFilters":true,"year":true,"authorSearch":true},
                    "selectChapter":".chapters a","selectPage":".reading img","selectBodyPage":"main",
                    "selectDesc":".summary","selectGenre":".genres a","selectDate":"time",
                    "selectState":".status","selectAlt":".alternative","selectTestAsync":"#ready"
                  }
                }]}
                """.trimIndent(),
            ).single()

            val config = assertIs<EngineConfig.Madara>(entry.definition.config)
            assertEquals(listOf(SortOrder.POPULARITY, SortOrder.UPDATED_ASC), config.sortOrders)
            assertEquals(false, config.capabilities.multipleTags)
            assertEquals(false, config.capabilities.tagsExclusion)
            assertEquals(false, config.capabilities.search)
            assertEquals(true, config.capabilities.searchWithFilters)
            assertEquals(true, config.capabilities.year)
            assertEquals(true, config.capabilities.authorSearch)
            assertEquals(".chapters a", config.selectors.chapter)
            assertEquals(".reading img", config.selectors.page)
            assertEquals("main", config.selectors.bodyPage)
            assertEquals(".summary", config.selectors.desc)
            assertEquals(".genres a", config.selectors.genre)
            assertEquals("time", config.selectors.date)
            assertEquals(".status", config.selectors.state)
            assertEquals(".alternative", config.selectors.alt)
            assertEquals("#ready", config.selectors.testAsync)
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun mangaReaderTypedConfigPreservesDomainsSortCapabilitiesAndStatusFields() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entry = DataDrivenCatalog.replace(
                """
                {"sources":[{
                  "id":"reader-config","engine":"mangareader","domain":"primary.example",
                  "config":{
                    "domains":["mirror.example","primary.example"],
                    "defaultSortOrder":"NEWEST","sortOrders":["NEWEST","RATING_ASC"],
                    "capabilities":{"multipleTags":false,"tagsExclusion":false,"search":true,"searchWithFilters":true,"year":true,"authorSearch":true},
                    "availableStates":["ongoing","completed"],
                    "availableContentTypes":["manga","manhwa"],
                    "statusOverrides":{"publishing":"ONGOING"},
                    "relativeDateWords":{"yesterday":"1 day ago"}
                  }
                }]}
                """.trimIndent(),
            ).single()

            val config = assertIs<EngineConfig.MangaReader>(entry.definition.config)
            assertEquals(listOf("primary.example", "mirror.example"), config.domains)
            assertEquals(SortOrder.NEWEST, config.defaultSortOrder)
            assertEquals(listOf(SortOrder.NEWEST, SortOrder.RATING_ASC), config.sortOrders)
            assertEquals(false, config.capabilities.multipleTags)
            assertEquals(false, config.capabilities.tagsExclusion)
            assertEquals(true, config.capabilities.searchWithFilters)
            assertEquals(true, config.capabilities.year)
            assertEquals(true, config.capabilities.authorSearch)
            assertEquals(listOf("ongoing", "completed"), config.availableStates)
            assertEquals(listOf("manga", "manhwa"), config.availableContentTypes)
            assertEquals(mapOf("publishing" to "ONGOING"), config.statusOverrides)
            assertEquals(mapOf("yesterday" to "1 day ago"), config.relativeDateWords)
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun fingerprintTracksNormalizedEffectiveDefinitionsRatherThanRawJsonBytes() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val compact = """{"sources":[{"id":"fingerprint","name":"Fingerprint","lang":"en","engine":"madara","domain":"old.example","config":{}}]}"""
            DataDrivenCatalog.replace(compact)
            val compactSnapshot = DataDrivenCatalog.snapshot()
            DataDrivenCatalog.replace(
                """
                {
                  "sources": [
                    {"id": "fingerprint", "name": "Fingerprint", "lang": "en", "engine": "madara", "domain": "old.example", "config": {}}
                  ]
                }
                """.trimIndent(),
            )
            val formattedSnapshot = DataDrivenCatalog.snapshot()
            val patchedEntries = formattedSnapshot.entries.map { entry ->
                entry.copy(
                    source = entry.source.copy(baseUrl = "https://patched.example"),
                    definition = entry.definition.copy(domain = "patched.example"),
                )
            }

            assertEquals(compactSnapshot.fingerprint, formattedSnapshot.fingerprint)
            assertNotEquals(
                formattedSnapshot.fingerprint,
                effectiveCatalogueFingerprint(patchedEntries),
            )
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun guardedCommitCannotInterleaveACatalogueReplacementAfterValidation() {
        val original = DataDrivenCatalog.snapshot()
        val pool = Executors.newFixedThreadPool(2)
        val commitEntered = CountDownLatch(1)
        val releaseCommit = CountDownLatch(1)
        val replaceStarted = CountDownLatch(1)
        val replaceFinished = CountDownLatch(1)
        val events = CopyOnWriteArrayList<String>()
        try {
            DataDrivenCatalog.replace(
                """{"sources":[{"id":"guarded","name":"Guarded","lang":"en","engine":"madara","domain":"old.example","config":{}}]}""",
            )
            val revision = DataDrivenCatalog.snapshot().revision
            val commit = pool.submit {
                assertTrue(
                    DataDrivenCatalog.commitIfRevision(revision) {
                        commitEntered.countDown()
                        assertTrue(releaseCommit.await(5, TimeUnit.SECONDS))
                        events += "commit"
                    },
                )
            }
            assertTrue(commitEntered.await(5, TimeUnit.SECONDS))
            val replace = pool.submit {
                replaceStarted.countDown()
                DataDrivenCatalog.replace(
                    """{"sources":[{"id":"guarded","name":"Guarded","lang":"en","engine":"madara","domain":"new.example","config":{}}]}""",
                )
                events += "replace"
                replaceFinished.countDown()
            }
            assertTrue(replaceStarted.await(5, TimeUnit.SECONDS))
            assertFalse(replaceFinished.await(250, TimeUnit.MILLISECONDS))

            releaseCommit.countDown()
            commit.get(5, TimeUnit.SECONDS)
            replace.get(5, TimeUnit.SECONDS)
            assertEquals(listOf("commit", "replace"), events)
        } finally {
            releaseCommit.countDown()
            pool.shutdownNow()
            DataDrivenCatalog.restore(original)
        }
    }

    @Test
    fun rejectsACatalogueWithoutASourcesArray() {
        assertFailsWith<IllegalArgumentException> {
            DataDrivenCatalog.replace("{}")
        }
    }

    @Test
    fun loadsBundledSourcesSupportedByTheEngineRegistry() {
        val entries = DataDrivenCatalog.load()

        assertTrue(entries.isNotEmpty())
        assertTrue(entries.all {
            it.engineKey in EngineRegistry.engineIds || it.engineKey == "mangafire"
        })
        assertTrue(entries.all { it.source.id.startsWith("data:") })
    }

    @Test
    fun bundledManga18FamilyOmitsKnownDeadMembers() {
        assertNull(DataDrivenCatalog.find("data:tumanhwas"))
        assertNull(DataDrivenCatalog.find("data:comic1000"))
    }

    @Test
    fun localSourceHealthPatchesRemainAuthoritativeOverAStaleRemoteCatalogue() {
        val original = DataDrivenCatalog.snapshot()
        try {
            val entries = DataDrivenCatalog.replace(
                """
                {
                  "sources": [
                    {
                      "id": "tumanhwas",
                      "name": "Tumanhwas",
                      "lang": "es",
                      "engine": "manga18",
                      "domain": "tumanhwas.club",
                      "broken": true,
                      "brokenReason": "stale domain no longer resolves",
                      "config": {}
                    },
                    {
                      "id": "comic1000",
                      "name": "Comic1000",
                      "lang": "en",
                      "engine": "manga18",
                      "domain": "comic1000.com",
                      "broken": true,
                      "config": {}
                    },
                    {
                      "id": "porncomic18",
                      "name": "18PornComic",
                      "lang": "en",
                      "engine": "manga18",
                      "domain": "18porncomic.com",
                      "broken": false,
                      "config": {}
                    }
                  ]
                }
                """.trimIndent(),
            )

            assertTrue(entries.map { it.source.id } == listOf("data:porncomic18"))
        } finally {
            DataDrivenCatalog.restore(original)
        }
    }
}
