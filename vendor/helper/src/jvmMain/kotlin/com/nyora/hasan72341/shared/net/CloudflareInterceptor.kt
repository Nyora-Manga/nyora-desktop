package com.nyora.hasan72341.shared.net

import com.nyora.hasan72341.shared.HelperProfile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Talks to a local FlareSolverr instance (default http://127.0.0.1:8191/v1) to
 * solve a Cloudflare challenge. FlareSolverr runs a real Chrome on THIS host, so
 * the `cf_clearance` it returns is bound to this machine's IP + Chrome UA — which
 * is exactly what the helper's own OkHttp requests use, so the clearance is valid
 * for them. (Solves classic "Just a moment" JS challenges; cannot beat Turnstile.)
 */
internal object FlareSolverr {
    private val endpoint: String = System.getenv("FLARESOLVERR_URL") ?: "http://127.0.0.1:8191/v1"

    /**
     * FlareSolverr spawns headless Chrome. It is used ONLY by the headless cluster; every client
     * with a native WebKit solver (macOS `WKWebView`, iOS) must never touch it — WebKit fully
     * replaces Chromium there. So it's off whenever `NYORA_NATIVE_CF_SOLVER` is set (the macOS app
     * always sets it), not just when `NYORA_FLARESOLVERR_DISABLED=1`. This makes "no Chromium on
     * Mac" structural rather than dependent on a single env flag being present.
     */
    private val enabled: Boolean = System.getenv("NYORA_FLARESOLVERR_DISABLED").isNullOrBlank() &&
        System.getenv("NYORA_NATIVE_CF_SOLVER").isNullOrBlank()

    // Each solve spawns a headless Chrome. A batched all-source search hits many
    // CF sources at once, so cap concurrent solves (default 2) to stop a Chrome
    // swarm from saturating the small VM. Extra solves wait for a permit.
    /** How long FlareSolverr may spend on one challenge. */
    private val SOLVE_TIMEOUT_MS: Long =
        System.getenv("NYORA_FLARESOLVERR_TIMEOUT_MS")?.toLongOrNull() ?: 60_000L

    private val maxConcurrent: Int = System.getenv("NYORA_FLARESOLVERR_CONCURRENCY")?.toIntOrNull()?.coerceIn(1, 8) ?: 2
    private val gate = java.util.concurrent.Semaphore(maxConcurrent)

    private val json = Json { ignoreUnknownKeys = true }

    // Separate client (no CF interceptor) so solving never recurses.
    //
    // The read timeout MUST be raised explicitly. A solve routinely takes 10-20s — a real
    // Chrome has to load the page and sit through the challenge — while OkHttp's default
    // read timeout is 10s, so every solve was abandoned a few seconds before it landed:
    // FlareSolverr logged "Challenge solved!" and the helper had already given up and
    // returned the 403. callTimeout alone does not help, it only bounds the whole call.
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(SOLVE_TIMEOUT_MS + 30_000L, TimeUnit.MILLISECONDS)
        .callTimeout(SOLVE_TIMEOUT_MS + 60_000L, TimeUnit.MILLISECONDS)
        .build()

    /**
     * [body] is the page FlareSolverr's own Chrome loaded once the challenge cleared.
     * Kept because the cookie is frequently NOT replayable from this JVM (see the
     * interceptor), and the fetched html is then the only way through.
     */
    data class Solution(
        val cookieHeader: String,
        val userAgent: String,
        val status: Int,
        val body: String,
    )

    fun solve(url: String): Solution? {
        if (HelperProfile.isolated || !enabled) return null
        if (!gate.tryAcquire(120, TimeUnit.SECONDS)) return null // don't queue forever
        return try {
            val payload = buildJsonObject {
                put("cmd", "request.get")
                put("url", url)
                // Shorter than the old 90s so a broad search isn't pinned per solve.
                put("maxTimeout", SOLVE_TIMEOUT_MS.toInt())
            }.toString()
            val request = Request.Builder()
                .url(endpoint)
                .post(payload.toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val root = json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
                if (root["status"]?.jsonPrimitive?.contentOrNull != "ok") return null
                val solution = root["solution"]?.jsonObject ?: return null
                val userAgent = solution["userAgent"]?.jsonPrimitive?.contentOrNull ?: return null
                val cookies = solution["cookies"]?.jsonArray ?: return null
                val header = cookies.mapNotNull {
                    val obj = it.jsonObject
                    val name = obj["name"]?.jsonPrimitive?.contentOrNull
                    val value = obj["value"]?.jsonPrimitive?.contentOrNull
                    if (name != null && value != null) "$name=$value" else null
                }.joinToString("; ")
                val status = solution["status"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0
                val body = solution["response"]?.jsonPrimitive?.contentOrNull.orEmpty()
                if (header.isBlank()) null else Solution(header, userAgent, status, body)
            }
        } catch (_: Throwable) {
            null
        } finally {
            gate.release()
        }
    }
}

/**
 * OkHttp interceptor that transparently clears Cloudflare challenges via a local
 * FlareSolverr. On a challenge response it solves once, injects the returned
 * cf_clearance into [sharedCookieJar], remembers the solver's User-Agent for that
 * host (cf_clearance is UA-bound), and retries. Subsequent requests to the host
 * reuse the cached UA + jar cookie, so we don't re-solve every call.
 *
 * A singleton so the per-host UA cache is shared across every OkHttpClient the
 * helper builds (fetchText/fetchBytes create fresh clients per call).
 */
object CloudflareInterceptor : Interceptor {
    private val solvedUserAgent = ConcurrentHashMap<String, String>()

    /**
     * Hosts observed sitting behind a Cloudflare challenge.
     *
     * A challenge is only ever cleared by something with a browser: the desktop/iOS apps hand
     * it to their own WebView, and a headless deployment needs FlareSolverr. The web app has
     * neither — it talks to a hosted helper and cannot solve anything on its behalf — so these
     * sources can never work for a browser client and the catalogue hides them there.
     *
     * Learned as challenges are met, so it stays current on its own; seeded from a validator
     * sweep so a fresh deployment does not have to discover all of them the hard way.
     */
    private val challengedHosts = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    /** True when [host] is known to be challenge-gated. */
    fun isChallenged(host: String): Boolean = host.lowercase() in challengedHosts

    /** Record a challenge-gated host — called on detection, and to seed known ones. */
    fun noteChallenged(host: String) {
        if (host.isNotBlank()) challengedHosts.add(host.lowercase())
    }

    /**
     * Register the User-Agent that solved a host's challenge via the app's native WebView.
     * cf_clearance is bound to the UA that obtained it, so once the app POSTs the clearance
     * cookie we must pin every subsequent request to that host to the SAME UA — otherwise
     * the parser sends its own UA, Cloudflare rejects the clearance, and the retry is
     * challenged again. Mirrors what the FlareSolverr path does with solution.userAgent.
     * Also clears any blocked-until backoff so the retry is attempted immediately.
     */
    fun noteNativeSolve(host: String, userAgent: String) {
        solvedUserAgent[host] = userAgent
        blockedUntil.remove(host)
    }

    // Temporary diagnostic — appends to the same file the macOS app logs the solve to,
    // so the engine's retry request (UA, cookies actually loaded, response) can be seen
    // alongside the app-side solve. Remove once CF native-solve is confirmed working.
    private fun cfDiag(message: String) {
        runCatching {
            (HelperProfile.isolatedPath("logs/nyora-cf.log")?.also { java.nio.file.Files.createDirectories(it.parent) }?.toFile() ?: java.io.File("/tmp/nyora-cf.log")).appendText("[cf] $message\n")
        }
    }

    // When the host app can solve challenges itself, signal the challenge to it rather
    // than spawning a headless Chrome. The macOS app sets this: it owns a WKWebView,
    // which is already part of the OS, runs on the user's own residential IP, and can
    // beat Turnstile because a human can click it — none of which FlareSolverr can do.
    // The app catches "Cloudflare challenge: <host>", solves, POSTs the cf_clearance to
    // /cloudflare/clearance, and retries.
    //
    // Off by default, so the headless cluster (which has no WebView and a real
    // FlareSolverr on 127.0.0.1:8191) keeps its existing behaviour untouched.
    private val nativeSolver: Boolean = !System.getenv("NYORA_NATIVE_CF_SOLVER").isNullOrBlank()

    // While a broad global search is fanning out, skip ALL Cloudflare escalation
    // (FlareSolverr/proxy/device) and fail fast on blocked sources — solving CF for
    // hundreds of sources at once would pin the VM. Blocked sources simply don't
    // appear in search results. Incremented/decremented around each search fetch.
    val searchFanoutActive = java.util.concurrent.atomic.AtomicInteger(0)

    // Hosts that were blocked AND couldn't be solved recently. Skip the expensive
    // escalation (FlareSolverr/proxy/device) for them so a broad all-source search
    // doesn't re-solve the same unbeatable Cloudflare sites over and over and pin
    // the VM (headless-Chrome storm). Cleared when a host later succeeds.
    private val blockedUntil = ConcurrentHashMap<String, Long>()
    private val blockTtlMs: Long = System.getenv("NYORA_BLOCK_TTL_MS")?.toLongOrNull() ?: 600_000L // 10 min

    private fun hostBlocked(host: String): Boolean {
        val until = blockedUntil[host] ?: return false
        if (System.currentTimeMillis() > until) { blockedUntil.remove(host); return false }
        return true
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        val host = request.url.host

        // Once a host has been CF-solved by the app's WebView, its cf_clearance only works
        // from that WebView session (verified: OkHttp/curl-impersonate can't replay it).
        // Route the request through the WebView relay instead of this JVM's TLS stack.
        if (WebViewRelay.isConfigured && WebViewRelay.isRelayHost(host)) {
            val relayed = WebViewRelay.fetch(request)
            if (relayed != null && webViewRelayResponseIsUsable(
                    relayed.code,
                    relayed.header("cf-mitigated"),
                )
            ) {
                return relayed
            }
            // The browser session expired or the relay failed. Stop routing this
            // host through it and let the normal response below re-enter challenge
            // classification so the native app can solve again.
            relayed?.close()
            WebViewRelay.disableForHost(host)
        }

        // If we've already solved this host, keep sending the solver's UA so the
        // stored cf_clearance cookie is accepted.
        solvedUserAgent[host]?.let { userAgent ->
            request = request.newBuilder().header("User-Agent", userAgent).build()
        }

        val response = chain.proceed(request)
        if (solvedUserAgent.containsKey(host)) {
            val jarCookies = try {
                sharedCookieJar.loadForRequest(request.url).joinToString(",") { it.name }
            } catch (_: Throwable) { "?" }
            cfDiag(
                "engine retry host=$host code=${response.code} " +
                    "cf-mitigated=${response.header("cf-mitigated")} " +
                    "ua=${request.header("User-Agent")?.takeLast(24)} " +
                    "jarCookies=[$jarCookies]"
            )
        }
        // Escalate on ANY 403/503 — either a JS challenge (has CF markers) OR a hard
        // datacenter-IP block (e.g. MangaFire on claw returns a bare 403 with no
        // challenge markers). Both mean "this server IP can't get through" → the fix
        // is the same: reach the site from a different (residential) egress.
        if (response.code != 403 && response.code != 503) {
            blockedUntil.remove(host) // recovered
            challengedHosts.remove(host.lowercase())
            return response
        }
        // During a broad search, never *solve* CF — a fan-out must not pin the VM with
        // hundreds of Chrome solves, nor pull a user's phone into relaying for sources
        // they never asked for. It gates only those expensive paths, NOT the residential
        // proxy below: that is a single cheap request over an already-open SOCKS hop, and
        // skipping it made every datacenter-IP-blocked source (MangaFire) return zero
        // search results while its details page — same host, same block — worked fine.
        val searchFanout = searchFanoutActive.get() > 0
        // Fail fast for hosts we already know we can't get through — no re-solve churn.
        if (hostBlocked(host)) return response
        // Classify like nyora-android's CloudFlareHelper: a solvable interactive/JS
        // challenge is distinct from a hard "you have been blocked" page. A WebView can
        // beat the former but never the latter, so only the former should pop the browser.
        val protection = cfProtection(response)
        val challenge = protection == CfProtection.CHALLENGE
        if (protection == CfProtection.CHALLENGE || protection == CfProtection.BLOCKED) {
            noteChallenged(host)
        }

        // 1) Native solve: hand the challenge to the host app's own WebView (macOS WKWebView).
        //    It solves on the user's real IP — passively first, and interactively if Turnstile
        //    wants a click — then POSTs the cf_clearance to /cloudflare/clearance and retries.
        //
        //    With a native WebView we escalate BOTH a solvable CHALLENGE *and* a hard
        //    "you have been blocked" page, matching nyora-android (its WebView always tries).
        //    A JVM OkHttp request is frequently refused where a real Safari WebView on the same
        //    residential IP loads fine — the block keys off this process's TLS fingerprint /
        //    reputation, not the user. If the WebView is genuinely blocked too, the user closes
        //    it and we fall through / back off. (FlareSolverr + proxy paths below keep the
        //    stricter CHALLENGE-only gate: a headless solve can't beat a hard block.)
        if (!searchFanout && nativeSolver && (protection == CfProtection.CHALLENGE || protection == CfProtection.BLOCKED)) {
            response.close()
            throw IOException("Cloudflare challenge: $host")
        }

        // 1b) Server-side solve: classic "Just a moment" JS challenges (cheap, fast).
        //     Headless-Chrome path, for hosts with no native WebView (the cluster).
        if (!searchFanout && challenge) {
            val solution = FlareSolverr.solve(request.url.toString())
            if (solution != null) {
                response.close()
                injectClearanceCookies(host, solution.cookieHeader)
                solvedUserAgent[host] = solution.userAgent
                val retried = chain.proceed(
                    request.newBuilder().header("User-Agent", solution.userAgent).build(),
                )
                if (retried.code != 403 && retried.code != 503) return retried

                // The clearance did not survive the hop. Cloudflare binds cf_clearance to
                // the TLS fingerprint that earned it, and OkHttp's is not Chrome's, so for
                // a growing number of sites replaying the cookie is simply refused — the
                // retry comes back 403 even though the solve succeeded.
                //
                // FlareSolverr already has the page: its own Chrome loaded it to clear the
                // challenge. Hand that body back rather than throwing away a good fetch.
                // GET only, since that is all `request.get` performs.
                retried.close()
                if (request.method == "GET" && solution.status in 200..299 && solution.body.isNotBlank()) {
                    blockedUntil.remove(host)
                    return solvedResponse(request, solution)
                }
                return chain.proceed(request.newBuilder().header("User-Agent", solution.userAgent).build())
            }
        }

        // 2) Residential-proxy egress: some sources (e.g. MangaFire) block ALL
        //    datacenter IPs at the edge — they only serve residential IPs. Retry via
        //    a user-supplied residential proxy. No-op unless NYORA_RESIDENTIAL_PROXY
        //    is set. Works for every client (web + iOS) transparently.
        if (ResidentialProxy.isConfigured) {
            val proxied = ResidentialProxy.fetch(request)
            if (proxied != null && proxied.code != 403 && proxied.code != 503) {
                response.close()
                return proxied
            }
            proxied?.close()
        }

        // Nothing got through — remember this host as blocked so we fail fast next
        // time instead of re-solving it on every search. Only when we actually
        // exhausted every path: during a search fan-out the solves were skipped by
        // design, so recording a block would wrongly suppress them for the next
        // *detail* request too (blockTtlMs is 10 min — long enough to matter).
        if (!searchFanout) blockedUntil[host] = System.currentTimeMillis() + blockTtlMs
        return response
    }

    /** Wraps a FlareSolverr-fetched page as if the request itself had returned it. */
    private fun solvedResponse(request: Request, solution: FlareSolverr.Solution): Response =
        Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(solution.status)
            .message("OK (flaresolverr)")
            .header("Content-Type", "text/html; charset=utf-8")
            .body(solution.body.toResponseBody("text/html; charset=utf-8".toMediaTypeOrNull()))
            .build()

    private enum class CfProtection { NONE, CHALLENGE, BLOCKED }

    /**
     * Classify a response's Cloudflare protection, ported from nyora-android's
     * CloudFlareHelper.checkResponseForProtection so desktop and Android agree on what is
     * solvable. Only 403/503 from a Cloudflare edge is considered; `cf-mitigated: challenge`
     * is the definitive modern signal; a "you have been blocked" page is a hard BLOCK that a
     * WebView cannot beat (only a different egress can), so it is kept distinct from the
     * interactive/JS CHALLENGE that the WebView solves.
     */
    private fun cfProtection(response: Response): CfProtection {
        if (response.code != 403 && response.code != 503) return CfProtection.NONE
        val cfRay = response.header("cf-ray")
        val server = response.header("server")
        val cfMitigated = response.header("cf-mitigated")
        val isCloudflare = cfRay != null ||
            server?.contains("cloudflare", ignoreCase = true) == true ||
            cfMitigated != null
        if (!isCloudflare) return CfProtection.NONE
        if (cfMitigated?.contains("challenge", ignoreCase = true) == true) return CfProtection.CHALLENGE
        val body = try {
            response.peekBody(64 * 1024).string()
        } catch (_: Throwable) {
            return CfProtection.NONE
        }
        val lower = body.lowercase()
        return when {
            // Hard block ("Sorry, you have been blocked …") — unsolvable by a browser.
            "blocked_why_headline" in body || "cf-error-details" in lower -> CfProtection.BLOCKED
            // Solvable interactive / managed / legacy-JS challenge.
            "just a moment" in lower ||
                "__cf_chl_opt" in lower ||
                "cf-browser-verification" in lower ||
                "challenge-error-title" in lower ||
                "challenge-platform" in lower ||
                "cf-chl" in lower ||
                "enable javascript and cookies" in lower -> CfProtection.CHALLENGE
            else -> CfProtection.NONE
        }
    }
}
