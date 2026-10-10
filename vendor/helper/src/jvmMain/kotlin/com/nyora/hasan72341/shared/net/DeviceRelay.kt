package com.nyora.hasan72341.shared.net

import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Device-as-egress relay for Cloudflare Turnstile sites the server-side solver
 * (FlareSolverr) can't beat.
 *
 * cf_clearance is IP-locked, so a cookie solved on a phone is useless to the
 * helper (different IP). Instead, the phone PERFORMS the fetch itself — its IP,
 * its WebView-cleared session — and streams the bytes back here to parse.
 *
 * Transport is long-polling over the existing HttpServer (no WebSocket dep):
 *  - device: GET  /device/relay/poll     → blocks up to 25s, returns next task
 *  - device: POST /device/relay/result   → returns a completed fetch
 *  - helper: [fetch] enqueues a task and blocks on the device's response
 *
 * Global (not per-user): any recently-polling device serves as egress. Fine for
 * personal / small deployments (typically one device connected).
 */
object DeviceRelay {
    data class Task(
        val id: String,
        val url: String,
        val method: String,
        val headers: Map<String, String>,
        val body: ByteArray?,
    )

    class Result(
        val status: Int,
        val contentType: String?,
        val body: ByteArray,
    )

    private val queue = LinkedBlockingQueue<Task>()
    private val futures = ConcurrentHashMap<String, CompletableFuture<Result>>()
    private val lastPoll = AtomicLong(0)

    private const val DEVICE_TTL_MS = 30_000L

    /** A device polled within the TTL → egress is available. */
    fun deviceAvailable(): Boolean = System.currentTimeMillis() - lastPoll.get() < DEVICE_TTL_MS

    /**
     * Ask a connected device to perform [url] and block for the result.
     * Returns null if no device is connected or it times out.
     */
    fun fetch(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: ByteArray? = null,
        timeoutMs: Long = 90_000,
    ): Result? {
        if (!deviceAvailable()) return null
        val id = UUID.randomUUID().toString()
        val future = CompletableFuture<Result>()
        futures[id] = future
        queue.offer(Task(id, url, method, headers, body))
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: Throwable) {
            null
        } finally {
            futures.remove(id)
        }
    }

    /** Device long-poll: wait up to [timeoutMs] for the next task. */
    fun poll(timeoutMs: Long = 25_000): Task? {
        lastPoll.set(System.currentTimeMillis())
        return try {
            queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: Throwable) {
            null
        }
    }

    /** Device delivers a completed fetch. */
    fun complete(id: String, result: Result) {
        futures[id]?.complete(result)
    }
}
