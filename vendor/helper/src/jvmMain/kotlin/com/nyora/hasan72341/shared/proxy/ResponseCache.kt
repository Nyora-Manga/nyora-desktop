package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.HelperProfile
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * In-memory response cache for hot, globally-identical responses — the catalog
 * and popular/latest browse lists (same for every user). Designed so users
 * NEVER wait on a cold upstream fetch after the first population:
 *
 *  - **Persistent**: the whole map is snapshotted to ONE file and reloaded on
 *    startup, so a helper restart comes back instantly warm (no cold-fetch
 *    latency). Reads are pure memory; disk is touched only for the snapshot,
 *    off the request hot path (debounced background writer). This is NOT the
 *    old per-request disk sidecar.
 *  - **Serve-stale-while-revalidate**: `peek` returns a value even past its TTL
 *    (marked `stale`) so the handler can respond instantly and refresh in the
 *    background — the user gets an immediate answer every time.
 *
 * Bounded so it can't grow the small VM's heap.
 */
internal class ResponseCacheStore(
    private val snapshotFile: File,
    private val maxEntries: Int = 600,
) {
    init { HelperProfile.confine(snapshotFile.toPath()) }

    private class Entry(val value: String, val expiresAt: Long, val fetchedAt: Long)
    private val maxAgeMs = 24L * 60 * 60 * 1000

    private val map = ConcurrentHashMap<String, Entry>()

    private val loaded = AtomicBoolean(false)
    private val saver = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "nyora-cache-saver").apply { isDaemon = true }
    }
    private val saveScheduleLock = Any()
    private var scheduledSave: ScheduledFuture<*>? = null
    @Volatile private var lastSaveAt = 0L
    private val saveDebounceMs = 10_000L

    /** A cache hit + whether it is past its TTL (still served, refreshed async). */
    class Hit(val value: String, val stale: Boolean)

    private fun ensureLoaded() {
        if (!loaded.compareAndSet(false, true)) return
        try {
            HelperProfile.confine(snapshotFile.toPath())
            if (!snapshotFile.exists()) return
            // Format: expiresAt, base64(key), base64(value), fetchedAt (tab-separated).
            snapshotFile.bufferedReader().useLines { lines ->
                val now = System.currentTimeMillis()
                for (line in lines) {
                    val parts = line.split('\t')
                    if (parts.size !in 3..4) continue
                    val exp = parts[0].toLongOrNull() ?: continue
                    // Older snapshots used the ten-minute browse freshness window.
                    // Preserve their age rather than granting new freshness on restart.
                    val fetchedAt = parts.getOrNull(3)?.toLongOrNull() ?: (exp - 600_000)
                    if (now - fetchedAt !in 0 until maxAgeMs) continue
                    val key = String(java.util.Base64.getDecoder().decode(parts[1]))
                    val value = String(java.util.Base64.getDecoder().decode(parts[2]))
                    map[key] = Entry(value, exp, fetchedAt)
                }
            }
        } catch (_: Throwable) { /* corrupt snapshot → ignore, rebuild live */ }
    }

    /** Value if present and NOT expired. */
    fun get(key: String): String? {
        ensureLoaded()
        val entry = map[key] ?: return null
        val now = System.currentTimeMillis()
        if (now >= entry.expiresAt || now - entry.fetchedAt !in 0 until maxAgeMs) return null
        return entry.value
    }

    /** Stale results may bridge short outages, but never outlive their daily limit. */
    fun peek(key: String): Hit? {
        ensureLoaded()
        val entry = map[key] ?: return null
        val now = System.currentTimeMillis()
        if (now - entry.fetchedAt !in 0 until maxAgeMs) return null
        return Hit(entry.value, now >= entry.expiresAt)
    }

    fun put(key: String, value: String, ttlMs: Long) {
        ensureLoaded()
        if (map.size >= maxEntries) {
            val now = System.currentTimeMillis()
            map.entries.removeIf { it.value.expiresAt <= now }
            if (map.size >= maxEntries) map.clear()
        }
        val now = System.currentTimeMillis()
        map[key] = Entry(value, now + ttlMs, now)
        scheduleSave()
    }

    fun invalidate(key: String) {
        ensureLoaded()
        map.remove(key)
        persistInvalidation()
    }

    /** Drop every entry whose key starts with [prefix] (e.g. "browse:") — used to force a
     *  fresh fetch after a Cloudflare solve, so content cached empty/blocked pre-solve is
     *  replaced instead of served stale. */
    fun invalidatePrefix(prefix: String) {
        ensureLoaded()
        val removed = map.keys.removeIf { it.startsWith(prefix) }
        if (removed) persistInvalidation()
    }

    /**
     * Leading-and-trailing-edge async snapshot. A mutation arriving during the
     * debounce window is covered by the pending trailing save instead of being
     * silently dropped.
     */
    private fun scheduleSave() {
        synchronized(saveScheduleLock) {
            if (scheduledSave != null) return
            val delayMs = maxOf(0L, lastSaveAt + saveDebounceMs - System.currentTimeMillis())
            scheduledSave = saver.schedule(
                {
                    synchronized(saveScheduleLock) { scheduledSave = null }
                    saveSnapshot()
                    lastSaveAt = System.currentTimeMillis()
                },
                delayMs,
                TimeUnit.MILLISECONDS,
            )
        }
    }

    /**
     * Invalidations are correctness-sensitive: persisting them before returning
     * prevents a quick helper restart from resurrecting stale catalogue/browse
     * data. Ordinary cache population remains asynchronous.
     */
    private fun persistInvalidation() {
        synchronized(saveScheduleLock) {
            scheduledSave?.cancel(false)
            scheduledSave = null
        }
        saveSnapshot()
        lastSaveAt = System.currentTimeMillis()
    }

    @Synchronized
    private fun saveSnapshot() {
        try {
            HelperProfile.confine(snapshotFile.toPath())
            snapshotFile.parentFile?.mkdirs()
            val tmp = File(snapshotFile.parentFile, snapshotFile.name + ".tmp")
            HelperProfile.confine(tmp.toPath())
            val enc = java.util.Base64.getEncoder()
            tmp.bufferedWriter().use { w ->
                for ((key, entry) in map) {
                    w.write(entry.expiresAt.toString())
                    w.write("\t"); w.write(enc.encodeToString(key.toByteArray()))
                    w.write("\t"); w.write(enc.encodeToString(entry.value.toByteArray()))
                    w.write("\t"); w.write(entry.fetchedAt.toString())
                    w.newLine()
                }
            }
            tmp.renameTo(snapshotFile)
        } catch (_: Throwable) { /* best-effort persistence */ }
    }
}

internal object ResponseCache {
    /**
     * Search responses live in their OWN store, not the browse/catalog one.
     *
     * Browse keys are low-cardinality (a few per source) and are what `prewarmCache`
     * fills so nobody waits on a cold fetch. Search keys are high-cardinality —
     * one per (source, query, page) — so a single global search adds hundreds at
     * once. Sharing one bounded map would let that flush the warm browse cache,
     * and the eviction path is `map.clear()`, so it would flush ALL of it.
     * Separate stores mean search can never cost browse its warmth.
     */
    const val SEARCH_PREFIX = "search:"

    private val cacheDir = if (HelperProfile.isolated) HelperProfile.directory("cache").toFile() else File(
        System.getenv("NYORA_CACHE_DIR") ?: System.getProperty("java.io.tmpdir") ?: "/tmp",
    )

    private val store = ResponseCacheStore(File(cacheDir, "nyora-response-cache.snap"))

    // Bigger cap: search is the high-cardinality traffic, and each entry is one
    // source's page of results. Overridable on a smaller/larger box.
    private val searchStore = ResponseCacheStore(
        File(cacheDir, "nyora-search-cache.snap"),
        maxEntries = System.getenv("NYORA_SEARCH_CACHE_ENTRIES")?.toIntOrNull() ?: 4000,
    )

    private fun storeFor(key: String): ResponseCacheStore =
        if (key.startsWith(SEARCH_PREFIX)) searchStore else store

    fun get(key: String): String? = storeFor(key).get(key)

    fun peek(key: String): ResponseCacheStore.Hit? = storeFor(key).peek(key)

    fun put(key: String, value: String, ttlMs: Long) = storeFor(key).put(key, value, ttlMs)

    fun invalidate(key: String) = storeFor(key).invalidate(key)

    /** Applied to BOTH stores — an invalidation must never miss because the
     *  caller's prefix doesn't say which store the keys landed in. */
    fun invalidatePrefix(prefix: String) {
        store.invalidatePrefix(prefix)
        searchStore.invalidatePrefix(prefix)
    }
}
