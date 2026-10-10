package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.SourceEngine
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class DataDrivenCatalogueApplyTest {

    @AfterTest
    fun restoreBundledCatalogue() {
        val bundled = requireNotNull(javaClass.classLoader.getResourceAsStream("nyora/catalogue.json"))
            .bufferedReader().use { it.readText() }
        DataDrivenCatalog.replace(bundled)
    }

    @Test
    fun persistenceFailureRestoresTheOldCatalogueAndReseedsIt() {
        DataDrivenCatalog.replace(catalogue("old.example"))
        var reseedCount = 0

        assertFailsWith<IllegalStateException> {
            applyDataDrivenCatalogue(
                remoteJson = catalogue("new.example"),
                persist = { error("disk full") },
                reseed = { reseedCount += 1 },
            )
        }

        assertEquals("old.example", DataDrivenCatalog.load().single().definition.domain)
        assertEquals(2, reseedCount)
    }

    @Test
    fun reseedFailureRestoresTheOldCatalogueBeforeRollingTheRepositoryBack() {
        DataDrivenCatalog.replace(catalogue("old.example"))
        var reseedCount = 0
        var persisted = false

        assertFailsWith<IllegalStateException> {
            applyDataDrivenCatalogue(
                remoteJson = catalogue("new.example"),
                persist = { persisted = true },
                reseed = {
                    reseedCount += 1
                    if (reseedCount == 1) error("reseed failed")
                },
            )
        }

        assertEquals("old.example", DataDrivenCatalog.load().single().definition.domain)
        assertEquals(2, reseedCount)
        assertFalse(persisted)
    }

    @Test
    fun persistenceFailureRestoresExactSourceRowsIncludingOldOnlyUserFlags() {
        DataDrivenCatalog.replace(catalogue("old.example"))
        val oldOnly = MangaSource(
            id = "data:old-only",
            name = "Old only",
            lang = "en",
            baseUrl = "https://old-only.example",
            engine = SourceEngine.JavaScript,
            isInstalled = false,
            isPinned = true,
            installedAt = 987654321L,
        )
        var rows = listOf(oldOnly)

        assertFailsWith<IllegalStateException> {
            applyDataDrivenCatalogue(
                remoteJson = catalogue("new.example"),
                persist = { error("disk full") },
                reseed = {
                    rows = listOf(
                        MangaSource(
                            id = "data:test-source",
                            name = "New source",
                            lang = "en",
                            baseUrl = "https://new.example",
                            engine = SourceEngine.JavaScript,
                        ),
                    )
                },
                captureSourceRows = { rows },
                restoreSourceRows = { rows = it },
            )
        }

        assertEquals(listOf(oldOnly), rows)
    }

    @Test
    fun detailsOverlappingFailedPersistenceCannotCommitTheProvisionalCatalogue() {
        DataDrivenCatalog.replace(catalogue("old.example"))
        val persistenceStarted = CountDownLatch(1)
        val releasePersistence = CountDownLatch(1)
        val applyFailure = AtomicReference<Throwable?>()
        val applied = thread(name = "catalogue-apply") {
            applyFailure.set(
                runCatching {
                    applyDataDrivenCatalogue(
                        remoteJson = catalogue("new.example"),
                        persist = {
                            persistenceStarted.countDown()
                            check(releasePersistence.await(5, TimeUnit.SECONDS)) {
                                "test did not release catalogue persistence"
                            }
                            error("disk full")
                        },
                        reseed = {},
                    )
                }.exceptionOrNull(),
            )
        }

        val persistedDetailsDomain = AtomicReference<String?>()
        val detailsStarted = CountDownLatch(1)
        val detailsFinished = CountDownLatch(1)
        var details: Thread? = null
        try {
            assertTrue(persistenceStarted.await(5, TimeUnit.SECONDS), "catalogue persistence did not start")
            details = thread(name = "overlapping-details") {
                detailsStarted.countDown()
                val requestCatalogue = DataDrivenCatalog.snapshot()
                DataDrivenCatalog.commitIfRevision(requestCatalogue.revision) {
                    persistedDetailsDomain.set(requestCatalogue.entries.single().definition.domain)
                }
                detailsFinished.countDown()
            }
            assertTrue(detailsStarted.await(5, TimeUnit.SECONDS), "details operation did not start")

            val observationDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (detailsFinished.count != 0L && details.state != Thread.State.BLOCKED &&
                System.nanoTime() < observationDeadline
            ) {
                Thread.yield()
            }
            assertTrue(
                detailsFinished.count == 0L || details.state == Thread.State.BLOCKED,
                "details neither completed nor waited for the provisional catalogue",
            )
        } finally {
            releasePersistence.countDown()
            applied.join(5_000)
            details?.join(5_000)
        }

        assertIs<IllegalStateException>(applyFailure.get())
        assertFalse(applied.isAlive, "catalogue apply thread did not finish")
        assertFalse(details?.isAlive == true, "details thread did not finish")
        assertEquals("old.example", DataDrivenCatalog.load().single().definition.domain)
        assertEquals("old.example", persistedDetailsDomain.get())
    }

    private fun catalogue(domain: String): String = """
        {
          "sources": [{
            "id": "test-source",
            "name": "Test Source",
            "lang": "en",
            "engine": "madara",
            "domain": "$domain",
            "config": {}
          }]
        }
    """.trimIndent()
}
