package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.SourcePatches
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.NYORA_BROWSER_UA
import com.nyora.hasan72341.shared.net.buildOkHttpClient
import com.nyora.hasan72341.shared.net.sharedCookieJar
import okhttp3.CookieJar
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import org.koitharu.kotatsu.parsers.MangaLoaderContext
import org.koitharu.kotatsu.parsers.bitmap.Bitmap
import org.koitharu.kotatsu.parsers.config.ConfigKey
import org.koitharu.kotatsu.parsers.config.MangaSourceConfig
import org.koitharu.kotatsu.parsers.model.MangaSource as LibMangaSource

/**
 * Non-Android JVM host for the native Kotatsu parser library (kotatsu-parsers-redo).
 *
 * Only [evaluateJs] (used by ~12 obfuscated sources) and the [Bitmap] methods (used by
 * ~7 image-descrambling sources) are platform-coupled in the reference Android impl;
 * everything else is plain OkHttp + Jsoup which run unchanged on the desktop JVM.
 *
 * - [httpClient]/[cookieJar] reuse the shared OkHttp stack + [sharedCookieJar], so a
 *   `cf_clearance` solved by the app's WebView (POSTed to /cloudflare/clearance) is sent
 *   on native-parser requests too.
 * - [getConfig] returns each [ConfigKey]'s default (so a parser's primary domain resolves
 *   from `ConfigKey.Domain.defaultValue` without any persistent config store).
 * - [evaluateJs] runs the script in a throwaway GraalVM JS context (no DOM/localStorage),
 *   which covers the plain-ECMAScript cases (e.g. slowAES); browser-context scripts return null.
 */
class KotatsuLoaderContext(
    private val networkConfig: HelperNetworkConfig,
) : MangaLoaderContext() {

    // kotatsu-parsers' AbstractMangaParser implements okhttp3.Interceptor and expects
    // the host to apply it (parsers override intercept() to add per-request headers —
    // e.g. the *Lib family sets Site-Id/Authorization there). But OkHttpWebClient uses
    // context.httpClient directly and never adds the parser, so those headers were
    // silently dropped (which broke MangaLib/HentaiLib once cdnlibs began requiring
    // Site-Id). We splice a delegating interceptor that runs the bound parser's
    // intercept() at request time; KotatsuParserExtensionService binds it right after
    // the parser is constructed. Default AbstractMangaParser.intercept() is a no-op
    // passthrough, so binding any parser is safe.
    @Volatile
    private var parserInterceptor: Interceptor? = null

    fun bindParser(instance: Any?) {
        // newParserInstance returns a MangaParserWrapper whose own intercept() only
        // merges getRequestHeaders() and never calls the wrapped parser's intercept()
        // override — which is where the *Lib family sets Site-Id/Authorization. Unwrap
        // to the real delegate so its intercept() actually runs.
        parserInterceptor = unwrapDelegate(instance) as? Interceptor
    }

    private fun unwrapDelegate(instance: Any?): Any? {
        if (instance == null) return null
        return try {
            val field = instance.javaClass.getDeclaredField("delegate")
            field.isAccessible = true
            field.get(instance) ?: instance
        } catch (_: Throwable) {
            instance
        }
    }

    override val httpClient: OkHttpClient by lazy {
        buildOkHttpClient(networkConfig.snapshot()).newBuilder()
            .apply { if (System.getenv("NYORA_DEBUG_HTTP") != null) addInterceptor(DebugHttpInterceptor) }
            .addInterceptor(RedirectedPostInterceptor)
            .addInterceptor(MadaraChapterFix)
            .addInterceptor(Interceptor { chain -> parserInterceptor?.intercept(chain) ?: chain.proceed(chain.request()) })
            .build()
    }

    override val cookieJar: CookieJar
        get() = sharedCookieJar

    override fun getDefaultUserAgent(): String = NYORA_BROWSER_UA

    override fun getConfig(source: LibMangaSource): MangaSourceConfig = OverrideSourceConfig(source)

    // JS evaluation intentionally unsupported — GraalVM/Truffle was dropped to keep the
    // hosted helper small (<500 MB) and fast to start. Only ~12 obfuscated sources call
    // this (mostly needing a real browser DOM that a bare JS engine can't provide anyway),
    // and the mangareader family only uses it on the NetShield anti-bot recovery branch.
    @Deprecated("Provide a base url")
    override suspend fun evaluateJs(script: String): String? = null

    override suspend fun evaluateJs(baseUrl: String, script: String, timeout: Long): String? = null

    // Image descrambling is unsupported on this host (only ~7 niche sources use it).
    override fun redrawImageResponse(response: Response, redraw: (image: Bitmap) -> Bitmap): Response = response

    override fun createBitmap(width: Int, height: Int): Bitmap =
        throw UnsupportedOperationException("Bitmap descrambling is not supported on this JVM host")

    /**
     * Returns each key's compiled-in default, EXCEPT [ConfigKey.Domain]: for a source whose baked-in
     * domain is dead and has moved, [SourcePatches.DOMAIN_OVERRIDES] supplies the current live domain
     * (keyed by the upstream MangaParserSource.name). This is what makes relocated sources work — the
     * parser then requests, and absolutizes page URLs against, the live domain. Mirrors the Nyora Mihon
     * extension's OverrideSourceConfig; previously getConfig always returned defaults, leaving
     * DOMAIN_OVERRIDES inert.
     */
    private class OverrideSourceConfig(private val source: LibMangaSource) : MangaSourceConfig {
        @Suppress("UNCHECKED_CAST")
        override fun <T> get(key: ConfigKey<T>): T = when (key) {
            is ConfigKey.Domain -> (SourcePatches.DOMAIN_OVERRIDES[source.name] ?: key.defaultValue) as T
            else -> key.defaultValue
        }
    }
}

/**
 * Dumps outgoing parser requests when NYORA_DEBUG_HTTP is set. Off by default and
 * never installed unless the variable is present, so it costs nothing in normal use.
 */
private object DebugHttpInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val body = (request.body as? okhttp3.FormBody)?.let { form ->
            (0 until form.size).joinToString("&") { "${form.encodedName(it)}=${form.encodedValue(it)}" }
        }
        System.err.println("[http] ${request.method} ${request.url}")
        request.headers.forEach { (name, value) -> System.err.println("[http]   $name: $value") }
        if (body != null) System.err.println("[http]   body: $body")
        val response = chain.proceed(request)
        System.err.println("[http] <- ${response.code} ${request.url}")
        return response
    }
}
