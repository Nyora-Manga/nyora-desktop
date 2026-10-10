package com.nyora.hasan72341.shared.net

import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import java.io.IOException
import java.net.InetAddress
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import kotlinx.coroutines.asContextElement
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicReference
import okhttp3.CookieJar
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.ForwardingSink
import okio.buffer

/** Chromium owns source cookies and the actual upstream connection; the JVM never replays either. */
class DesktopSourceRelay(endpoint: String, private val token: String) {
    private val endpoint = validateConfiguration(endpoint, token).endpoint
    // No helper CF/proxy/cookie interceptors on this authenticated local connection.
    private val transport = OkHttpClient.Builder().proxy(java.net.Proxy.NO_PROXY).cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(3, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS).build()
    private val clients = ConcurrentHashMap<Pair<OkHttpClient, String>, OkHttpClient>()

    fun sourceClient(base: OkHttpClient, sourceId: String): OkHttpClient {
        require(sourceId.matches(Regex("data:[a-z0-9][a-z0-9._-]*"))) { "Canonical source identity is required for desktop relay" }
        return clients.getOrPut(base to sourceId) {
            base.newBuilder().apply {
                // Return before cookie, Cloudflare, residential proxy or other JVM transport.
                interceptors().add(0, Interceptor { chain -> fetch(sourceId, chain.request(), chain.call()) })
            }.build()
        }
    }

    // Some engines treat optional metadata errors as empty data. Carry failures with the
    // coroutine operation, including Dispatchers.IO hops, so challenges cannot become success.
    internal suspend fun <T> sourceOperation(block: suspend () -> T): T {
        val failures = AtomicReference<IOException?>()
        val result = withContext(OPERATION_FAILURE.asContextElement(failures)) { block() }
        failures.get()?.let { throw it }
        return result
    }

    internal fun guardEngine(engine: app.nyora.data.engine.SourceEngine): app.nyora.data.engine.SourceEngine =
        object : app.nyora.data.engine.SourceEngine by engine {
            override suspend fun getPopular(page: Int) = sourceOperation { engine.getPopular(page) }
            override suspend fun getLatest(page: Int) = sourceOperation { engine.getLatest(page) }
            override suspend fun search(page: Int, query: String?, filter: app.nyora.core.model.MangaListFilter) = sourceOperation { engine.search(page, query, filter) }
            override suspend fun getAvailableTags() = sourceOperation { engine.getAvailableTags() }
            override suspend fun getDetails(manga: app.nyora.core.model.Manga) = sourceOperation { engine.getDetails(manga) }
            override suspend fun getPageList(chapter: app.nyora.core.model.MangaChapter) = sourceOperation { engine.getPageList(chapter) }
            override suspend fun getPageImageUrl(page: app.nyora.core.model.MangaPage) = sourceOperation { engine.getPageImageUrl(page) }
            override suspend fun resolvePageImageRequest(page: app.nyora.core.model.MangaPage) = sourceOperation { engine.resolvePageImageRequest(page) }
        }

    private fun fetch(sourceId: String, request: Request, parentCall: okhttp3.Call): Response {
        try {
            assertPublicTarget(request.url.toString())
            if (request.method !in setOf("GET", "POST") ||
                request.url.pathSegments.any { it.lowercase() in ACCOUNT_PATHS } ||
                request.url.queryParameterNames.any { it.lowercase() in CREDENTIAL_FIELDS }) {
                throw IOException("desktop_relay_request_denied sourceId=$sourceId")
            }
            val requestBody = request.body
            if (requestBody != null && (requestBody.isDuplex() || requestBody.isOneShot() || requestBody.contentLength() > MAX_REQUEST_BYTES)) {
                throw IOException("desktop_relay_body_denied sourceId=$sourceId")
            }
            val bytes = requestBody?.let { body ->
                val output = Buffer()
                val sink = object : ForwardingSink(output) {
                    override fun write(source: Buffer, byteCount: Long) {
                        if (output.size + byteCount > MAX_REQUEST_BYTES) throw IOException("desktop_relay_body_denied sourceId=$sourceId")
                        super.write(source, byteCount)
                    }
                }.buffer()
                body.writeTo(sink)
                sink.flush()
                output.readByteArray()
            }
            if ((bytes?.size ?: 0) > MAX_REQUEST_BYTES) throw IOException("desktop_relay_body_denied sourceId=$sourceId")
            if (request.method == "POST" && !isReadOnlyPost(sourceId, request, bytes ?: byteArrayOf())) {
                throw IOException("desktop_relay_post_denied sourceId=$sourceId")
            }
            val payload = buildJsonObject {
                put("sourceId", sourceId); put("url", request.url.toString()); put("method", request.method)
                putJsonObject("headers") {
                    for (name in request.headers.names()) {
                        val value = request.header(name).orEmpty()
                        if (name.lowercase() in SAFE_HEADERS &&
                            (!name.equals("X-Requested-With", true) || value == "XMLHttpRequest")) put(name, value)
                    }
                }
                if (bytes != null) {
                    put("bodyBase64", Base64.getEncoder().encodeToString(bytes))
                    requestBody?.contentType()?.let { put("bodyContentType", it.toString()) }
                }
            }
            val localRequest = Request.Builder().url(endpoint).header("Authorization", "Bearer $token")
                .post(payload.toString().toRequestBody("application/json".toMediaType())).build()
            if (parentCall.isCanceled()) throw IOException("Canceled")
            val localCall = transport.newCall(localRequest)
            // Bound cancellation independently of a slow Chromium response.
            val watcher = CANCELLATION_WATCHER.scheduleAtFixedRate({ if (parentCall.isCanceled()) localCall.cancel() }, 0, 100, TimeUnit.MILLISECONDS)
            val responseJson = try {
                localCall.execute().use { response ->
                    if (!response.isSuccessful) throw IOException("desktop_relay_unavailable sourceId=$sourceId")
                    val body = response.body ?: throw IOException("desktop_relay_invalid_response sourceId=$sourceId")
                    if (body.contentLength() > MAX_RESPONSE_JSON_BYTES) throw IOException("desktop_relay_response_too_large sourceId=$sourceId")
                    val raw = body.byteStream().use { it.readNBytes(MAX_RESPONSE_JSON_BYTES + 1) }
                    if (raw.size > MAX_RESPONSE_JSON_BYTES) throw IOException("desktop_relay_response_too_large sourceId=$sourceId")
                    Json.parseToJsonElement(String(raw, StandardCharsets.UTF_8)).jsonObject
                }
            } finally { watcher.cancel(false) }
            val status = responseJson["status"]?.jsonPrimitive?.intOrNull
                ?.takeIf { it in 200..599 } ?: throw IOException("desktop_relay_invalid_response sourceId=$sourceId")
            val headers = responseJson["headers"]?.jsonObject ?: throw IOException("desktop_relay_invalid_response sourceId=$sourceId")
            val encoded = responseJson["bodyBase64"]?.jsonPrimitive?.contentOrNull
                ?: throw IOException("desktop_relay_invalid_response sourceId=$sourceId")
            val content = Base64.getDecoder().decode(encoded)
            if (content.size > MAX_CONTENT_BYTES) throw IOException("desktop_relay_response_too_large sourceId=$sourceId")
            fun header(key: String): String? = headers.entries.firstOrNull { it.key.equals(key, true) }?.value?.jsonPrimitive?.contentOrNull
            val contentType = header("content-type")
            val mitigation = header("cf-mitigated")
            if (mitigation?.contains("challenge", true) == true || isChallengeHtml(content, contentType)) {
                val origin = request.url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString()
                throw IOException("verification_required sourceId=$sourceId origin=$origin")
            }
            return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("Chromium source response")
                .apply {
                    contentType?.let { header("Content-Type", it) }
                    mitigation?.let { header("cf-mitigated", it) }
                }.body(content.toResponseBody(contentType?.toMediaTypeOrNull())).build()
        } catch (failure: IOException) {
            // Never fall through to the JVM client after a relay failure.
            val problem = if (failure.message.orEmpty().let { "desktop_relay_" in it || "verification_required" in it }) failure
                else IOException("desktop_relay_unavailable sourceId=$sourceId", failure)
            OPERATION_FAILURE.get()?.compareAndSet(null, problem)
            throw problem
        } catch (_: Exception) {
            val problem = IOException("desktop_relay_invalid_response sourceId=$sourceId")
            OPERATION_FAILURE.get()?.compareAndSet(null, problem)
            throw problem
        }
    }

    private fun isReadOnlyPost(sourceId: String, request: Request, bytes: ByteArray): Boolean {
        val entry = DataDrivenCatalog.find(sourceId) ?: return false
        if (entry.engineKey != "madara" || request.url.host != URI(entry.source.baseUrl).host || request.url.encodedQuery != null) return false
        if (request.body?.contentType()?.toString()?.substringBefore(';') != "application/x-www-form-urlencoded") return false
        if (request.url.encodedPath.endsWith("/ajax/chapters/") && bytes.isEmpty()) return true
        if (request.url.encodedPath != "/wp-admin/admin-ajax.php") return false
        val fields = String(bytes, StandardCharsets.UTF_8).split('&').map { field ->
            URLDecoder.decode(field.substringBefore('='), StandardCharsets.UTF_8) to
                URLDecoder.decode(field.substringAfter('=', ""), StandardCharsets.UTF_8)
        }
        if (fields.any { it.first.lowercase().contains("password") || it.first.lowercase() in CREDENTIAL_FIELDS + setOf("token", "username", "email", "login") }) return false
        return fields.filter { it.first == "action" }.map { it.second }.singleOrNull() in setOf("madara_load_more", "manga_get_chapters")
    }

    companion object {
        private val OPERATION_FAILURE = ThreadLocal<AtomicReference<IOException?>?>()
        private val CANCELLATION_WATCHER = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "nyora-relay-cancellation").apply { isDaemon = true }
        }
        private const val MAX_REQUEST_BYTES = 1024 * 1024
        private const val MAX_CONTENT_BYTES = 16 * 1024 * 1024
        private const val MAX_RESPONSE_JSON_BYTES = 24 * 1024 * 1024
        private val SAFE_HEADERS = setOf("accept", "accept-language", "content-type", "referer", "range", "cache-control", "pragma", "x-requested-with")
        private val CREDENTIAL_FIELDS = setOf("password", "passwd", "access_token", "refresh_token", "authorization", "client_secret")
        private val ACCOUNT_PATHS = setOf("login", "signin", "register", "account", "auth", "oauth", "logout", "reset-password")

        /** Validated launch configuration without constructing a client or opening a connection. */
        class Configuration internal constructor(val endpoint: String, internal val token: String)

        private fun validateConfiguration(endpoint: String, token: String): Configuration {
            val uri = try { URI(endpoint) } catch (error: java.net.URISyntaxException) {
                throw IllegalArgumentException("Desktop relay endpoint is invalid", error)
            }
            require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1024..65535 &&
                uri.rawPath == "/fetch" && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
                "Desktop relay must use a private 127.0.0.1 /fetch listener"
            }
            require(token.matches(Regex("[A-Za-z0-9_-]{32,256}"))) { "Desktop relay credential is invalid" }
            return Configuration(uri.toString(), token)
        }

        fun configurationFromEnvironment(isolated: Boolean = HelperProfile.isolated, environment: Map<String,String> = System.getenv()): Configuration? {
            if (!isolated) return null
            val endpoint = environment["NYORA_DESKTOP_RELAY_URL"]
            val token = environment["NYORA_DESKTOP_RELAY_TOKEN"]
            if (endpoint == null && token == null) return null
            require(!endpoint.isNullOrBlank() && !token.isNullOrBlank()) { "Desktop relay requires endpoint and credential together" }
            return validateConfiguration(endpoint, token)
        }

        fun fromEnvironment(isolated: Boolean = HelperProfile.isolated, environment: Map<String,String> = System.getenv()): DesktopSourceRelay? {
            val configuration = configurationFromEnvironment(isolated, environment) ?: return null
            return DesktopSourceRelay(configuration.endpoint, configuration.token)
        }

        /** Electron separately enforces approved source origins, DNS results and every redirect hop. */
        fun assertPublicTarget(raw: String) {
            val uri = URI(raw)
            val host = uri.host?.trim('[', ']')?.lowercase() ?: throw IOException("desktop_relay_target_denied")
            if (uri.scheme != "https" || uri.rawUserInfo != null || uri.rawFragment != null ||
                uri.port !in setOf(-1,443) || host == "localhost" || !host.contains('.') && !host.contains(':') ||
                listOf(".localhost", ".local", ".internal", ".lan").any(host::endsWith)) {
                throw IOException("desktop_relay_target_denied")
            }
            if (host.contains(':') || host.all { it.isDigit() || it == '.' }) {
                val address = InetAddress.getByName(host)
                val bytes = address.address
                val cgn = bytes.size == 4 && (bytes[0].toInt() and 255) == 100 && (bytes[1].toInt() and 255) in 64..127
                val uniqueV6 = bytes.size == 16 && (bytes[0].toInt() and 254) == 252
                if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress || address.isMulticastAddress || cgn || uniqueV6) {
                    throw IOException("desktop_relay_target_denied")
                }
            }
        }

        private fun isChallengeHtml(bytes: ByteArray, contentType: String?): Boolean {
            val text = String(bytes, 0, minOf(bytes.size, 64 * 1024), StandardCharsets.UTF_8).lowercase()
            val html = contentType?.contains("html", true) == true || text.trimStart().startsWith("<")
            return html && ("challenge-platform" in text || "cf-chl-" in text ||
                "<title>just a moment" in text || "cf-turnstile" in text && "challenge" in text)
        }
    }
}
