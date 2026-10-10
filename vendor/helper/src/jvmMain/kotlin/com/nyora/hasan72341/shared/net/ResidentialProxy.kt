package com.nyora.hasan72341.shared.net

import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import okhttp3.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * Residential-proxy egress for datacenter-IP-blocked sources.
 *
 * Some sources (e.g. MangaFire) block ALL datacenter IPs at the Cloudflare edge
 * (403/503) regardless of headers or a JS-challenge solve — they only serve
 * residential IPs. The hosted helper runs on a datacenter VM, so it can never
 * reach them directly. This routes a retry through a user-supplied residential
 * proxy so the request egresses from a residential IP.
 *
 * Configure with env NYORA_RESIDENTIAL_PROXY, e.g.:
 *   http://user:pass@host:port   (HTTP/HTTPS proxy, optional basic auth)
 *   socks5://host:port           (SOCKS5, no auth)
 * Unset → this is a no-op (fetch returns null, direct path is used).
 *
 * Used only as a FALLBACK (after a block is detected), so normal sources stay
 * on the fast, free direct path and only blocked ones pay the proxy cost.
 */
object ResidentialProxy {
    private data class Config(
        val proxy: Proxy,
        val user: String?,
        val pass: String?,
    )

    @Volatile private var initialized = false
    @Volatile private var config: Config? = null
    @Volatile private var client: OkHttpClient? = null

    val isConfigured: Boolean
        get() { ensureInit(); return config != null }

    private fun ensureInit() {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            initialized = true
            val raw = System.getenv("NYORA_RESIDENTIAL_PROXY")?.trim().orEmpty()
            if (raw.isEmpty()) return
            config = parse(raw) ?: return
            client = buildClient(config!!)
        }
    }

    private fun parse(raw: String): Config? = try {
        val isSocks = raw.startsWith("socks", ignoreCase = true)
        // Strip scheme, split optional creds@host:port.
        val afterScheme = raw.substringAfter("://", raw)
        val creds = if (afterScheme.contains('@')) afterScheme.substringBeforeLast('@') else null
        val hostPort = afterScheme.substringAfterLast('@')
        val host = hostPort.substringBeforeLast(':')
        val port = hostPort.substringAfterLast(':').toInt()
        val user = creds?.substringBefore(':')
        val pass = creds?.substringAfter(':', "")
        val type = if (isSocks) Proxy.Type.SOCKS else Proxy.Type.HTTP
        Config(Proxy(type, InetSocketAddress(host, port)), user?.takeIf { it.isNotEmpty() }, pass?.takeIf { it.isNotEmpty() })
    } catch (_: Throwable) { null }

    private fun buildClient(cfg: Config): OkHttpClient {
        // Deliberately does NOT add CloudflareInterceptor (would recurse). Keeps the
        // browser headers + shared cookie jar for consistency.
        val b = OkHttpClient.Builder()
            .proxy(cfg.proxy)
            .followRedirects(true)
            .followSslRedirects(true)
            .cookieJar(sharedCookieJar)
            .addInterceptor(BrowserHeadersInterceptor)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .callTimeout(120, TimeUnit.SECONDS)
        if (cfg.user != null && cfg.pass != null && cfg.proxy.type() == Proxy.Type.HTTP) {
            val cred = Credentials.basic(cfg.user, cfg.pass)
            b.proxyAuthenticator { _, response ->
                if (response.request.header("Proxy-Authorization") != null) null // already tried
                else response.request.newBuilder().header("Proxy-Authorization", cred).build()
            }
        }
        return b.build()
    }

    /**
     * Replay [request] through the residential proxy. Returns the proxied response,
     * or null when no proxy is configured or the attempt errors (caller keeps the
     * original blocked response).
     */
    fun fetch(request: Request): Response? {
        ensureInit()
        val c = client ?: return null
        return try {
            c.newCall(request.newBuilder().build()).execute()
        } catch (_: Throwable) {
            null
        }
    }
}
