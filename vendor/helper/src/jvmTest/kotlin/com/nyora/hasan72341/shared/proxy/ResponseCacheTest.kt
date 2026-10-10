package com.nyora.hasan72341.shared.proxy

import java.nio.file.Files
import java.util.Base64
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.fail

class ResponseCacheTest {
    @Test
    fun dayOldSourceCannotBeServedWhileAnotherSourceRemainsCachedAfterRestart() {
        val directory = Files.createTempDirectory("nyora-cache-age-test")
        try {
            val snapshot = directory.resolve("cache.snap")
            val encoder = Base64.getEncoder()
            val now = System.currentTimeMillis()
            snapshot.writeText(listOf(
                Triple(now - 25L * 60 * 60 * 1000, "browse:data:old", "partial"),
                Triple(now + 60_000, "browse:data:fresh", "complete"),
            ).joinToString("\n", postfix = "\n") { (expiry, key, value) ->
                "$expiry\t${encoder.encodeToString(key.toByteArray())}\t${encoder.encodeToString(value.toByteArray())}"
            })
            val cache = ResponseCacheStore(snapshot.toFile())
            assertNull(cache.peek("browse:data:old"))
            assertNull(cache.get("browse:data:old"))
            assertEquals("complete", cache.get("browse:data:fresh"))
            val restarted = ResponseCacheStore(snapshot.toFile())
            assertNull(restarted.peek("browse:data:old"))
        } finally { directory.toFile().deleteRecursively() }
    }

    @Test
    fun restartDoesNotMakeExpiredBrowseEntriesFreshAgain() {
        val directory = Files.createTempDirectory("nyora-cache-restart-age-test")
        try {
            val snapshot = directory.resolve("cache.snap")
            val encoder = Base64.getEncoder()
            snapshot.writeText(listOf(System.currentTimeMillis() - 60_000,
                encoder.encodeToString("browse:data:test".toByteArray()),
                encoder.encodeToString("needs refresh".toByteArray())).joinToString("\t") + "\n")
            val cache = ResponseCacheStore(snapshot.toFile())
            assertNull(cache.get("browse:data:test"))
            assertEquals(true, cache.peek("browse:data:test")?.stale)
        } finally { directory.toFile().deleteRecursively() }
    }


    @Test
    fun invalidationBeforeFirstReadRemovesAPersistedEntry() {
        val directory = Files.createTempDirectory("nyora-response-cache-test")
        try {
            val snapshot = directory.resolve("cache.snap")
            val encoder = Base64.getEncoder()
            snapshot.writeText(
                listOf(
                    System.currentTimeMillis() + 60_000,
                    encoder.encodeToString("catalog".toByteArray()),
                    encoder.encodeToString("stale catalogue".toByteArray()),
                ).joinToString("\t") + "\n",
            )
            val cache = ResponseCacheStore(snapshot.toFile())

            cache.invalidate("catalog")

            assertNull(cache.get("catalog"))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun prefixInvalidationBeforeFirstReadRemovesPersistedBrowseEntries() {
        val directory = Files.createTempDirectory("nyora-response-cache-prefix-test")
        try {
            val snapshot = directory.resolve("cache.snap")
            val encoder = Base64.getEncoder()
            snapshot.writeText(
                listOf(
                    System.currentTimeMillis() + 60_000,
                    encoder.encodeToString("browse:POPULAR:data:test:1:".toByteArray()),
                    encoder.encodeToString("stale browse".toByteArray()),
                ).joinToString("\t") + "\n",
            )
            val cache = ResponseCacheStore(snapshot.toFile())

            cache.invalidatePrefix("browse:")

            assertNull(cache.get("browse:POPULAR:data:test:1:"))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun catalogueInvalidationInsideDebounceIsDurableAcrossRestart() {
        val directory = Files.createTempDirectory("nyora-response-cache-restart-test")
        try {
            val snapshot = directory.resolve("cache.snap")
            val encoder = Base64.getEncoder()
            val expiresAt = System.currentTimeMillis() + 60_000
            snapshot.writeText(
                listOf(
                    listOf(
                        expiresAt,
                        encoder.encodeToString("catalog".toByteArray()),
                        encoder.encodeToString("old catalogue".toByteArray()),
                    ).joinToString("\t"),
                    listOf(
                        expiresAt,
                        encoder.encodeToString("browse:POPULAR:data:test:1:".toByteArray()),
                        encoder.encodeToString("old browse".toByteArray()),
                    ).joinToString("\t"),
                ).joinToString("\n", postfix = "\n"),
            )
            val cache = ResponseCacheStore(snapshot.toFile())

            // Complete one leading-edge save so the next mutations happen inside the
            // ten-second debounce window, exactly like catalogue GET -> POST apply.
            val warmupKey = "warmup"
            val encodedWarmupKey = encoder.encodeToString(warmupKey.toByteArray())
            cache.put(warmupKey, "saved", 60_000)
            val deadline = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < deadline) {
                if (snapshot.readText().contains(encodedWarmupKey)) break
                Thread.sleep(10)
            }
            if (!snapshot.readText().contains(encodedWarmupKey)) {
                fail("The leading-edge cache snapshot was not written")
            }

            cache.invalidate("catalog")
            cache.invalidatePrefix("browse:")

            val restarted = ResponseCacheStore(snapshot.toFile())
            assertNull(restarted.get("catalog"))
            assertNull(restarted.get("browse:POPULAR:data:test:1:"))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * Search keys are high-cardinality — one per (source, query, page) — so a
     * single global search adds hundreds at once. The store evicts by clearing
     * the whole map, so if search shared the browse store it would wipe the
     * pre-warmed browse entries that exist precisely so nobody waits on a cold
     * fetch. This pins the bound: filling a small store never touches another.
     */
    @Test
    fun aFloodOfSearchEntriesDoesNotEvictBrowseEntriesFromASeparateStore() {
        val directory = Files.createTempDirectory("nyora-response-cache-split-test")
        try {
            val browse = ResponseCacheStore(directory.resolve("browse.snap").toFile(), maxEntries = 8)
            val search = ResponseCacheStore(directory.resolve("search.snap").toFile(), maxEntries = 8)

            browse.put("browse:POPULAR:data:test:1:", "warm popular page", 600_000)

            // Far more search entries than the search store can hold.
            repeat(50) { i -> search.put("search:data:src$i:1::naruto", "results $i", 600_000) }

            assertEquals("warm popular page", browse.get("browse:POPULAR:data:test:1:"))
            assertNotNull(search.get("search:data:src49:1::naruto"))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }
}
