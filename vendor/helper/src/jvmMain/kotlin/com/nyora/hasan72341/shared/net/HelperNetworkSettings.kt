package com.nyora.hasan72341.shared.net

import java.net.InetAddress
import java.net.InetSocketAddress
import java.io.IOException
import java.net.Proxy
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlinx.serialization.Serializable
import okhttp3.Dispatcher
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.dnsoverhttps.DnsOverHttps

@Serializable
data class HelperNetworkSettings(
    val proxyType: String = "direct",
    val proxyAddress: String = "127.0.0.1",
    val proxyPort: Int = 8080,
    val dnsOverHttps: String = "none",
    val githubMirror: String = "KEIYOUSHI",
    val imagesProxy: String = "none",
    val sslBypass: Boolean = false,
    val disableConnectivityCheck: Boolean = false,
)

class HelperNetworkConfig(
    initial: HelperNetworkSettings = HelperNetworkSettings(),
    internal val desktopRelay: DesktopSourceRelay? = DesktopSourceRelay.fromEnvironment(),
) {
    internal val usesDesktopRelay: Boolean get() = desktopRelay != null

    internal fun sourceHttpClient(sourceId: String, blockPrivateHosts: Boolean = false): OkHttpClient {
        val base = sharedHttpClient(blockPrivateHosts)
        return desktopRelay?.sourceClient(base, sourceId) ?: base
    }

    @Volatile
    private var current = initial.normalized()
    @Volatile
    private var regularClient: CachedClient? = null
    @Volatile
    private var privateFilteringClient: CachedClient? = null

    fun snapshot(): HelperNetworkSettings = current

    fun update(next: HelperNetworkSettings): HelperNetworkSettings {
        current = next.normalized()
        return current
    }

    /**
     * Reuse one connection pool/dispatcher for each normalized settings snapshot. The runtime
     * shares this config across every source, so broad search and browse/details/pages sequences
     * do not allocate an OkHttp client (and executor) per request. A settings update swaps the
     * client lazily on the next request while existing calls finish on their original client.
     */
    internal fun sharedHttpClient(
        blockPrivateHosts: Boolean = false,
        factory: (HelperNetworkSettings, Boolean) -> OkHttpClient = ::buildOkHttpClient,
    ): OkHttpClient {
        val settings = snapshot()
        val cached = if (blockPrivateHosts) privateFilteringClient else regularClient
        if (cached?.settings == settings) return cached.client
        return synchronized(this) {
            val currentSettings = snapshot()
            val currentCached = if (blockPrivateHosts) privateFilteringClient else regularClient
            if (currentCached?.settings == currentSettings) {
                currentCached.client
            } else {
                factory(currentSettings, blockPrivateHosts).also { client ->
                    val replacement = CachedClient(currentSettings, client)
                    if (blockPrivateHosts) privateFilteringClient = replacement else regularClient = replacement
                }
            }
        }
    }

    private data class CachedClient(
        val settings: HelperNetworkSettings,
        val client: OkHttpClient,
    )
}

fun HelperNetworkSettings.normalized(): HelperNetworkSettings {
    val cleanedType = proxyType.lowercase()
    val cleanedGithubMirror = githubMirror.uppercase()
    val cleanedImagesProxy = imagesProxy.lowercase()
    val cleanedDns = dnsOverHttps.lowercase()
    return copy(
        proxyType = when (cleanedType) {
            "http", "socks5" -> cleanedType
            else -> "direct"
        },
        proxyAddress = proxyAddress.trim(),
        proxyPort = proxyPort.coerceIn(1, 65535),
        dnsOverHttps = cleanedDns,
        githubMirror = cleanedGithubMirror,
        imagesProxy = cleanedImagesProxy,
    )
}

fun OkHttpClient.Builder.applyNetworkSettings(
    settings: HelperNetworkSettings,
    blockPrivateHosts: Boolean = false,
): OkHttpClient.Builder {
    buildProxy(settings)?.let { proxy(it) }
    val configuredDns = buildDns(settings)
    when {
        blockPrivateHosts -> dns(SsrfGuard.filteringDns(configuredDns ?: Dns.SYSTEM))
        configuredDns != null -> dns(configuredDns)
    }
    if (settings.sslBypass) {
        val trustAll = trustAllTls()
        sslSocketFactory(trustAll.context.socketFactory, trustAll.manager)
        hostnameVerifier { _, _ -> true }
    }
    return this
}

/**
 * Process-wide session cookie jar. Lets a Cloudflare `cf_clearance` (solved by
 * the app's WebView and POSTed to /cloudflare/clearance) persist across all
 * subsequent parser/image requests for that host.
 */
val sharedCookieJar = com.nyora.hasan72341.shared.parser.SimpleCookieJar()

/** Inject solved-challenge cookies for a host into the shared jar. */
fun injectClearanceCookies(domain: String, cookieHeader: String) {
    val url = ("https://" + domain.removePrefix("https://").removePrefix("http://").trimEnd('/') + "/")
        .toHttpUrlOrNull() ?: return
    sharedCookieJar.put(url, cookieHeader)
}

// Uncap OkHttp's request concurrency: the defaults (maxRequests=64,
// maxRequestsPerHost=5) throttle throughput to a given CDN to 5 parallel
// connections, which bottlenecks image/page streaming. Lift them so the helper
// uses the full available network bandwidth (the physical VM link stays the
// only real ceiling). Overridable via NYORA_MAX_REQUESTS / NYORA_MAX_PER_HOST.
private val unlimitedDispatcher: Dispatcher
    get() = Dispatcher().apply {
        maxRequests = System.getenv("NYORA_MAX_REQUESTS")?.toIntOrNull() ?: 1024
        maxRequestsPerHost = System.getenv("NYORA_MAX_PER_HOST")?.toIntOrNull() ?: 256
    }

fun buildOkHttpClient(
    settings: HelperNetworkSettings,
    // When true, refuse connections to private/reserved/loopback addresses — for the public
    // image proxy, where the target URL is attacker-controlled (SSRF protection). Applied at the
    // DNS layer so it also covers redirect hops and DNS-rebinding.
    blockPrivateHosts: Boolean = false,
): OkHttpClient =
    OkHttpClient.Builder()
        .dispatcher(unlimitedDispatcher)
        .followRedirects(true)
        .followSslRedirects(true)
        .cookieJar(sharedCookieJar)
        // Transparently clear Cloudflare "Just a moment" JS challenges via a local
        // FlareSolverr (127.0.0.1:8191). No-op when FlareSolverr is unreachable.
        .addInterceptor(CloudflareInterceptor)
        // Add browser-consistent headers (client hints + fetch metadata) to every
        // request. Ordered AFTER the CF interceptor so the hints match the final
        // User-Agent (incl. a FlareSolverr-swapped one) and never override a
        // parser's own headers.
        .addInterceptor(BrowserHeadersInterceptor)
        // The *Lib family's API (api.cdnlibs.org) now 404s without a browser
        // Origin/Referer; add them so MangaLib/HentaiLib/… open again.
        .addInterceptor(LibApiHeadersInterceptor)
        // Short connect timeout so dead/unreachable sources fail fast (a broad
        // all-source search must not hang 30s per dead host). Env-tunable.
        .connectTimeout(System.getenv("NYORA_CONNECT_TIMEOUT")?.toLongOrNull() ?: 8, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(120, TimeUnit.SECONDS)
        .applyNetworkSettings(settings, blockPrivateHosts)
        .build()

fun fetchText(
    url: String,
    settings: HelperNetworkSettings,
    headers: Map<String, String> = emptyMap(),
): String {
    val request = Request.Builder()
        .url(url)
        .header("User-Agent", defaultHelperUserAgent())
        .apply { headers.forEach { (key, value) -> header(key, value) } }
        .get()
        .build()
    buildOkHttpClient(settings).newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
            error("Request failed with HTTP ${response.code}")
        }
        return response.body?.string().orEmpty()
    }
}

fun fetchBytes(
    url: String,
    settings: HelperNetworkSettings,
    headers: Map<String, String> = emptyMap(),
    blockPrivateHosts: Boolean = false,
): ByteArray = fetchBytes(
    url = url,
    client = buildOkHttpClient(settings, blockPrivateHosts),
    headers = headers,
)

internal fun fetchBytes(
    url: String,
    client: OkHttpClient,
    headers: Map<String, String> = emptyMap(),
): ByteArray {
    val request = Request.Builder()
        .url(url)
        .header("User-Agent", defaultHelperUserAgent())
        .apply { headers.forEach { (key, value) -> header(key, value) } }
        .get()
        .build()
    client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
            error("Request failed with HTTP ${response.code}")
        }
        // This fetch did not request a range. Never promote a partial upstream
        // response into a complete, cacheable 200 response from the image proxy.
        if (response.code == 206 || response.header("Content-Range") != null) {
            throw IOException("Remote image response was partial")
        }
        val contentType = response.header("Content-Type")?.substringBefore(';')?.trim().orEmpty()
        val allowedMime = contentType.isEmpty() ||
            contentType.startsWith("image/", ignoreCase = true) ||
            contentType.equals("application/octet-stream", ignoreCase = true) ||
            contentType.equals("binary/octet-stream", ignoreCase = true)
        if (!allowedMime) {
            throw IOException("Remote response is not an image")
        }
        val body = response.body ?: throw IOException("Remote image response was empty")
        if (body.contentLength() > REMOTE_IMAGE_MAX_BYTES) {
            throw IOException("Remote image is too large")
        }
        val bytes = body.byteStream().use { it.readNBytes(REMOTE_IMAGE_MAX_BYTES + 1) }
        if (bytes.size > REMOTE_IMAGE_MAX_BYTES) {
            throw IOException("Remote image is too large")
        }
        if (!bytes.hasRecognizedImageSignature()) {
            throw IOException("Remote response is not a recognized image")
        }
        return bytes
    }
}

internal const val REMOTE_IMAGE_MAX_BYTES: Int = 32 * 1024 * 1024

private fun ByteArray.hasRecognizedImageSignature(): Boolean {
    fun startsWith(vararg expected: Int): Boolean = size >= expected.size &&
        expected.indices.all { index -> (this[index].toInt() and 0xff) == expected[index] }
    fun ascii(offset: Int, value: String): Boolean = size >= offset + value.length &&
        value.indices.all { index -> this[offset + index].toInt() == value[index].code }

    if (startsWith(0xff, 0xd8, 0xff)) return true // JPEG
    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return true // PNG
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return true
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return true
    if (startsWith(0x42, 0x4d)) return true // BMP
    if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return true // TIFF
    if (startsWith(0x00, 0x00, 0x01, 0x00)) return true // ICO
    if (startsWith(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a)) return true // JPEG 2000
    if (ascii(4, "ftyp") && size >= 12) {
        val brand = String(this, 8, 4, StandardCharsets.US_ASCII)
        if (brand in setOf("avif", "avis", "mif1", "msf1", "heic", "heix", "hevc", "hevx")) return true
    }
    return false
}

fun rewriteRemoteUrl(url: String, settings: HelperNetworkSettings, kind: RemoteUrlKind = RemoteUrlKind.General): String {
    if (!url.startsWith("http://") && !url.startsWith("https://")) return url
    var rewritten = rewriteGithubUrl(url, settings.githubMirror)
    if (kind == RemoteUrlKind.Image) {
        rewritten = rewriteImageUrl(rewritten, settings.imagesProxy)
    }
    return rewritten
}

/**
 * Canonical browser User-Agent for ALL outbound helper requests.
 *
 * Cloudflare binds a solved `cf_clearance` cookie to the exact User-Agent (and IP)
 * that solved it. The WebView solver (MacCloudflareSolver.userAgent in Swift) and
 * the native parser fetch path (KotatsuLoaderContext.getDefaultUserAgent) both send this
 * Chrome string, so every request that may carry a cf_clearance cookie — page images
 * and covers via [fetchBytes], catalog HTML via [fetchText] — MUST send it too.
 * Using a different UA here (the old "Nyora/1.0" identifier) made Cloudflare reject
 * image/cover loads immediately after a successful challenge solve.
 *
 * Keep this string byte-identical to MacCloudflareSolver.userAgent and BROWSER_UA.
 */
const val NYORA_BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"

fun defaultHelperUserAgent(): String = NYORA_BROWSER_UA

enum class RemoteUrlKind {
    General,
    Image,
}

private fun buildProxy(settings: HelperNetworkSettings): Proxy? {
    if (settings.proxyType == "direct" || settings.proxyAddress.isBlank()) return null
    val type = when (settings.proxyType) {
        "socks5" -> Proxy.Type.SOCKS
        else -> Proxy.Type.HTTP
    }
    return Proxy(type, InetSocketAddress(settings.proxyAddress, settings.proxyPort))
}

private fun buildDns(settings: HelperNetworkSettings): okhttp3.Dns? {
    val provider = settings.dnsOverHttps
    if (provider == "none") return null
    val (endpoint, bootstrapHosts) = when (provider) {
        "cloudflare" -> "https://1.1.1.1/dns-query" to listOf("1.1.1.1", "1.0.0.1")
        "google" -> "https://dns.google/dns-query" to listOf("8.8.8.8", "8.8.4.4")
        "quad9" -> "https://9.9.9.9/dns-query" to listOf("9.9.9.9", "149.112.112.112")
        else -> return null
    }
    val bootstrapClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .apply {
            buildProxy(settings)?.let { proxy(it) }
            if (settings.sslBypass) {
                val trustAll = trustAllTls()
                sslSocketFactory(trustAll.context.socketFactory, trustAll.manager)
                hostnameVerifier { _, _ -> true }
            }
        }
        .build()
    return DnsOverHttps.Builder()
        .client(bootstrapClient)
        .url(endpoint.toHttpUrl())
        .bootstrapDnsHosts(*bootstrapHosts.map(InetAddress::getByName).toTypedArray())
        .includeIPv6(false)
        .post(true)
        .build()
}

private fun rewriteGithubUrl(url: String, mirror: String): String {
    if (mirror == "KEIYOUSHI") return url
    val uri = runCatching { URI.create(url) }.getOrNull() ?: return url
    val host = uri.host?.lowercase() ?: return url
    return when (mirror) {
        "FASTGIT" -> when {
            host == "raw.githubusercontent.com" -> url.replace("https://raw.githubusercontent.com/", "https://raw.fastgit.org/")
            host == "github.com" -> url.replace("https://github.com/", "https://hub.fastgit.xyz/")
            else -> url
        }
        "GHPROXY" -> when {
            host.contains("github.com") || host.contains("githubusercontent.com") -> "https://ghproxy.com/$url"
            else -> url
        }
        else -> url
    }
}

private fun rewriteImageUrl(url: String, proxy: String): String {
    return when (proxy) {
        "weserv" -> {
            val withoutScheme = url.removePrefix("https://").removePrefix("http://")
            "https://images.weserv.nl/?url=${URLEncoder.encode(withoutScheme, StandardCharsets.UTF_8)}"
        }
        "statically" -> {
            val withoutScheme = url.removePrefix("https://").removePrefix("http://")
            "https://cdn.statically.io/img/$withoutScheme"
        }
        else -> url
    }
}

private data class TrustAllTls(
    val context: SSLContext,
    val manager: X509TrustManager,
)

private fun trustAllTls(): TrustAllTls {
    val trustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    val context = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
    }
    return TrustAllTls(context = context, manager = trustManager)
}
