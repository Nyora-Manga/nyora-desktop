package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.HelperMain
import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.download.DownloadFormat
import com.nyora.hasan72341.shared.download.DownloadSettings
import com.nyora.hasan72341.shared.extension.canonicalOpenableMangaSourceRef
import com.nyora.hasan72341.shared.extension.canonicalDataSourceId
import com.nyora.hasan72341.shared.extension.currentDataSourceIdForLegacyParser
import com.nyora.hasan72341.shared.extension.nativeResultSourceRef
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.HelperNetworkSettings
import com.nyora.hasan72341.shared.net.SsrfGuard
import com.nyora.hasan72341.shared.net.buildOkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.SourceGates
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.reader.PageImageLoader
import com.nyora.hasan72341.shared.repository.NyoraBackupRepository
import com.nyora.hasan72341.shared.HelperProfile
import com.sun.net.httpserver.Filter
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpHandler
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.booleanOrNull
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.IDN
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private val dataDrivenCatalogueApplyLock = Any()

private inline fun <T> withSourceMutationTransaction(block: () -> T): T =
    synchronized(dataDrivenCatalogueApplyLock, block)

private const val CATALOGUE_MAX_BYTES = 16 * 1024 * 1024
private const val CATALOGUE_MAX_REDIRECTS = 10
private const val CLOUDFLARE_CLEARANCE_MAX_BYTES = 16 * 1024
private const val BACKUP_MAX_BYTES = 64 * 1024 * 1024
private val LOCAL_MANAGEMENT_PATHS = setOf(
    "/sources/catalogue",
    "/sources/refresh",
    "/sources/install",
    "/sources/uninstall",
    "/sources/pin",
    "/sources/setInstalled",
    "/cloudflare/clearance",
    "/settings/network",
)

internal class ImageFetchLimiter(
    maxInFlight: Int = 6,
    private val waitMillis: Long = 15_000,
) {
    private val permits = java.util.concurrent.Semaphore(maxInFlight, true)

    fun tryAcquire(): AutoCloseable? {
        val acquired = try {
            permits.tryAcquire(waitMillis, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        if (!acquired) return null
        val closed = java.util.concurrent.atomic.AtomicBoolean(false)
        return AutoCloseable {
            if (closed.compareAndSet(false, true)) permits.release()
        }
    }
}

/** Redirects are handled by [downloadCatalogue] so each Location is validated before use. */
internal fun buildCatalogueHttpClient(settings: HelperNetworkSettings): okhttp3.OkHttpClient =
    buildOkHttpClient(settings, blockPrivateHosts = true).newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

internal fun downloadCatalogue(uri: URI, client: okhttp3.OkHttpClient): String {
    val redirectClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    var current = uri
    repeat(CATALOGUE_MAX_REDIRECTS + 1) { redirectCount ->
        require(current.scheme.equals("https", ignoreCase = true) && !current.host.isNullOrBlank()) {
            "Catalogue redirects must use HTTPS"
        }
        SsrfGuard.assertPublicHttpUrl(current.toString())
        val request = Request.Builder().url(current.toString()).get().build()
        val response = redirectClient.newCall(request).execute()
        if (response.code in setOf(300, 301, 302, 303, 307, 308)) {
            val next = response.use {
                val location = requireNotNull(it.header("Location")) {
                    "Catalogue redirect did not include a Location"
                }
                requireNotNull(it.request.url.resolve(location)) { "Catalogue redirect URL is invalid" }
            }
            require(next.isHttps) { "Catalogue redirects must use HTTPS" }
            require(redirectCount < CATALOGUE_MAX_REDIRECTS) { "Too many catalogue redirects" }
            current = next.toUri()
            return@repeat
        }
        response.use {
            // Surface a solvable challenge in the same format the Swift bridge already
            // understands. It opens the local WebView solver, posts the clearance back to
            // `/cloudflare/clearance`, then retries this unchanged local-only request.
            if ((it.code == 403 || it.code == 503) && isCloudflareChallenge(it)) {
                throw java.io.IOException("Cloudflare challenge: ${current.host}")
            }
            if (!it.isSuccessful) error("Catalogue request failed with HTTP ${it.code}")
            val responseBody = requireNotNull(it.body) { "Catalogue response was empty" }
            require(responseBody.contentLength() <= CATALOGUE_MAX_BYTES) {
                "Catalogue exceeds the 16 MiB size limit"
            }
            val bytes = responseBody.byteStream().use { input ->
                input.readNBytes(CATALOGUE_MAX_BYTES + 1)
            }
            require(bytes.size <= CATALOGUE_MAX_BYTES) { "Catalogue exceeds the 16 MiB size limit" }
            return bytes.toString(StandardCharsets.UTF_8)
        }
    }
    error("Too many catalogue redirects")
}

private fun isCloudflareChallenge(response: okhttp3.Response): Boolean {
    val cloudflareEdge = response.header("cf-ray") != null ||
        response.header("cf-mitigated") != null ||
        response.header("server")?.contains("cloudflare", ignoreCase = true) == true
    if (!cloudflareEdge) return false
    if (response.header("cf-mitigated")?.contains("challenge", ignoreCase = true) == true) return true
    val body = runCatching { response.peekBody(64 * 1024).string().lowercase() }.getOrDefault("")
    return "just a moment" in body || "challenge-platform" in body || "cf-chl" in body
}

/**
 * Apply one validated catalogue as a recoverable unit. Repository seeding has no transaction
 * boundary, so a failed apply is compensated by restoring the old in-memory snapshot and
 * reseeding that snapshot. Persistence deliberately happens last and is atomic on disk. Catalogue
 * readers and epoch commits wait outside this unit, so they can never observe provisional entries.
 */
internal fun applyDataDrivenCatalogue(
    remoteJson: String,
    persist: (String) -> Unit,
    reseed: () -> Unit,
    captureSourceRows: (() -> List<MangaSource>)? = null,
    restoreSourceRows: ((List<MangaSource>) -> Unit)? = null,
): List<com.nyora.hasan72341.shared.extension.DataDrivenSource> =
    withSourceMutationTransaction {
        com.nyora.hasan72341.shared.extension.DataDrivenCatalog.withExclusiveApply {
            require((captureSourceRows == null) == (restoreSourceRows == null)) {
                "Source-row checkpoint capture and restore must be configured together"
            }
            val previous = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.snapshot()
            val previousSourceRows = captureSourceRows?.invoke()
            val applied = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.replace(remoteJson)
            try {
                reseed()
                persist(remoteJson)
                applied
            } catch (failure: Exception) {
                com.nyora.hasan72341.shared.extension.DataDrivenCatalog.restore(previous)
                runCatching {
                    if (previousSourceRows != null && restoreSourceRows != null) {
                        restoreSourceRows(previousSourceRows)
                    } else {
                        reseed()
                    }
                }
                    .exceptionOrNull()
                    ?.let(failure::addSuppressed)
                throw failure
            }
        }
    }

/**
 * REST surface for the SwiftUI client.
 *
 * Endpoints (all loopback):
 *
 *  GET    /health
 *  GET    /sources
 *  POST   /sources/refresh
 *  POST   /sources/install?id=
 *  DELETE /sources/uninstall?id=
 *  POST   /sources/pin?id=
 *  GET    /sources/popular?id=&page=
 *  GET    /sources/latest?id=&page=
 *  GET    /sources/search?id=&q=&page=
 *  GET    /manga/details?id=&url=
 *  GET    /manga/pages?id=&url=
 *  GET    /image?u=<url>&h=<header-name>:<value>&h=...
 */
class NyoraRestServer(
    private val facade: NyoraFacade,
    private val catalog: SourceCatalogClient,
    private val installer: ExtensionInstaller,
    private val pageLoader: PageImageLoader = PageImageLoader(),
    private val downloads: com.nyora.hasan72341.shared.download.DownloadManager? = null,
    private val networkConfig: HelperNetworkConfig = HelperNetworkConfig(),
    private val backupRepository: NyoraBackupRepository? = null,
    private val backupAppVersion: String = "2.0.7",
    private val backupPlatform: String = "jvm",
    private val reseedDataDrivenSources: () -> Unit = {},
    private val persistDataDrivenCatalogue: (String) -> Unit = HelperMain::persistDataDrivenCatalogue,
    private val catalogueDownloader: (URI) -> String = { uri ->
        downloadCatalogue(uri, buildCatalogueHttpClient(networkConfig.snapshot()))
    },
    private val host: InetAddress = InetAddress.getLoopbackAddress(),
    // --- Web-mode options (defaults preserve desktop/loopback behaviour) ---
    // Fixed port to bind (0 = ephemeral, as the desktop clients expect).
    private val port: Int = 0,
    // Classpath prefix (e.g. "web") for static UI assets. When set, the
    // catch-all "/" route serves the bundled single-page web app instead of
    // returning JSON. Serving the UI from the same origin as the API is what
    // lets a normal browser talk to the parser without tripping CORS.
    private val staticRoot: String? = null,
    // Remote/fixed-port deployments must opt in explicitly. The desktop helper's
    // default remains an ephemeral listener bound to loopback.
    private val catalogueMutationEnabled: Boolean =
        host.isLoopbackAddress && port == 0 && staticRoot == null,
    // Emit permissive CORS headers on responses. Always on: the hosted API
    // (api.hasanraza.tech) is consumed cross-origin by the web app (and third
    // parties); harmless for the same-origin desktop/localhost helper. Set
    // NYORA_CORS=0 to disable.
    private val corsEnabled: Boolean = System.getenv("NYORA_CORS") != "0",
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = false
    }
    private val isolatedDesktop = HelperProfile.isolated
    private val helperBearer = HelperProfile.bearerToken()
    init {
        require(!isolatedDesktop || (host.isLoopbackAddress && port == 0 && staticRoot == null)) {
            "Isolated helper requires an ephemeral loopback listener without static hosting"
        }
    }
    private val desktopSync = com.nyora.hasan72341.shared.sync.DesktopSyncBridge { action, email, password ->
        when (action) {
            "signIn" -> facade.nyoraSyncSignIn(email, password)
            "register" -> facade.nyoraSyncRegister(email, password)
            "now" -> { facade.nyoraSyncNow(); null }
            else -> error("Unsupported account operation")
        }
    }
    private var server: HttpServer? = null
    private val isLocalDesktopHelper = host.isLoopbackAddress && port == 0 && staticRoot == null

    // Background worker for serve-stale-while-revalidate. SINGLE thread on purpose:
    // a stale Cloudflare-protected source triggers a FlareSolverr (headless Chrome)
    // solve, and firing several at once swamps the small VM. Serializing to one
    // keeps at most one solve in flight. Daemon so it never blocks exit.
    private val backgroundExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "nyora-revalidate").apply { isDaemon = true }
    }
    private val revalidating = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val imageFetchLimiter = ImageFetchLimiter()

    val baseUrl: String
        get() = server?.address?.let { "http://${it.address.hostAddress}:${it.port}" }.orEmpty()

    val isRunning: Boolean
        get() = server != null

    fun start(): String {
        if (server != null) return baseUrl
        val httpServer = HttpServer.create(InetSocketAddress(host, port), 0).apply {
            guardedContext("/health") { respondJson(it, 200, buildJsonObject {
                put("status", "ok")
                if (isolatedDesktop) {
                    put("isolated", true)
                    put("protocol", HelperProfile.PROTOCOL)
                    put("revision", HelperProfile.REVISION)
                    if (networkConfig.usesDesktopRelay) put("sourceTransport", "chromium")
                }
            }) }
            guardedContext("/docs") { handleDocs(it) }
            guardedContext("/openapi.yaml") { handleOpenApiSpec(it) }
            guardedContext("/sources/refresh") { handleRefresh(it) }
            guardedContext("/sources/catalogue") { handleCatalogueRefresh(it) }
            guardedContext("/sources/catalog") { handleCatalog(it) }
            guardedContext("/sources/install") { handleInstall(it) }
            guardedContext("/sources/uninstall") { handleUninstall(it) }
            guardedContext("/sources/pin") { handlePin(it) }
            guardedContext("/sources/setInstalled") { handleSetInstalled(it) }
            guardedContext("/sources/filters") { handleFilters(it) }
            guardedContext("/sources/popular") { handleBrowse(it, BrowseMode.POPULAR) }
            guardedContext("/sources/latest") { handleBrowse(it, BrowseMode.LATEST) }
            guardedContext("/sources/search") { handleBrowse(it, BrowseMode.SEARCH) }
            guardedContext("/cloudflare/clearance") { handleCloudflareClearance(it) }
            guardedContext("/sources") { handleSources(it) }
            guardedContext("/sources/domain") { handleSourceDomain(it) }
            guardedContext("/manga/details") { handleDetails(it) }
            guardedContext("/manga/pages") { handlePages(it) }
            guardedContext("/image") { handleImage(it) }
            guardedContext("/library/history/record") { handleHistoryRecord(it) }
            guardedContext("/library/history/remove") { handleHistoryRemove(it) }
            guardedContext("/library/history/clear") { handleHistoryClear(it) }
            guardedContext("/library/history") { handleHistory(it) }
            guardedContext("/library/clear") { handleLibraryClear(it) }
            guardedContext("/library/favourites/toggle") { handleFavouriteToggle(it) }
            guardedContext("/library/favourites/check") { handleFavouriteCheck(it) }
            guardedContext("/library/favourites") { handleFavourites(it) }
            guardedContext("/library/bookmarks/add") { handleBookmarkAdd(it) }
            guardedContext("/library/bookmarks/remove") { handleBookmarkRemove(it) }
            guardedContext("/library/bookmarks/check") { handleBookmarkCheck(it) }
            guardedContext("/library/bookmarks") { handleBookmarks(it) }
            guardedContext("/library/updates/refresh") { handleUpdatesRefresh(it) }
            guardedContext("/library/updates/seen") { handleUpdatesSeen(it) }
            guardedContext("/library/updates") { handleUpdates(it) }
            guardedContext("/local/scan") { handleLocalScan(it) }
            guardedContext("/local/chapter") { handleLocalChapter(it) }
            guardedContext("/local/image") { handleLocalImage(it) }
            guardedContext("/search/global") { handleGlobalSearch(it) }
            guardedContext("/library/categories/create") { handleCategoryCreate(it) }
            guardedContext("/library/categories/rename") { handleCategoryRename(it) }
            guardedContext("/library/categories/delete") { handleCategoryDelete(it) }
            guardedContext("/library/categories/add") { handleCategoryAdd(it) }
            guardedContext("/library/categories/remove") { handleCategoryRemove(it) }
            guardedContext("/library/categories/manga") { handleCategoriesForManga(it) }
            guardedContext("/library/categories") { handleCategories(it) }
            guardedContext("/manga/prefs/save") { handleMangaPrefsSave(it) }
            guardedContext("/manga/prefs/clear") { handleMangaPrefsClear(it) }
            guardedContext("/manga/prefs") { handleMangaPrefs(it) }
            guardedContext("/downloads/start") { handleDownloadStart(it) }
            guardedContext("/downloads/enqueue") { handleDownloadEnqueue(it) }
            guardedContext("/downloads/cancel") { handleDownloadCancel(it) }
            guardedContext("/downloads/clear") { handleDownloadClear(it) }
            guardedContext("/downloads/settings") { handleDownloadSettings(it) }
            guardedContext("/settings/network") { handleNetworkSettings(it) }
            guardedContext("/downloads") { handleDownloads(it) }
            guardedContext("/stats") { handleStats(it) }
            guardedContext("/suggestions") { handleSuggestions(it) }
            guardedContext("/manga/alternatives") { handleAlternatives(it) }
            guardedContext("/backup/export") { handleBackupExport(it) }
            guardedContext("/backup/plan") { handleBackupPlan(it) }
            guardedContext("/backup/import") { handleBackupImport(it) }
            guardedContext("/tracker/anilist/search") { handleTrackerSearch(it) }
            guardedContext("/tracker/anilist/scrobble") { handleTrackerScrobble(it) }
            guardedContext("/tracker/myanimelist/search") { handleTrackerSearch(it) }
            guardedContext("/tracker/myanimelist/scrobble") { handleTrackerScrobble(it) }
            guardedContext("/tracker/kitsu/search") { handleTrackerSearch(it) }
            guardedContext("/tracker/kitsu/scrobble") { handleTrackerScrobble(it) }
            guardedContext("/tracker/shikimori/search") { handleTrackerSearch(it) }
            guardedContext("/tracker/shikimori/scrobble") { handleTrackerScrobble(it) }
            guardedContext("/tracker/bangumi/search") { handleTrackerSearch(it) }
            guardedContext("/tracker/bangumi/scrobble") { handleTrackerScrobble(it) }
            guardedContext("/tracker/mangabaka/search") { handleTrackerSearch(it) }
            guardedContext("/tracker/mangabaka/scrobble") { handleTrackerScrobble(it) }
            guardedContext("/tracker/anilist/state") { handleTrackerState(it) }
            guardedContext("/tracker/myanimelist/state") { handleTrackerState(it) }
            guardedContext("/tracker/kitsu/state") { handleTrackerState(it) }
            guardedContext("/tracker/shikimori/state") { handleTrackerState(it) }
            guardedContext("/tracker/bangumi/state") { handleTrackerState(it) }
            guardedContext("/tracker/mangabaka/state") { handleTrackerState(it) }
            // Server-side OAuth login bridge (for web / thin clients).
            guardedContext("/tracker/anilist/authorize") { handleTrackerAuthorize(it) }
            guardedContext("/tracker/anilist/callback") { handleTrackerCallback(it) }
            guardedContext("/tracker/myanimelist/authorize") { handleTrackerAuthorize(it) }
            guardedContext("/tracker/myanimelist/callback") { handleTrackerCallback(it) }
            guardedContext("/tracker/shikimori/authorize") { handleTrackerAuthorize(it) }
            guardedContext("/tracker/shikimori/callback") { handleTrackerCallback(it) }
            guardedContext("/tracker/bangumi/authorize") { handleTrackerAuthorize(it) }
            guardedContext("/tracker/bangumi/callback") { handleTrackerCallback(it) }
            guardedContext("/tracker/mangabaka/authorize") { handleTrackerAuthorize(it) }
            guardedContext("/tracker/mangabaka/callback") { handleTrackerCallback(it) }
            guardedContext("/tracker/kitsu/login") { handleKitsuLogin(it) }
            if (isolatedDesktop) guardedContext("/desktop/sync") { exchange ->
                if (exchange.requestURI.path != "/desktop/sync" || exchange.requestMethod != "POST") {
                    respondError(exchange, 405, "Unsupported account request")
                } else {
                    try {
                        val body = exchange.requestBody.readNBytes(65537)
                        require(body.size <= 65536) { "Account request too large" }
                        val request = json.parseToJsonElement(String(body, StandardCharsets.UTF_8)).jsonObject
                        respondJson(exchange, 200, desktopSync.execute(request))
                    } catch (_: Exception) { respondError(exchange, 400, "Invalid account request") }
                }
            }
            guardedContext("/nyorasync/status") { handleNyoraSyncStatus(it) }
            guardedContext("/nyorasync/signin") { handleNyoraSyncSignIn(it) }
            guardedContext("/nyorasync/register") { handleNyoraSyncRegister(it) }
            guardedContext("/nyorasync/signout") { handleNyoraSyncSignOut(it) }
            guardedContext("/nyorasync/sync") { handleNyoraSync(it) }
            guardedContext("/nyorasync/restore-from-cloud") { handleNyoraSyncRestoreFromCloud(it) }
            guardedContext("/nyorasync/has-local-data") { handleNyoraSyncHasLocalData(it) }
            // Compatibility for released desktop builds. The current public name is
            // `/nyorasync`; these aliases deliberately share the exact same handlers so an
            // engine update cannot strand a client that still uses the former route prefix.
            guardedContext("/supabase/status") { handleNyoraSyncStatus(it) }
            guardedContext("/supabase/signin") { handleNyoraSyncSignIn(it) }
            guardedContext("/supabase/register") { handleNyoraSyncRegister(it) }
            guardedContext("/supabase/signout") { handleNyoraSyncSignOut(it) }
            guardedContext("/supabase/sync") { handleNyoraSync(it) }
            guardedContext("/supabase/restore-from-cloud") { handleNyoraSyncRestoreFromCloud(it) }
            guardedContext("/supabase/has-local-data") { handleNyoraSyncHasLocalData(it) }
            guardedContext("/ota/check") { handleOtaCheck(it) }
            guardedContext("/ota/status") { handleOtaStatus(it) }
            guardedContext("/") { handleRoot(it) }
            executor = newServerExecutor()
            start()
        }
        server = httpServer
        if (!isolatedDesktop) prewarmCache()
        return baseUrl
    }

    /** Authentication precedes all handlers, including preflight, images and unknown paths. */
    private fun HttpServer.guardedContext(path: String, handler: HttpHandler) {
        val context = createContext(path) { exchange ->
            if (isolatedDesktop) {
                val headers = exchange.requestHeaders["Authorization"]
                val expected = "Bearer $helperBearer".toByteArray(StandardCharsets.UTF_8)
                val supplied = headers?.singleOrNull()?.toByteArray(StandardCharsets.UTF_8)
                if (supplied == null || !java.security.MessageDigest.isEqual(expected, supplied)) {
                    exchange.responseHeaders.set("Cache-Control", "no-store")
                    exchange.responseHeaders.set("WWW-Authenticate", "Bearer")
                    respondError(exchange, 401, "Helper authentication required")
                    return@createContext
                }
                val requestPath = exchange.requestURI.path.orEmpty()
                val syncRead = requestPath in setOf(
                    "/nyorasync/status", "/nyorasync/has-local-data",
                    "/supabase/status", "/supabase/has-local-data",
                )
                if (requestPath.startsWith("/tracker/") || requestPath.startsWith("/local/") ||
                    ((requestPath.startsWith("/nyorasync/") || requestPath.startsWith("/supabase/")) && !syncRead)) {
                    respondError(exchange, 503, "This operation is unavailable in isolated desktop mode")
                    return@createContext
                }
            }
            handler.handle(exchange)
        }
        context.filters.add(GuardFilter)
    }

    /** Pre-warm the browse cache for installed sources in the background right
     *  after startup, so the very first user request is already instant (no cold
     *  fetch). Cheap, bounded, best-effort; failures are ignored. Skips keys the
     *  persistent snapshot already restored. Disable with NYORA_PREWARM=0. */
    private fun prewarmCache() {
        // OPT-IN (NYORA_PREWARM=1): on the tiny hosted VM, eagerly fetching many
        // sources at boot triggers a storm of FlareSolverr (Chrome) solves for
        // CF-protected sources and saturates the box. The persistent snapshot +
        // serve-stale already make restarts instant, so pre-warm is off by default.
        if (System.getenv("NYORA_PREWARM") != "1") return
        // ONE low-priority background thread, SEQUENTIAL with a gap between fetches
        // so it never spikes CPU on the small box. Skips any key that already has a
        // cached copy (fresh OR stale) — serve-stale-while-revalidate refreshes
        // those lazily on demand, so after the first snapshot this is a near no-op.
        val t = Thread({
            try {
                val catalogue = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.snapshot()
                val sources = try { facade.listSources().filter { it.isInstalled } } catch (_: Throwable) { emptyList() }
                for (source in sources.take(40)) {
                    for (mode in listOf(BrowseMode.POPULAR, BrowseMode.LATEST)) {
                        val key = "browse:${catalogue.fingerprint}:${mode.name}:${source.id}:1:"
                        if (ResponseCache.peek(key) != null) continue // already cached — leave it to serve-stale
                        try {
                            fetchBrowseBody(source, mode, 1, "", emptyList(), key, catalogue.revision)
                        } catch (_: Throwable) { /* skip */ }
                        try { Thread.sleep(400) } catch (_: InterruptedException) { return@Thread } // gentle pacing
                    }
                }
            } catch (_: Throwable) { /* best-effort */ }
        }, "nyora-prewarm")
        t.isDaemon = true
        t.priority = Thread.MIN_PRIORITY
        t.start()
    }

    fun stop() {
        server?.stop(0)
        server = null
    }

    private fun handleRoot(exchange: HttpExchange) {
        // The retired device-egress relay allowed a remote client to receive and
        // complete parser fetches. Parsing is local-only now; keep these legacy
        // paths closed even when web-mode would otherwise serve the SPA fallback.
        if (exchange.requestURI.path.orEmpty().startsWith("/device/relay/")) {
            respondError(exchange, 404, "Not found")
            return
        }
        // Web mode: the catch-all route serves the bundled single-page app and
        // its static assets straight from the classpath. Anything that isn't a
        // real asset falls back to index.html so client-side routing works.
        if (staticRoot != null) {
            serveStatic(exchange)
            return
        }
        // Only the exact root returns the banner; any other unmatched path is a genuine
        // 404 (previously every unknown path answered 200 with the banner, so clients
        // couldn't tell a typo'd route from a real hit).
        if (exchange.requestURI.path.orEmpty().trim('/').isNotEmpty()) {
            respondError(exchange, 404, "Not found")
            return
        }
        respondJson(exchange, 200, buildJsonObject {
            put("name", "Nyora helper")
            // baseUrl (the internal 127.0.0.1 bind) intentionally omitted — the hosted
            // banner shouldn't advertise the origin's internal address.
        })
    }

    private fun serveStatic(exchange: HttpExchange) {
        applyCors(exchange)
        if (exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) {
            exchange.sendResponseHeaders(204, -1); exchange.close(); return
        }
        val rawPath = exchange.requestURI.path.orEmpty()
        // Normalise and guard against path traversal.
        val rel = rawPath.trimStart('/').substringBefore('?').ifBlank { "index.html" }
        if (rel.contains("..")) { respondText(exchange, 400, "Bad path"); return }
        val loader = javaClass.classLoader
        val prefix = staticRoot!!.trim('/')
        val bytes = loader.getResourceAsStream("$prefix/$rel")?.use { it.readBytes() }
            // SPA fallback for unknown non-asset routes.
            ?: loader.getResourceAsStream("$prefix/index.html")?.use { it.readBytes() }
            ?: return respondText(exchange, 404, "Not found")
        val servedRel = if (loader.getResource("$prefix/$rel") != null) rel else "index.html"
        exchange.responseHeaders.add("Content-Type", staticContentType(servedRel))
        if (servedRel == "index.html") {
            exchange.responseHeaders.add("Cache-Control", "no-cache")
        } else {
            exchange.responseHeaders.add("Cache-Control", "public, max-age=3600")
        }
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun staticContentType(path: String): String = when {
        path.endsWith(".html") -> "text/html; charset=utf-8"
        path.endsWith(".js") || path.endsWith(".mjs") -> "text/javascript; charset=utf-8"
        path.endsWith(".css") -> "text/css; charset=utf-8"
        path.endsWith(".json") -> "application/json; charset=utf-8"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".ico") -> "image/x-icon"
        path.endsWith(".webmanifest") -> "application/manifest+json"
        path.endsWith(".woff2") -> "font/woff2"
        else -> "application/octet-stream"
    }

    /** Serves the embedded OpenAPI 3.1 spec (classpath `openapi.yaml`). */
    private fun handleOpenApiSpec(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val bytes = javaClass.classLoader.getResourceAsStream("openapi.yaml")?.use { it.readBytes() }
            ?: return respondText(exchange, 404, "openapi.yaml not bundled")
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "application/yaml; charset=utf-8")
        exchange.responseHeaders.add("Cache-Control", "no-cache")
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    /** Serves a self-contained Swagger UI page that loads the spec from /openapi.yaml. */
    private fun handleDocs(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val bytes = SWAGGER_UI_HTML.toByteArray(StandardCharsets.UTF_8)
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
        exchange.responseHeaders.add("Cache-Control", "no-cache")
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun applyCors(exchange: HttpExchange) {
        if (isolatedDesktop || !corsEnabled) return
        val headers = exchange.responseHeaders
        if (headers.containsKey("Access-Control-Allow-Origin")) return
        // Response depends on the request Origin, so it must not be cached across origins.
        headers.add("Vary", "Origin")
        val origin = allowedCorsOrigin(exchange) ?: return
        headers.add("Access-Control-Allow-Origin", origin)
        headers.add("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization")
    }

    /** If this is a CORS preflight (OPTIONS), answer it 204 with CORS headers and
     *  return true so the caller stops. Non-simple requests (POST + JSON body)
     *  preflight, so POST handlers must call this before their method check. */
    private fun maybePreflight(exchange: HttpExchange): Boolean {
        if (!exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) return false
        applyCors(exchange)
        exchange.sendResponseHeaders(204, -1)
        exchange.close()
        return true
    }

    /** The live domain (host) of a source — used by the app to open the manual Cloudflare
     *  solver for it (parser sources carry an empty baseUrl, so the app can't derive it). */
    private fun handleSourceDomain(exchange: HttpExchange) {
        val id = exchange.query()["id"] ?: return respondError(exchange, 400, "Missing 'id'")
        val source = facade.listSources().firstOrNull { it.id == id }
            ?: return respondError(exchange, 404, "Unknown source: $id")
        val domain = try { openInstalled(source).domain } catch (_: Exception) { "" }
        respondJson(exchange, 200, buildJsonObject { put("domain", domain) })
    }

    private fun handleSources(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val sources = catalogueFor(exchange, facade.listSources().filter(::isJsParserSource))
        ensureFaviconWarm(sources)
        val withIcons = sources.map { s -> faviconCache[s.id]?.let { s.copy(iconUrl = it) } ?: s }
        respondJson(exchange, 200, json.encodeToJsonElement(SourceListResponse(withIcons)))
    }

    // Favicons for the Explore source grid. A source's real domain only lives on its
    // constructed parser (kotatsu bakes it into a ConfigKey and our overrides may move it),
    // so we resolve it once per source — in the BACKGROUND, off the request path — and cache a
    // favicon URL. Google's favicon service is used so Cloudflare-protected sites still resolve
    // (the icon comes from Google, not the blocked origin). The client falls back to a language
    // badge until the icon is warmed, and re-fetches once so warmed icons appear.
    private val faviconCache = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val faviconWarmStarted = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun ensureFaviconWarm(sources: List<MangaSource>) {
        if (!faviconWarmStarted.compareAndSet(false, true)) return
        val toWarm = sources.filter { !faviconCache.containsKey(it.id) }
        val worker = Thread {
            val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
            try {
                val futures = toWarm.map { src ->
                    pool.submit {
                        val domain = try { openInstalled(src).domain } catch (_: Throwable) { "" }
                        if (domain.isNotBlank()) {
                            faviconCache[src.id] = "https://www.google.com/s2/favicons?sz=64&domain=$domain"
                        }
                    }
                }
                futures.forEach { try { it.get(20, java.util.concurrent.TimeUnit.SECONDS) } catch (_: Throwable) {} }
            } finally {
                pool.shutdownNow()
            }
        }
        worker.isDaemon = true
        worker.name = "nyora-favicon-warm"
        worker.start()
    }

    private fun handleRefresh(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        try {
            withSourceMutationTransaction {
                val library = facade.loadLibrary()
                val existingById = library.sources.associateBy { it.id }
                val jsSources = getJsSources()
                val merged = jsSources.map { src ->
                    val existing = existingById[src.id]
                    if (existing != null) {
                        src.copy(
                            isInstalled = existing.isInstalled,
                            isPinned = existing.isPinned,
                            localPath = src.localPath,
                            installedAt = existing.installedAt,
                        )
                    } else src
                }
                facade.saveLibrary(library.copy(sources = merged))
                val visible = catalogueFor(exchange, facade.listSources().filter(::isJsParserSource))
                respondJson(exchange, 200, json.encodeToJsonElement(SourceListResponse(visible)))
            }
        } catch (error: Exception) {
            respondError(exchange, 500, error.message ?: "Refresh failed")
        }
    }

    private fun getJsSources(): List<com.nyora.hasan72341.shared.model.MangaSource> =
        com.nyora.hasan72341.shared.extension.DataDrivenCatalog.load().map { it.source }

    /** Downloads, validates, persists, and reseeds a remote data-driven catalogue. */
    private fun handleCatalogueRefresh(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange, catalogueMutationEnabled)) return
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val url = runCatching {
            json.parseToJsonElement(exchange.requestBody.readBytes().toString(StandardCharsets.UTF_8))
                .jsonObject["url"]?.jsonPrimitive?.contentOrNull
        }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Expected a JSON object with a catalogue URL")
        val uri = runCatching { URI(url) }.getOrNull()
            ?: return respondError(exchange, 400, "Catalogue URL is invalid")
        if (!uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrBlank()) {
            respondError(exchange, 400, "Catalogue URL must use HTTPS"); return
        }

        val body = try {
            fetchCatalogue(uri)
        } catch (error: Exception) {
            respondError(exchange, 502, error.message ?: "Could not download catalogue"); return
        }
        try {
            applyDataDrivenCatalogue(
                remoteJson = body,
                persist = persistDataDrivenCatalogue,
                reseed = reseedDataDrivenSources,
                captureSourceRows = facade::listSources,
                restoreSourceRows = facade::replaceSources,
            )
        } catch (error: IllegalArgumentException) {
            respondError(exchange, 400, error.message ?: "Invalid data-driven catalogue"); return
        } catch (error: Exception) {
            respondError(exchange, 500, error.message ?: "Could not apply catalogue"); return
        }
        ResponseCache.invalidatePrefix("catalog:")
        invalidateSourceIndex() // stored install/pin flags changed
        ResponseCache.invalidatePrefix("browse:")
        facade.clearChapterPageCache()
        coverResolveAttempted.clear()
        refererBaseCache.clear()
        faviconCache.clear()
        faviconWarmStarted.set(false)
        respondJson(
            exchange,
            200,
            json.encodeToJsonElement(
                SourceListResponse(facade.listSources().filter(::isJsParserSource)),
            ),
        )
    }

    private fun fetchCatalogue(uri: URI): String {
        return catalogueDownloader(uri)
    }

    private fun handleCatalog(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        // Shared edges must not reuse a native catalogue for a browser request.
        exchange.responseHeaders.set("Cache-Control", "no-store")
        val cacheKey = if (isBrowserClient(exchange)) "catalog:solverless" else "catalog:local"
        ResponseCache.get(cacheKey)?.let { respondJsonRaw(exchange, 200, it); return }
        val installed = facade.listSources().filter { it.isInstalled }.map { it.id }.toSet()
        val entries = catalogueFor(exchange, getJsSources()).map { source ->
            CatalogEntry(
                id = source.id,
                name = source.name,
                lang = source.lang,
                engine = source.engine.name,
                contentType = source.contentType.name,
                isBroken = false,
                isInstalled = source.id in installed,
                isNsfw = source.isNsfw,
                supportedFormats = com.nyora.hasan72341.shared.extension.DataDrivenCatalog
                    .find(source.id)?.supportedFormats.orEmpty(),
            )
        }
        val body = json.encodeToString(CatalogResponse.serializer(), CatalogResponse(entries))
        ResponseCache.put(cacheKey, body, 300_000) // 5 min; invalidated on install/uninstall
        respondJsonRaw(exchange, 200, body)
    }

    private fun handleInstall(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange)) return
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        withSourceMutationTransaction {
            ResponseCache.invalidatePrefix("catalog:") // installed flags change
            invalidateSourceIndex() // stored install/pin flags changed
            val id = exchange.query()["id"]
            if (id.isNullOrBlank()) {
                respondError(exchange, 400, "Missing 'id'"); return
            }
            if (!id.startsWith("data:")) {
                respondError(exchange, 404, "Unknown data-driven source: $id"); return
            }
            // Already in DB? Use the existing row (covers JS sources too).
            val existing = facade.listSources().firstOrNull { it.id == id }
            if (existing != null) {
                try {
                    val flipped = existing.copy(
                        isInstalled = true,
                        engine = com.nyora.hasan72341.shared.model.SourceEngine.JavaScript,
                        localPath = "",
                        installedAt = System.currentTimeMillis(),
                    )
                    val installed = facade.installSource(flipped) { it }
                    respondJson(exchange, 200, json.encodeToJsonElement(SourceResponse(installed)))
                } catch (error: Exception) {
                    respondError(exchange, 500, error.message ?: "Install failed")
                }
                return
            }
            // Not in DB yet — accept install for a catalog parser source.
            val jsSource = getJsSources().firstOrNull { it.id == id }
                ?: return respondError(exchange, 404, "Unknown parser source: $id")

            try {
                val sourceToInstall = jsSource.copy(
                    isInstalled = true,
                    installedAt = System.currentTimeMillis()
                )
                val installedResult = facade.installSource(sourceToInstall) { it }
                respondJson(exchange, 200, json.encodeToJsonElement(SourceResponse(installedResult)))
            } catch (error: Exception) {
                respondError(exchange, 500, error.message ?: "Install failed")
            }
        }
    }

    private fun isJsParserSource(source: com.nyora.hasan72341.shared.model.MangaSource): Boolean =
        source.id.startsWith("data:") &&
            source.engine == com.nyora.hasan72341.shared.model.SourceEngine.JavaScript

    private fun handleUninstall(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange)) return
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("DELETE", ignoreCase = true) &&
            !exchange.requestMethod.equals("POST", ignoreCase = true)
        ) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        withSourceMutationTransaction {
            ResponseCache.invalidatePrefix("catalog:") // installed flags change
            invalidateSourceIndex() // stored install/pin flags changed
            val id = exchange.query()["id"]
            if (id.isNullOrBlank()) {
                respondError(exchange, 400, "Missing 'id'"); return
            }
            val source = facade.listSources().firstOrNull { it.id == id }
                ?: return respondError(exchange, 404, "Unknown source: $id")
            if (source.id.startsWith("data:")) {
                try {
                    val uninstalled = facade.installSource(
                        source.copy(isInstalled = false, localPath = "", installedAt = 0),
                    ) { it }
                    respondJson(exchange, 200, json.encodeToJsonElement(SourceResponse(uninstalled)))
                } catch (error: Exception) {
                    respondError(exchange, 500, error.message ?: "Uninstall failed")
                }
                return
            }
            if (!source.canUninstall) {
                respondError(exchange, 409, "Source is built-in and cannot be uninstalled"); return
            }
            try {
                val uninstalled = facade.installSource(source, installer::uninstall)
                respondJson(exchange, 200, json.encodeToJsonElement(SourceResponse(uninstalled)))
            } catch (error: Exception) {
                respondError(exchange, 500, error.message ?: "Uninstall failed")
            }
        }
    }

    private fun handlePin(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val id = exchange.query()["id"]
        if (id.isNullOrBlank()) {
            respondError(exchange, 400, "Missing 'id'"); return
        }
        withSourceMutationTransaction {
            facade.togglePin(id)
            invalidateSourceIndex() // stored pin flag changed
            respondJson(exchange, 200, json.encodeToJsonElement(SourceListResponse(facade.listSources())))
        }
    }

    /**
     * Bulk-replace the installed set: body is a JSON array of source ids. Every source in the
     * list becomes `is_installed = true`, every other becomes false. Lets the macOS app mirror
     * its client-side curated set into the engine DB (in ONE call, no per-source install storm)
     * so Nyora Sync source-prefs sync pushes the user's real installed set.
     */
    private fun handleSetInstalled(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val raw = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
        val ids = runCatching {
            (json.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { it.jsonPrimitive.contentOrNull }?.toSet()
        }.getOrNull() ?: run { respondError(exchange, 400, "Expected a JSON array of ids"); return }
        withSourceMutationTransaction {
            val library = facade.loadLibrary()
            val updated = library.sources.map { it.copy(isInstalled = it.id in ids) }
            facade.saveLibrary(library.copy(sources = updated))
            ResponseCache.invalidatePrefix("catalog:")
            invalidateSourceIndex() // stored install/pin flags changed
            respondJson(
                exchange,
                200,
                json.encodeToJsonElement(
                    SourceListResponse(catalogueFor(exchange, facade.listSources().filter(::isJsParserSource))),
                ),
            )
        }
    }

    private enum class BrowseMode { POPULAR, LATEST, SEARCH }

    /**
     * Receives a Cloudflare clearance solved by the app's WebView:
     *   POST /cloudflare/clearance?domain=example.com
     *   body: "cf_clearance=...; other=..."  (a Cookie header string)
     * Injected into the shared OkHttp cookie jar so subsequent parser/image
     * requests to that host pass the challenge. The WebView must solve with the
     * same User-Agent the helper sends (Chrome 115) so the cookie stays valid.
     */
    private fun handleCloudflareClearance(exchange: HttpExchange) {
        if (networkConfig.usesDesktopRelay) {
            respondError(exchange, 503, "Desktop source sessions do not import helper cookies"); return
        }
        if (!requireLocalManagement(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val domain = normalizeBareHost(exchange.query()["domain"])
        if (domain == null) { respondError(exchange, 400, "Expected 'domain' to be a bare host"); return }
        val declaredLength = exchange.requestHeaders.getFirst("Content-Length")?.toLongOrNull()
        if (declaredLength != null && declaredLength > CLOUDFLARE_CLEARANCE_MAX_BYTES) {
            respondError(exchange, 413, "Cookie body is too large"); return
        }
        val body = exchange.requestBody.use { it.readNBytes(CLOUDFLARE_CLEARANCE_MAX_BYTES + 1) }
        if (body.size > CLOUDFLARE_CLEARANCE_MAX_BYTES) {
            respondError(exchange, 413, "Cookie body is too large"); return
        }
        val cookieHeader = body.toString(Charsets.UTF_8).trim()
        if (cookieHeader.isBlank()) { respondError(exchange, 400, "Missing cookie body"); return }
        com.nyora.hasan72341.shared.net.injectClearanceCookies(domain, cookieHeader)
        // The clearance was obtained by the app's WebView using NYORA_BROWSER_UA. Pin this
        // host to that UA so the retried request presents the same UA the cookie is bound
        // to — otherwise the parser's own UA makes Cloudflare reject the clearance.
        com.nyora.hasan72341.shared.net.CloudflareInterceptor.noteNativeSolve(
            domain,
            com.nyora.hasan72341.shared.net.NYORA_BROWSER_UA,
        )
        // From now on, fetch this host through the WebView relay — the clearance only works
        // from the browser session that solved it, not this JVM's OkHttp.
        com.nyora.hasan72341.shared.net.WebViewRelay.enableForHost(domain)
        // Drop cached browse pages so the next fetch runs fresh through the now-working relay
        // instead of serving whatever was cached (empty/blocked) before the solve.
        ResponseCache.invalidatePrefix("browse:")
        facade.clearChapterPageCache()
        coverResolveAttempted.clear()
        respondJson(exchange, 200, buildJsonObject {
            put("ok", true)
            put("domain", domain)
        })
    }

    private fun normalizeBareHost(raw: String?): String? {
        val value = raw?.takeIf { it.isNotBlank() && it == it.trim() } ?: return null
        if (value.any { it.isISOControl() } || '/' in value || ':' in value || '@' in value ||
            '?' in value || '#' in value
        ) return null
        val ascii = runCatching {
            IDN.toASCII(value.removeSuffix("."), IDN.USE_STD3_ASCII_RULES).lowercase()
        }.getOrNull()?.takeIf { it.isNotBlank() && it.length <= 253 } ?: return null
        val uri = runCatching { URI("https://$ascii/") }.getOrNull() ?: return null
        return ascii.takeIf {
            uri.host.equals(ascii, ignoreCase = true) && uri.userInfo == null && uri.port == -1
        }
    }

    /**
     * Rewrite a cover URL to flow through the helper's own /image proxy with the
     * source site as Referer — exactly what the web app does (proxyImage). Many
     * cover CDNs hotlink-protect or sit behind Cloudflare, so a direct load from
     * the app shows a blank cover; proxying adds the Referer (and the shared cookie
     * jar / cf_clearance). Only applied to RESPONSE bodies — never persisted (the
     * loopback port changes per launch), so the DB keeps the raw URL.
     */
    private fun proxyCoverUrl(raw: String?, sourceBaseUrl: String, sourceId: String? = null): String {
        val c = raw?.trim().orEmpty()
        if (c.isEmpty() || c.startsWith("data:")) return c
        val port = server?.address?.port ?: return c
        val base = "http://127.0.0.1:$port"
        if (c.startsWith("$base/image")) return c
        val enc = java.net.URLEncoder.encode(c, "UTF-8")
        val domain = sourceBaseUrl.trim().trimEnd('/')
        val ref = if (domain.isNotEmpty()) "&h=" + java.net.URLEncoder.encode("Referer:$domain/", "UTF-8") else ""
        val identity = if (networkConfig.usesDesktopRelay && sourceId != null) "&sourceId=" + java.net.URLEncoder.encode(sourceId, "UTF-8") else ""
        return "$base/image?u=$enc$ref$identity"
    }

    // Manga ids we've already tried (and failed) to backfill a cover for this
    // session — avoids re-searching a source on every history refresh.
    private val coverResolveAttempted =
        java.util.Collections.synchronizedSet(mutableSetOf<String>())

    /**
     * Cover URL for a history row, proxied with the source Referer.
     *
     * Synced/legacy history manga frequently have a blank `cover_url` (the
     * device that recorded them never captured it). Explore shows covers because
     * the parser's search/list results include them — so when a cover is
     * missing, fetch it the same way (search the source by title), persist it
     * via upsert (one-time cost), and proxy it. Unknown-source rows stay blank.
     */
    private fun historyCoverUrl(row: com.nyora.hasan72341.shared.repository.HistoryRow): String {
        val manga = row.manga
        if (manga.coverUrl.isNotBlank()) {
            return proxyCoverUrl(manga.coverUrl, sourceBaseUrlFor(manga.source), openableHistorySourceId(manga.source, row.sourceId))
        }
        val sid = openableHistorySourceId(manga.source, row.sourceId)
        if (sid.isEmpty() || !coverResolveAttempted.add(manga.id)) return ""
        val source = facade.listSources().firstOrNull { it.id == sid } ?: return ""
        return try {
            val service = openInstalled(source)
            val results = runBlocking { service.search(manga.title, 1, emptyList()).entries }
            fun slugBase(u: String) =
                u.trimEnd('/').substringAfterLast('/').substringBeforeLast('-')
            val match = results.firstOrNull { it.title.equals(manga.title, ignoreCase = true) }
                ?: results.firstOrNull { slugBase(it.url) == slugBase(manga.url) }
                ?: results.firstOrNull()
            val cover = match?.coverUrl.orEmpty()
            if (cover.isNotBlank()) {
                // Persist so the next history load is instant.
                facade.upsertManga(manga.copy(coverUrl = cover))
                proxyCoverUrl(cover, refererBaseFor(source), source.id)
            } else {
                ""
            }
        } catch (_: Exception) {
            ""
        }
    }

    /** baseUrl of the installed source backing a manga's source ref ("" if unknown). */
    private fun sourceBaseUrlFor(ref: com.nyora.hasan72341.shared.model.MangaSourceRef): String {
        val sid = openableHistorySourceId(ref, "")
        if (sid.isEmpty()) return ""
        val source = facade.listSources().firstOrNull { it.id == sid } ?: return ""
        return refererBaseFor(source)
    }

    // Resolved "https://<domain>" per source, for the image proxy's Referer.
    private val refererBaseCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * True when this request came from a browser — i.e. the web app.
     *
     * A browser always sends `Origin` on a cross-origin call, and the web app is by definition
     * cross-origin to the hosted helper. The desktop and iOS clients talk to a loopback helper
     * with a plain HTTP client and send neither `Origin` nor `Sec-Fetch-*`, so this separates
     * them without needing a client to identify itself.
     *
     * Set NYORA_WEB_CF_SOURCES=1 to serve challenge-gated sources to the web app anyway (for
     * a deployment that does have a solver, e.g. one running FlareSolverr).
     */
    private fun isBrowserClient(exchange: HttpExchange): Boolean {
        if (isolatedDesktop && networkConfig.usesDesktopRelay) return false
        if (System.getenv("NYORA_WEB_CF_SOURCES") == "1") return false
        val headers = exchange.requestHeaders
        return !headers.getFirst("Origin").isNullOrBlank() ||
            !headers.getFirst("Sec-Fetch-Mode").isNullOrBlank()
    }

    /**
     * Catalogue membership follows the same versioned capability policy on every node.
     * Temporary upstream challenges are request failures, not source removals: using each
     * node's challenge history here made sources disappear depending on which node answered.
     */
    private fun catalogueFor(exchange: HttpExchange, sources: List<MangaSource>): List<MangaSource> {
        if (!isBrowserClient(exchange)) return sources
        val solverlessDataSourceIds =
            com.nyora.hasan72341.shared.extension.DataDrivenCatalog
                .loadForSolverlessClient()
                .asSequence()
                .map { it.source.id }
                .toHashSet()
        return sources.filter { it.id in solverlessDataSourceIds }
    }

    /**
     * The origin to send as `Referer` when fetching a source's images.
     *
     * Native parser sources carry `baseUrl = ""` — [nativeParserCatalog] cannot know a
     * domain before the parser is constructed, and `ConfigKey.Domain` plus our overrides
     * can move it afterwards. Every cover was therefore proxied WITHOUT a Referer, and
     * every source that blocks hotlinking answered 403: covers came back blank in the
     * grid, the library and history. Manganato is a clear case — its CDN returns 403 with
     * no Referer and 200 with `https://www.manganato.gg/`.
     *
     * The parser knows its live domain, so ask it once and remember the answer.
     */
    private fun refererBaseFor(source: MangaSource): String = refererBaseCache.getOrPut(source.id) {
        source.baseUrl.trim().trimEnd('/').ifEmpty {
            runCatching { "https://" + openInstalled(source).domain.trim('/') }.getOrDefault("")
        }
    }

    /**
     * Same, by source id. The browse cache-hit path deliberately avoids
     * `facade.listSources()` (it serializes on the DB lock), so take the memoised answer
     * when there is one and only fall back to the lookup on the first hit per source.
     */
    private fun refererBaseForId(id: String): String = refererBaseCache[id]
        ?: facade.listSources().firstOrNull { it.id == id }?.let { refererBaseFor(it) }.orEmpty()

    /**
     * Rewrite a reader page image URL to flow through the helper's /image proxy
     * with the source site as Referer — the same hotlink/Cloudflare workaround
     * we apply to covers, but for ALL page images of EVERY source (many sources
     * 403 image requests that lack a Referer, leaving the reader/thumbnails
     * blank). Any per-page headers the parser emitted are forwarded too.
     */
    private fun proxyPageUrl(page: MangaPage, sourceBaseUrl: String, sourceId: String): MangaPage {
        val raw = page.url.trim()
        if (raw.isEmpty() || raw.startsWith("data:")) return page
        // Absolutize a relative image path (some Madara sites like MangaEclipse
        // return /wp-content/… ; already-cached pages may still hold relative
        // paths) against the source base URL so /image?u= receives a real URL.
        val c = when {
            raw.startsWith("//") -> "https:$raw"
            raw.startsWith("/") && sourceBaseUrl.isNotBlank() -> sourceBaseUrl.trimEnd('/') + raw
            else -> raw
        }
        val port = server?.address?.port ?: return page
        val base = "http://127.0.0.1:$port"
        if (c.startsWith("$base/image")) return page
        val enc = java.net.URLEncoder.encode(c, "UTF-8")
        val domain = sourceBaseUrl.trim().trimEnd('/')
        val params = StringBuilder()
        val hasReferer = page.headers.keys.any { it.equals("Referer", ignoreCase = true) }
        if (domain.isNotEmpty() && !hasReferer) {
            params.append("&h=").append(java.net.URLEncoder.encode("Referer:$domain/", "UTF-8"))
        }
        page.headers.forEach { (k, v) ->
            params.append("&h=").append(java.net.URLEncoder.encode("$k:$v", "UTF-8"))
        }
        if (networkConfig.usesDesktopRelay) params.append("&sourceId=").append(java.net.URLEncoder.encode(sourceId, "UTF-8"))
        return page.copy(url = "$base/image?u=$enc$params")
    }

    private fun handleBrowse(exchange: HttpExchange, mode: BrowseMode) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val catalogue = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.snapshot()
        val params = exchange.query()
        val id = params["id"] ?: return respondError(exchange, 400, "Missing 'id'")
        val page = params["page"]?.toIntOrNull() ?: 1
        // Cache check FIRST — a hit must skip the source lookup below, because
        // facade.listSources() serializes under concurrency (DB/lock) and would
        // otherwise bottleneck cached hits.
        //
        // Search IS cached now. It was previously excluded as "query/user-
        // specific", but a search response depends only on (catalogue, source,
        // query, page, filters) — there is nothing per-user in it. Leaving it
        // uncached meant every global search re-fetched every source upstream
        // AND took the serializing lookup below, which is what pinned sweep
        // throughput to ~0.6 sources/sec however many the client ran at once.
        // Keys go to their own store (see ResponseCache.SEARCH_PREFIX) so this
        // high-cardinality traffic cannot evict the warm browse cache.
        //
        // The query is folded to lower case: site search is case-insensitive in
        // practice, so "Solo Leveling" and "solo leveling" should share an entry
        // instead of each paying a full fan-out.
        val cacheKey = if (mode != BrowseMode.SEARCH) {
            "browse:${catalogue.fingerprint}:${mode.name}:$id:$page:${params["f"].orEmpty()}"
        } else {
            val q = params["q"].orEmpty().trim().lowercase()
            if (q.isEmpty()) null
            else "${ResponseCache.SEARCH_PREFIX}${catalogue.fingerprint}:$id:$page:${params["f"].orEmpty()}:$q"
        }
        // Native verification retries must prove upstream access. A cached 200
        // would conceal a challenge, and background revalidation cannot attach
        // its failure to the operation the desktop needs to resume.
        val nativeTransport = isolatedDesktop && networkConfig.usesDesktopRelay
        val refresh = nativeTransport && params["refresh"] == "1"
        if (cacheKey != null && !refresh) {
            if (mode == BrowseMode.SEARCH || nativeTransport) {
                // Native expired entries refetch inline; truly fresh entries
                // remain useful outside verification. Search is always fresh-only.
                ResponseCache.get(cacheKey)?.let { body ->
                    respondJsonRaw(exchange, 200, reproxyBrowseBody(body, refererBaseForId(id), id))
                    return
                }
            } else {
                // Preserve hosted browse's stale-while-revalidate behavior.
                ResponseCache.peek(cacheKey)?.let { hit ->
                    // Re-proxy covers to the CURRENT port: the cache is disk-persisted, so a
                    // body cached by a previous launch embeds that launch's dead loopback port.
                    respondJsonRaw(exchange, 200, reproxyBrowseBody(hit.value, refererBaseForId(id), id))
                    if (hit.stale) revalidateBrowse(cacheKey, id, mode, page, params["f"], catalogue)
                    return
                }
            }
        }
        val source = sourceAtCatalogueSnapshot(id, catalogue)
            ?: return respondError(exchange, 404, "Unknown source: $id")
        val filters = parseFilters(params["f"])
        try {
            val body = fetchBrowseBody(
                source,
                mode,
                page,
                params["q"].orEmpty(),
                filters,
                cacheKey,
                catalogue.revision,
            )
            respondJsonRaw(exchange, 200, body)
        } catch (error: Exception) {
            // Global search fans out across hundreds of sources; a blocked/dead/
            // timing-out one should yield NO results (empty 200), not a 500 that
            // floods the client console. Single-source browse still surfaces 500.
            if (networkConfig.usesDesktopRelay) {
                respondError(exchange, 502, requestFailureMessage(error, "desktop_relay_request_failed sourceId=$id"))
            } else if (mode == BrowseMode.SEARCH) {
                respondJsonRaw(exchange, 200, json.encodeToString(BrowseResponse.serializer(), BrowseResponse(emptyList(), false)))
            } else {
                respondError(exchange, 500, error.message ?: "Browse failed")
            }
        }
    }

    /** Open a source's extension, forcing the installed flag — the native parsers
     *  are all bundled, so the isInstalled require() is just a UI guard that would
     *  otherwise 500 any not-yet-installed source (common with all-enabled). */
    private fun openInstalled(source: MangaSource) =
        facade.openExtension(if (source.isInstalled) source else source.copy(isInstalled = true))

    /** Fetch a browse page from the source, serialize it, and cache non-empty
     *  results. Shared by the inline path, background revalidation, and pre-warm. */
    private fun fetchBrowseBody(
        source: MangaSource,
        mode: BrowseMode,
        page: Int,
        query: String,
        filters: List<com.nyora.hasan72341.shared.extension.SourceFilter>,
        cacheKey: String?,
        catalogueRevision: Long,
    ): String {
        val service = openInstalled(source)
        // Mark search fetches so CloudflareInterceptor skips CF-solving (fail fast on
        // blocked sources) — a broad all-source search must never trigger a Chrome
        // storm. Covers concurrent fan-out via a counter.
        val isSearch = mode == BrowseMode.SEARCH
        if (isSearch) com.nyora.hasan72341.shared.net.CloudflareInterceptor.searchFanoutActive.incrementAndGet()
        val result = try {
            runBlocking {
                when (mode) {
                    BrowseMode.POPULAR -> service.getPopular(page)
                    BrowseMode.LATEST -> service.getLatest(page)
                    BrowseMode.SEARCH -> service.search(query, page, filters)
                }
            }
        } finally {
            if (isSearch) com.nyora.hasan72341.shared.net.CloudflareInterceptor.searchFanoutActive.decrementAndGet()
        }
        // Cache the RAW cover URLs (never a proxy URL) — the proxy port changes per launch
        // and the cache is disk-persisted, so caching a proxied body would embed a dead
        // port. Covers are proxied to the current port at serve time via reproxyBrowseBody.
        val rawBody = json.encodeToString(
            BrowseResponse.serializer(),
            BrowseResponse(entries = result.entries, hasNextPage = result.hasNextPage),
        )
        if (cacheKey != null && result.entries.isNotEmpty()) {
            com.nyora.hasan72341.shared.extension.DataDrivenCatalog.commitIfRevision(catalogueRevision) {
                ResponseCache.put(cacheKey, rawBody, 600_000) // 10 min fresh window
            }
        }
        return reproxyBrowseBody(rawBody, refererBaseFor(source), source.id)
    }

    /** Un-proxy a cover URL: if it is one of our own `…/image?u=<enc>` proxy URLs (possibly
     *  carrying a stale port from a previous launch's disk-snapshot cache), decode it back
     *  to the raw CDN url. Already-raw urls pass through untouched. */
    private fun unproxyCover(url: String): String {
        val marker = "/image?u="
        val idx = url.indexOf(marker)
        if (idx < 0) return url
        val enc = url.substring(idx + marker.length).substringBefore('&')
        return runCatching { URLDecoder.decode(enc, StandardCharsets.UTF_8) }.getOrDefault(url)
    }

    /** Rewrite a browse body's cover URLs to the CURRENT helper port. Handles both freshly
     *  cached raw bodies and stale proxied bodies restored from the disk snapshot. Referer
     *  is derived from the image origin in handleImage, so no source baseUrl is needed. */
    private fun reproxyBrowseBody(body: String, refererBase: String, sourceId: String): String = runCatching {
        val parsed = json.decodeFromString(BrowseResponse.serializer(), body)
        json.encodeToString(
            BrowseResponse.serializer(),
            parsed.copy(entries = parsed.entries.map { it.copy(coverUrl = proxyCoverUrl(unproxyCover(it.coverUrl), refererBase, sourceId)) }),
        )
    }.getOrDefault(body)

    /** Refresh a stale browse entry in the background so the NEXT request is fresh
     *  — the current request already got an instant (stale) response. */
    private fun revalidateBrowse(
        cacheKey: String,
        id: String,
        mode: BrowseMode,
        page: Int,
        filtersParam: String?,
        catalogue: com.nyora.hasan72341.shared.extension.DataDrivenCatalog.Snapshot,
    ) {
        if (!revalidating.add(cacheKey)) return // one refresh at a time per key
        backgroundExecutor.execute {
            try {
                val source = sourceAtCatalogueSnapshot(id, catalogue) ?: return@execute
                fetchBrowseBody(
                    source,
                    mode,
                    page,
                    "",
                    parseFilters(filtersParam),
                    cacheKey,
                    catalogue.revision,
                )
            } catch (_: Throwable) { /* keep the stale copy on failure */ } finally {
                revalidating.remove(cacheKey)
            }
        }
    }

    private fun handleDetails(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val catalogue = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.snapshot()
        val params = exchange.query()
        val id = params["id"] ?: return respondError(exchange, 400, "Missing 'id'")
        val url = params["url"] ?: return respondError(exchange, 400, "Missing 'url'")
        val source = sourceAtCatalogueSnapshot(id, catalogue)
            ?: return respondError(exchange, 404, "Unknown source: $id")
        try {
            val service = openInstalled(source)
            val details = runBlocking { service.getDetails(url) }
            val manga = details.manga.copy(
                source = details.manga.source.takeUnless {
                    it == com.nyora.hasan72341.shared.model.MangaSourceRef.Unknown
                } ?: source.nativeResultSourceRef(),
                chapters = details.chapters,
            )
            var persistedManga = manga
            val committed = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.commitIfRevision(
                catalogue.revision,
            ) {
                persistedManga = facade.upsertMangaDetails(manga, source.id, url)
            }
            if (!committed) {
                respondError(exchange, 409, "Catalogue changed while loading details; retry")
                return
            }
            respondJson(exchange, 200, json.encodeToJsonElement(
                DetailsResponse(
                    manga = persistedManga.copy(coverUrl = proxyCoverUrl(persistedManga.coverUrl, refererBaseFor(source), source.id)),
                    chapters = persistedManga.chapters,
                ),
            ))
        } catch (error: Exception) {
            respondError(exchange, 500, requestFailureMessage(error, "Details failed"))
        }
    }

    private fun handlePages(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val catalogue = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.snapshot()
        val params = exchange.query()
        val id = params["id"] ?: return respondError(exchange, 400, "Missing 'id'")
        val url = params["url"] ?: return respondError(exchange, 400, "Missing 'url'")
        val refresh = params["refresh"]?.let { it == "1" || it.equals("true", ignoreCase = true) } ?: false
        val source = sourceAtCatalogueSnapshot(id, catalogue)
            ?: return respondError(exchange, 404, "Unknown source: $id")
        val cacheSourceId = "$id@${catalogue.fingerprint}"
        if (!refresh) {
            facade.cachedPages(cacheSourceId, url)?.let { cached ->
                if (cached.isEmpty()) {
                    // Old builds persisted empty/negative results for seven days.
                    facade.clearChapterPageCache()
                    return@let
                }
                val proxied = cached.map { proxyPageUrl(it, refererBaseFor(source), source.id) }
                respondJson(exchange, 200, json.encodeToJsonElement(PagesResponse(pages = proxied)))
                return
            }
        }
        try {
            val service = openInstalled(source)
            val chapter = MangaChapter(id = url, title = url, url = url)
            val pages = runBlocking { service.getPageList(chapter) }
            val committed = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.commitIfRevision(
                catalogue.revision,
            ) {
                // Cache the RAW pages (the loopback port changes per launch, so we
                // must not persist proxied URLs). The facade scopes the chapter key
                // by source id because many sites use identical relative chapter paths.
                if (pages.isNotEmpty()) {
                    facade.cachePages(cacheSourceId, url, id, pages)
                }
            }
            if (!committed) {
                respondError(exchange, 409, "Catalogue changed while loading pages; retry")
                return
            }
            val proxied = pages.map { proxyPageUrl(it, refererBaseFor(source), source.id) }
            respondJson(exchange, 200, json.encodeToJsonElement(PagesResponse(pages = proxied)))
        } catch (error: Exception) {
            respondError(exchange, 500, requestFailureMessage(error, "Pages failed"))
        }
    }

    /** Resolve data-driven source metadata from the same immutable catalogue epoch as the request. */
    // Both halves of the lookup below used to be a linear scan per request — one
    // over facade.listSources() (which also rebuilds from the DB and serializes
    // under concurrency) and one over the ~1100-entry catalogue. On the search
    // path, which is a fan-out across hundreds of sources, that ran on EVERY
    // request before a single byte was fetched upstream. Both are memoised here
    // and rebuilt only when the catalogue revision changes or the stored source
    // set is invalidated (install / uninstall / pin / refresh).
    private class SourceIndex(
        val revision: Long,
        val builtAt: Long,
        val stored: Map<String, MangaSource>,
        val defined: Map<String, MangaSource>,
    )

    @Volatile private var sourceIndex: SourceIndex? = null
    private val sourceIndexLock = Any()
    // Explicit invalidation covers every handler that writes the source set, but
    // the DB is not exclusively ours; expiring the memo bounds any write we did
    // not see to a minute of staleness for one boolean flag.
    private val sourceIndexMaxAgeMs = 60_000L

    /** Drop the memoised lookup — call wherever the stored source set changes. */
    private fun invalidateSourceIndex() {
        synchronized(sourceIndexLock) { sourceIndex = null }
    }

    private fun sourceIndex(
        catalogue: com.nyora.hasan72341.shared.extension.DataDrivenCatalog.Snapshot,
    ): SourceIndex {
        val now = System.currentTimeMillis()
        fun usable(i: SourceIndex) =
            i.revision == catalogue.revision && now - i.builtAt < sourceIndexMaxAgeMs
        sourceIndex?.let { if (usable(it)) return it }
        synchronized(sourceIndexLock) {
            sourceIndex?.let { if (usable(it)) return it }
            val built = SourceIndex(
                revision = catalogue.revision,
                builtAt = System.currentTimeMillis(),
                stored = facade.listSources().associateBy { it.id },
                defined = catalogue.entries.associate { it.source.id to it.source },
            )
            sourceIndex = built
            return built
        }
    }

    private fun sourceAtCatalogueSnapshot(
        id: String,
        catalogue: com.nyora.hasan72341.shared.extension.DataDrivenCatalog.Snapshot,
    ): MangaSource? {
        val index = sourceIndex(catalogue)
        val stored = index.stored[id]
        val definition = index.defined[id] ?: return stored
        return definition.copy(
            isInstalled = stored?.isInstalled ?: definition.isInstalled,
            isPinned = stored?.isPinned ?: definition.isPinned,
            installedAt = stored?.installedAt ?: definition.installedAt,
        )
    }

    // MARK: - library: history

    private fun handleHistory(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val limit = exchange.query()["limit"]?.toIntOrNull() ?: 100
        val rows = facade.history(limit).map { row ->
            // The manga's source ref is the authoritative identity (mirrors how
            // Android resolves a source by name). The stored `source_id` column
            // is unreliable on synced/legacy rows — it can hold a stale id or
            // even a Kotlin class string like
            // "com.nyora...MangaSourceRef.Unknown". We now run JS extensions
            // only (Java/Mihon was ditched), so resolve to a JS-openable id and
            // refuse to emit garbage that the client would forward to details().
            val resolvedSourceId = openableHistorySourceId(row.manga.source, row.sourceId)
            val sourceLabel = facade.listSources().firstOrNull { it.id == resolvedSourceId }?.name
                ?: (row.manga.source as? com.nyora.hasan72341.shared.model.MangaSourceRef.Parser)?.name
                ?: (row.manga.source as? com.nyora.hasan72341.shared.model.MangaSourceRef.Script)?.name
                ?: row.manga.source.name
            HistoryRowDto(
                mangaId = row.manga.id,
                mangaUrl = row.manga.url,
                mangaTitle = row.manga.title,
                mangaCoverUrl = historyCoverUrl(row),
                sourceId = resolvedSourceId,
                sourceName = sourceLabel,
                chapterId = row.chapterId,
                chapterTitle = row.chapterTitle,
                page = row.page,
                percent = row.percent,
                updatedAt = row.updatedAt,
            )
        }
        respondJson(exchange, 200, json.encodeToJsonElement(HistoryResponse(rows)))
    }

    private fun handleHistoryRecord(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val mangaId = params["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val sourceId = params["sourceId"].orEmpty()
        val chapterId = params["chapterId"].orEmpty()
        val chapterTitle = params["chapterTitle"].orEmpty()
        val page = params["page"]?.toIntOrNull() ?: 0
        val percent = params["percent"]?.toFloatOrNull() ?: 0f
        facade.recordHistory(mangaId, sourceId, chapterId, chapterTitle, page, percent)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleHistoryRemove(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val mangaId = params["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        facade.removeHistory(mangaId)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleHistoryClear(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        facade.clearHistory()
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleLibraryClear(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        facade.clearDatabase()
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    // MARK: - library: favourites

    private fun handleFavourites(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        // Proxy each cover through /image with the source Referer so hotlink-
        // protected thumbnails render for every source (same as browse/details).
        val favs = facade.favourites().map { m ->
            m.copy(
                source = canonicalOpenableMangaSourceRef(m.source),
                coverUrl = proxyCoverUrl(m.coverUrl, sourceBaseUrlFor(m.source), openableHistorySourceId(m.source, "")),
            )
        }
        respondJson(exchange, 200, json.encodeToJsonElement(FavouritesResponse(favs)))
    }

    private fun handleFavouriteToggle(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val mangaId = exchange.query()["mangaId"]
            ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val nowFavourited = facade.toggleFavourite(mangaId)
        respondJson(exchange, 200, buildJsonObject { put("favourited", nowFavourited) })
    }

    private fun handleFavouriteCheck(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val mangaId = exchange.query()["mangaId"]
            ?: return respondError(exchange, 400, "Missing 'mangaId'")
        respondJson(exchange, 200, buildJsonObject { put("favourited", facade.isFavourited(mangaId)) })
    }

    // MARK: - per-manga reader prefs

    private fun handleMangaPrefs(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val mangaId = exchange.query()["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val p = facade.mangaPrefs(mangaId)
        if (p == null) {
            respondJson(exchange, 200, buildJsonObject { put("present", false) })
        } else {
            respondJson(exchange, 200, json.encodeToJsonElement(MangaPrefsDto(
                mangaId = p.mangaId, readerMode = p.readerMode,
                brightness = p.brightness, contrast = p.contrast,
                saturation = p.saturation, hue = p.hue, palette = p.palette,
                present = true,
            )))
        }
    }

    private fun handleMangaPrefsSave(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val p = exchange.query()
        val mangaId = p["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        facade.saveMangaPrefs(com.nyora.hasan72341.shared.repository.MangaPrefsRow(
            mangaId = mangaId,
            readerMode = p["readerMode"].orEmpty(),
            brightness = p["brightness"]?.toDoubleOrNull() ?: 0.0,
            contrast = p["contrast"]?.toDoubleOrNull() ?: 1.0,
            saturation = p["saturation"]?.toDoubleOrNull() ?: 1.0,
            hue = p["hue"]?.toDoubleOrNull() ?: 0.0,
            palette = p["palette"].orEmpty(),
        ))
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleMangaPrefsClear(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true) &&
            !exchange.requestMethod.equals("DELETE", ignoreCase = true)
        ) { respondText(exchange, 405, "Method not allowed"); return }
        val mangaId = exchange.query()["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        facade.clearMangaPrefs(mangaId)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    // MARK: - downloads

    private fun handleDownloads(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val dm = downloads ?: return respondError(exchange, 503, "Downloads not enabled")
        val rows = dm.list().map(::toDto)
        respondJson(exchange, 200, json.encodeToJsonElement(DownloadsResponse(rows)))
    }

    private fun handleDownloadStart(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val dm = downloads ?: return respondError(exchange, 503, "Downloads not enabled")
        val p = exchange.query()
        val sourceId = p["sourceId"] ?: return respondError(exchange, 400, "Missing 'sourceId'")
        val mangaUrl = p["mangaUrl"].orEmpty()
        val chapterUrl = p["chapterUrl"] ?: return respondError(exchange, 400, "Missing 'chapterUrl'")
        val mangaTitle = p["mangaTitle"] ?: "manga"
        val chapterTitle = p["chapterTitle"] ?: "chapter"
        val entry = dm.start(sourceId, mangaUrl, chapterUrl, mangaTitle, chapterTitle)
        respondJson(exchange, 200, json.encodeToJsonElement(DownloadResponse(toDto(entry))))
    }

    /**
     * Batch-enqueue many chapters at once (range / multi-select from the UI).
     *   POST /downloads/enqueue?sourceId=&mangaUrl=&mangaTitle=
     *   body: [{"url":"...","title":"..."}, ...]
     * The DownloadManager throttles concurrent runs via its semaphore, so a large
     * batch queues safely.
     */
    private fun handleDownloadEnqueue(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val dm = downloads ?: return respondError(exchange, 503, "Downloads not enabled")
        val p = exchange.query()
        val sourceId = p["sourceId"] ?: return respondError(exchange, 400, "Missing 'sourceId'")
        val mangaUrl = p["mangaUrl"].orEmpty()
        val mangaTitle = p["mangaTitle"] ?: "manga"
        val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
        val arr = runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(body) as? kotlinx.serialization.json.JsonArray
        }.getOrNull() ?: return respondError(exchange, 400, "Body must be a JSON array of {url,title}")
        val entries = arr.mapNotNull { el ->
            val o = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
            val url = (o["url"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return@mapNotNull null
            val title = (o["title"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "chapter"
            dm.start(sourceId, mangaUrl, url, mangaTitle, title)
        }
        respondJson(exchange, 200, json.encodeToJsonElement(DownloadsResponse(entries.map { toDto(it) })))
    }

    private fun handleDownloadCancel(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val dm = downloads ?: return respondError(exchange, 503, "Downloads not enabled")
        val id = exchange.query()["id"] ?: return respondError(exchange, 400, "Missing 'id'")
        dm.cancel(id)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    /** Purge finished (completed/failed/cancelled) entries from the queue view. */
    private fun handleDownloadClear(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val dm = downloads ?: return respondError(exchange, 503, "Downloads not enabled")
        val removed = dm.clearFinished()
        respondJson(exchange, 200, buildJsonObject { put("ok", true); put("removed", removed) })
    }

    private fun handleDownloadSettings(exchange: HttpExchange) {
        val dm = downloads ?: return respondError(exchange, 503, "Downloads not enabled")
        when {
            exchange.requestMethod.equals("GET", ignoreCase = true) -> {
                respondJson(exchange, 200, json.encodeToJsonElement(DownloadSettingsResponse(dm.currentSettings())))
            }
            exchange.requestMethod.equals("POST", ignoreCase = true) -> {
                val p = exchange.query()
                val maxConcurrent = p["maxConcurrent"]?.toIntOrNull() ?: dm.currentSettings().maxConcurrentDownloads
                val format = p["format"]?.uppercase()?.let {
                    runCatching { DownloadFormat.valueOf(it) }.getOrNull()
                } ?: dm.currentSettings().format
                dm.configure(DownloadSettings(maxConcurrentDownloads = maxConcurrent, format = format))
                respondJson(exchange, 200, json.encodeToJsonElement(DownloadSettingsResponse(dm.currentSettings())))
            }
            else -> respondText(exchange, 405, "Method not allowed")
        }
    }

    private fun handleNetworkSettings(exchange: HttpExchange) {
        if (!requireLocalManagement(exchange)) return
        when {
            exchange.requestMethod.equals("GET", ignoreCase = true) -> {
                respondJson(exchange, 200, json.encodeToJsonElement(NetworkSettingsResponse(networkConfig.snapshot())))
            }
            exchange.requestMethod.equals("POST", ignoreCase = true) -> {
                val p = exchange.query()
                val updated = networkConfig.update(
                    HelperNetworkSettings(
                        proxyType = p["proxyType"] ?: networkConfig.snapshot().proxyType,
                        proxyAddress = p["proxyAddress"] ?: networkConfig.snapshot().proxyAddress,
                        proxyPort = p["proxyPort"]?.toIntOrNull() ?: networkConfig.snapshot().proxyPort,
                        dnsOverHttps = p["dnsOverHttps"] ?: networkConfig.snapshot().dnsOverHttps,
                        githubMirror = p["githubMirror"] ?: networkConfig.snapshot().githubMirror,
                        imagesProxy = p["imagesProxy"] ?: networkConfig.snapshot().imagesProxy,
                        sslBypass = p["sslBypass"]?.toBooleanStrictOrNull() ?: networkConfig.snapshot().sslBypass,
                        disableConnectivityCheck = p["disableConnectivityCheck"]?.toBooleanStrictOrNull()
                            ?: networkConfig.snapshot().disableConnectivityCheck,
                    )
                )
                respondJson(exchange, 200, json.encodeToJsonElement(NetworkSettingsResponse(updated)))
            }
            else -> respondText(exchange, 405, "Method not allowed")
        }
    }

    /** Local desktop requests arrive directly and never carry reverse-proxy identity headers. */
    private fun hasTrustedLocalClient(exchange: HttpExchange): Boolean {
        val peer = exchange.remoteAddress?.address ?: return false
        if (!peer.isLoopbackAddress) return false
        // The hosted service is disabled above, and the desktop app connects without a proxy.
        // Rejecting every proxy identity header prevents a direct caller from manufacturing a
        // loopback client identity (including a spoofed Cloudflare header).
        return listOf("Forwarded", "X-Real-IP", "X-Forwarded-For", "CF-Connecting-IP")
            .none(exchange.requestHeaders::containsKey)
    }

    private fun requireLocalManagement(
        exchange: HttpExchange,
        enabled: Boolean = isLocalDesktopHelper,
    ): Boolean {
        val browserInitiated = exchange.requestHeaders.containsKey("Origin") ||
            exchange.requestHeaders.containsKey("Sec-Fetch-Site")
        val exactManagementPath = exchange.requestURI.path in LOCAL_MANAGEMENT_PATHS
        if (!enabled || !exactManagementPath || browserInitiated || !hasTrustedLocalClient(exchange)) {
            respondError(exchange, 403, "This management endpoint is available only to the local desktop client")
            return false
        }
        return true
    }

    private fun toDto(e: com.nyora.hasan72341.shared.download.DownloadEntry): DownloadDto = DownloadDto(
        id = e.id,
        sourceId = e.sourceId,
        mangaTitle = e.mangaTitle,
        chapterTitle = e.chapterTitle,
        chapterUrl = e.chapterUrl,
        totalPages = e.totalPages,
        completedPages = e.completedPages,
        failedPages = e.failedPages,
        status = e.status.name,
        filePath = e.filePath,
        error = e.error,
        startedAt = e.startedAt,
        finishedAt = e.finishedAt,
    )

    // MARK: - favourite categories

    private fun handleCategories(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val categoryId = exchange.query()["categoryId"]?.toLongOrNull()
        if (categoryId != null) {
            val favourites = facade.favouritesIn(categoryId).map { manga ->
                manga.copy(source = canonicalOpenableMangaSourceRef(manga.source))
            }
            respondJson(exchange, 200, json.encodeToJsonElement(
                FavouritesResponse(entries = favourites),
            ))
            return
        }
        val rows = facade.favouriteCategories().map { CategoryDto(it.id, it.title, it.mangaCount) }
        respondJson(exchange, 200, json.encodeToJsonElement(CategoriesResponse(rows)))
    }

    private fun handleCategoryCreate(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val title = exchange.query()["title"].orEmpty().trim()
        if (title.isEmpty()) return respondError(exchange, 400, "Missing 'title'")
        val id = facade.createCategory(title)
        respondJson(exchange, 200, buildJsonObject { put("id", id); put("title", title) })
    }

    private fun handleCategoryRename(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val id = exchange.query()["id"]?.toLongOrNull() ?: return respondError(exchange, 400, "Missing 'id'")
        val title = exchange.query()["title"].orEmpty().trim()
        if (title.isEmpty()) return respondError(exchange, 400, "Missing 'title'")
        facade.renameCategory(id, title)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleCategoryDelete(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true) &&
            !exchange.requestMethod.equals("DELETE", ignoreCase = true)
        ) { respondText(exchange, 405, "Method not allowed"); return }
        val id = exchange.query()["id"]?.toLongOrNull() ?: return respondError(exchange, 400, "Missing 'id'")
        facade.deleteCategory(id)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleCategoryAdd(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val mangaId = exchange.query()["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val categoryId = exchange.query()["categoryId"]?.toLongOrNull()
            ?: return respondError(exchange, 400, "Missing 'categoryId'")
        facade.addToCategory(mangaId, categoryId)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleCategoryRemove(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true) &&
            !exchange.requestMethod.equals("DELETE", ignoreCase = true)
        ) { respondText(exchange, 405, "Method not allowed"); return }
        val mangaId = exchange.query()["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val categoryId = exchange.query()["categoryId"]?.toLongOrNull()
            ?: return respondError(exchange, 400, "Missing 'categoryId'")
        facade.removeFromCategory(mangaId, categoryId)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleCategoriesForManga(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val mangaId = exchange.query()["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val rows = facade.categoriesForManga(mangaId).map { CategoryDto(it.id, it.title, 0) }
        respondJson(exchange, 200, json.encodeToJsonElement(CategoriesResponse(rows)))
    }

    // MARK: - global search

    private fun handleGlobalSearch(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val query = params["q"]?.trim().orEmpty()
        if (query.isBlank()) {
            return respondError(exchange, 400, "Missing 'q'")
        }
        val perSourceLimit = params["limit"]?.toIntOrNull() ?: 6
        val installed = facade.listSources().filter { it.isInstalled }

        // Fan out across ALL installed sources, fully async. With the curated
        // catalogue this is a few hundred sources, so we bound concurrency with
        // a semaphore (opening hundreds of sockets at once just thrashes) while
        // still running many in parallel. There is NO overall request timeout —
        // the handler returns once every source has finished (or hit its own
        // per-source cap), and the Swift client waits as long as it takes.
        // The per-source cap stays: without it a single hung source would block
        // `awaitAll` forever and the whole search would never return.
        // Bounded fan-out — keeps the worst-case memory spike (many in-flight Jsoup
        // documents at once) small so the hosted helper stays under its RAM budget.
        val gate = kotlinx.coroutines.sync.Semaphore(12)
        val results = kotlinx.coroutines.runBlocking {
            kotlinx.coroutines.coroutineScope {
                installed.map { src ->
                    async(kotlinx.coroutines.Dispatchers.IO) {
                        gate.withPermit {
                            runCatching {
                                kotlinx.coroutines.withTimeout(15_000L) {
                                    val service = openInstalled(src)
                                    val page = service.search(query, page = 1)
                                    GlobalSearchGroup(
                                        sourceId = src.id,
                                        sourceName = src.name,
                                        entries = page.entries.take(perSourceLimit),
                                        error = null,
                                    )
                                }
                            }.getOrElse { error ->
                                GlobalSearchGroup(
                                    sourceId = src.id,
                                    sourceName = src.name,
                                    entries = emptyList(),
                                    error = requestFailureMessage(error, error::class.simpleName ?: "Search failed").take(240),
                                )
                            }
                        }
                    }
                }.awaitAll()
            }
        }
        // Only surface sources that actually returned hits, ordered by hit count.
        val nonEmpty = results.filter { it.entries.isNotEmpty() || (networkConfig.usesDesktopRelay && it.error != null) }.sortedByDescending { it.entries.size }
        respondJson(exchange, 200, json.encodeToJsonElement(GlobalSearchResponse(query, nonEmpty)))
    }

    // MARK: - local: cbz / folder reader

    private fun handleLocalScan(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val folder = exchange.query()["folder"] ?: return respondError(exchange, 400, "Missing 'folder'")
        val dir = java.nio.file.Path.of(folder)
        if (!java.nio.file.Files.isDirectory(dir)) {
            return respondError(exchange, 404, "Not a directory: $folder")
        }
        val entries = try {
            java.nio.file.Files.list(dir).use { stream ->
                stream
                    .filter { it.fileName.toString().endsWith(".cbz", ignoreCase = true) ||
                             it.fileName.toString().endsWith(".cbr", ignoreCase = true) ||
                             it.fileName.toString().endsWith(".zip", ignoreCase = true) }
                    .sorted()
                    .map { p ->
                        LocalCbzEntry(
                            path = p.toAbsolutePath().toString(),
                            name = p.fileName.toString().removeSuffix(".cbz").removeSuffix(".CBZ"),
                            sizeBytes = runCatching { java.nio.file.Files.size(p) }.getOrDefault(0L),
                        )
                    }
                    .toList()
            }
        } catch (e: Exception) {
            return respondError(exchange, 500, e.message ?: "Scan failed")
        }
        respondJson(exchange, 200, json.encodeToJsonElement(LocalScanResponse(entries)))
    }

    private fun handleLocalChapter(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val cbz = exchange.query()["cbz"] ?: return respondError(exchange, 400, "Missing 'cbz'")
        val path = java.nio.file.Path.of(cbz)
        if (!java.nio.file.Files.isRegularFile(path)) {
            return respondError(exchange, 404, "Not a file: $cbz")
        }
        val entries: List<String> = try {
            java.util.zip.ZipFile(path.toFile()).use { zf ->
                val all = mutableListOf<String>()
                val enum = zf.entries()
                while (enum.hasMoreElements()) {
                    val e = enum.nextElement()
                    if (!e.isDirectory && isImageEntry(e.name)) all.add(e.name)
                }
                all.sorted()
            }
        } catch (e: Exception) {
            return respondError(exchange, 500, e.message ?: "Open failed")
        }
        // Use the helper's loopback host:port as the base for image URLs.
        val base = "http://127.0.0.1:${server!!.address.port}"
        val pageUrls = entries.map { entry ->
            val encCbz = java.net.URLEncoder.encode(cbz, java.nio.charset.StandardCharsets.UTF_8)
            val encEntry = java.net.URLEncoder.encode(entry, java.nio.charset.StandardCharsets.UTF_8)
            "$base/local/image?cbz=$encCbz&entry=$encEntry"
        }
        respondJson(exchange, 200, json.encodeToJsonElement(LocalChapterResponse(
            name = path.fileName.toString().removeSuffix(".cbz").removeSuffix(".CBZ"),
            pageCount = entries.size,
            pageUrls = pageUrls,
        )))
    }

    private fun handleLocalImage(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val cbz = params["cbz"] ?: return respondError(exchange, 400, "Missing 'cbz'")
        val entry = params["entry"] ?: return respondError(exchange, 400, "Missing 'entry'")
        val path = java.nio.file.Path.of(cbz)
        if (!java.nio.file.Files.isRegularFile(path)) {
            return respondError(exchange, 404, "Not a file: $cbz")
        }
        try {
            java.util.zip.ZipFile(path.toFile()).use { zf ->
                val zipEntry = zf.getEntry(entry)
                    ?: return respondError(exchange, 404, "Entry not found: $entry")
                val bytes = zf.getInputStream(zipEntry).readBytes()
                val contentType = guessContentType(entry, bytes)
                exchange.responseHeaders.add("Content-Type", contentType)
                exchange.responseHeaders.add("Cache-Control", "private, max-age=86400")
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
        } catch (e: Exception) {
            respondError(exchange, 500, e.message ?: "Read failed")
        }
    }

    private fun isImageEntry(name: String): Boolean {
        val lower = name.lowercase()
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
            lower.endsWith(".png") || lower.endsWith(".webp") ||
            lower.endsWith(".gif") || lower.endsWith(".avif")
    }

    // MARK: - library: updates

    private fun handleUpdates(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val rows = facade.updates().map { UpdateDto(
            mangaId = it.mangaId,
            mangaTitle = it.mangaTitle,
            mangaCoverUrl = it.mangaCoverUrl,
            sourceId = it.sourceId,
            newChapters = it.newChapters,
            totalChapters = it.totalChapters,
            latestChapterTitle = it.latestChapterTitle,
            lastSyncedAt = it.lastSyncedAt,
        ) }
        respondJson(exchange, 200, json.encodeToJsonElement(UpdatesResponse(rows)))
    }

    private fun handleUpdatesRefresh(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        var checked = 0
        var withNew = 0
        try {
            // Scan both favourites AND reading-history manga, de-duplicated by manga id,
            // so updates are detected for any manga in history too.
            val combined = LinkedHashMap<String, Manga>()
            for (manga in facade.favourites()) {
                combined.putIfAbsent(manga.id, manga)
            }
            for (row in facade.history(limit = 500)) {
                combined.putIfAbsent(row.manga.id, row.manga)
            }
            for (manga in combined.values) {
                val sourceId = openableHistorySourceId(manga.source, "")
                if (sourceId.isBlank()) continue
                val source = facade.listSources().firstOrNull { src ->
                    src.isInstalled && src.id == sourceId
                } ?: continue
                runCatching {
                    val service = openInstalled(source)
                    val details = runBlocking { service.getDetails(manga.url.ifBlank { manga.id }) }
                    val count = details.chapters.size
                    val latestTitle = details.chapters.firstOrNull()?.title.orEmpty()
                    val before = (facade.updates().firstOrNull { it.mangaId == manga.id }?.totalChapters ?: -1)
                    facade.recordUpdateSync(
                        mangaId = manga.id,
                        sourceId = source.id,
                        currentChapterCount = count,
                        latestChapterTitle = latestTitle,
                    )
                    checked++
                    if (before in 0 until count) withNew++
                }
            }
        } catch (error: Exception) {
            respondError(exchange, 500, error.message ?: "Updates refresh failed"); return
        }
        respondJson(exchange, 200, buildJsonObject {
            put("checked", checked)
            put("withNew", withNew)
        })
    }

    private fun handleUpdatesSeen(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val mangaId = exchange.query()["mangaId"]
        if (mangaId.isNullOrBlank()) {
            facade.markAllUpdatesSeen()
        } else {
            facade.markUpdatesSeen(mangaId)
        }
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    // MARK: - library: bookmarks

    private fun handleBookmarks(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val rows = facade.bookmarks().map { BookmarkDto(
            id = it.id,
            mangaId = it.mangaId,
            mangaTitle = it.mangaTitle,
            mangaCoverUrl = it.mangaCoverUrl,
            chapterId = it.chapterId,
            chapterTitle = it.chapterTitle,
            page = it.page,
            note = it.note,
            createdAt = it.createdAt,
            sourceId = openableHistorySourceId(it.mangaSource, ""),
            mangaUrl = it.mangaUrl,
            chapterUrl = it.chapterUrl,
        ) }
        respondJson(exchange, 200, json.encodeToJsonElement(BookmarksResponse(rows)))
    }

    private fun handleBookmarkAdd(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val mangaId = params["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val chapterId = params["chapterId"].orEmpty()
        val chapterTitle = params["chapterTitle"].orEmpty()
        val page = params["page"]?.toIntOrNull() ?: 0
        val note = params["note"].orEmpty()
        facade.addBookmark(mangaId, chapterId, chapterTitle, page, note)
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleBookmarkRemove(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true) &&
            !exchange.requestMethod.equals("DELETE", ignoreCase = true)
        ) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val id = params["id"]?.toLongOrNull()
        if (id != null) {
            facade.removeBookmark(id)
        } else {
            val mangaId = params["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId' or 'id'")
            val chapterId = params["chapterId"].orEmpty()
            val page = params["page"]?.toIntOrNull() ?: 0
            facade.removeBookmarkForPage(mangaId, chapterId, page)
        }
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleBookmarkCheck(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val mangaId = params["mangaId"] ?: return respondError(exchange, 400, "Missing 'mangaId'")
        val chapterId = params["chapterId"].orEmpty()
        val page = params["page"]?.toIntOrNull() ?: 0
        respondJson(exchange, 200, buildJsonObject {
            put("bookmarked", facade.isPageBookmarked(mangaId, chapterId, page))
        })
    }

    private fun handleImage(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        // Accept ?u=<url>&h=Name:Value (repeated). Multi-value query params live
        // in the raw query string, so parse manually.
        val rawQuery = exchange.requestURI.rawQuery.orEmpty()
        val pairs = rawQuery.split('&').mapNotNull { p ->
            val idx = p.indexOf('=')
            if (idx <= 0) null else URLDecoder.decode(p.substring(0, idx), StandardCharsets.UTF_8) to
                URLDecoder.decode(p.substring(idx + 1), StandardCharsets.UTF_8)
        }
        // Older cached page lists can contain literal spaces from upstream HTML.
        // Encode those before validation/fetching without altering existing escapes.
        val url = pairs.firstOrNull { it.first == "u" }?.second?.replace(" ", "%20")
            ?: return respondError(exchange, 400, "Missing 'u'")
        val sourceIds = pairs.filter { it.first == "sourceId" }.map { it.second }
        val sourceId = sourceIds.singleOrNull()
        if (networkConfig.usesDesktopRelay) {
            if (sourceId == null) return respondError(exchange, 400, "Exactly one sourceId is required")
            if (com.nyora.hasan72341.shared.extension.DataDrivenCatalog.find(sourceId) == null) return respondError(exchange, 404, "Unknown source")
        }
        val headers = pairs.filter { it.first == "h" }.mapNotNull { (_, v) ->
            val colon = v.indexOf(':'); if (colon <= 0) null else v.substring(0, colon) to v.substring(colon + 1)
        }.toMap().toMutableMap()
        // Hotlink/Cloudflare-protected cover CDNs (e.g. AnisaScans) 403 a refererless
        // fetch, which turns into a 502 blank cover. proxyCoverUrl can only add a Referer
        // when it knows the source baseUrl — and parser sources carry an empty baseUrl, so
        // it never does. Mirror nyora-web's refererFromProxied: when no Referer was
        // supplied, derive one from the image's OWN origin. Fixes covers + page images for
        // every parser source in a single place.
        if (headers.keys.none { it.equals("Referer", ignoreCase = true) }) {
            runCatching {
                val u = java.net.URI(url)
                if (!u.scheme.isNullOrBlank() && !u.host.isNullOrBlank()) {
                    headers["Referer"] = "${u.scheme}://${u.host}/"
                }
            }
        }
        // This proxy is publicly reachable (Caddy → loopback), so the target is untrusted:
        // reject non-http URLs (no local-file reads) and private/internal hosts (no SSRF).
        try {
            if (networkConfig.usesDesktopRelay) com.nyora.hasan72341.shared.net.DesktopSourceRelay.assertPublicTarget(url)
            else SsrfGuard.assertPublicHttpUrl(url)
        } catch (_: Exception) {
            return respondError(exchange, 400, "Invalid image URL")
        }
        try {
            val lease = imageFetchLimiter.tryAcquire()
                ?: return respondError(exchange, 503, "Too many image fetches; retry shortly")
            lease.use {
                val bytes = pageLoader.loadBytes(url, headers, allowLocalFiles = false, blockPrivateHosts = true, sourceId = sourceId)
                val contentType = guessContentType(url, bytes)
                applyCors(exchange)
                exchange.responseHeaders.add("Content-Type", contentType)
                exchange.responseHeaders.add("Cache-Control", "private, max-age=86400")
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
        } catch (error: Exception) {
            respondError(exchange, 502, requestFailureMessage(error, "Image proxy failed"))
        }
    }

    private fun guessContentType(url: String, bytes: ByteArray): String {
        when {
            url.endsWith(".png", ignoreCase = true) -> return "image/png"
            url.endsWith(".webp", ignoreCase = true) -> return "image/webp"
            url.endsWith(".gif", ignoreCase = true) -> return "image/gif"
            url.endsWith(".jpg", ignoreCase = true) ||
                url.endsWith(".jpeg", ignoreCase = true) -> return "image/jpeg"
            url.endsWith(".avif", ignoreCase = true) -> return "image/avif"
        }
        // URL lacks a known extension — sniff magic bytes.
        return sniffImageType(bytes) ?: "application/octet-stream"
    }

    private fun sniffImageType(bytes: ByteArray): String? {
        if (bytes.size < 12) return null
        // JPEG: FF D8 FF
        if (bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()) {
            return "image/jpeg"
        }
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() &&
            bytes[2] == 0x4E.toByte() && bytes[3] == 0x47.toByte()
        ) return "image/png"
        // GIF: "GIF8"
        if (bytes[0] == 0x47.toByte() && bytes[1] == 0x49.toByte() &&
            bytes[2] == 0x46.toByte() && bytes[3] == 0x38.toByte()
        ) return "image/gif"
        // WEBP: RIFF....WEBP
        if (bytes[0] == 0x52.toByte() && bytes[1] == 0x49.toByte() &&
            bytes[2] == 0x46.toByte() && bytes[3] == 0x46.toByte() &&
            bytes[8] == 0x57.toByte() && bytes[9] == 0x45.toByte() &&
            bytes[10] == 0x42.toByte() && bytes[11] == 0x50.toByte()
        ) return "image/webp"
        // AVIF / HEIC: bytes 4..11 spell "ftypavif" / "ftypheic" / "ftypheix" etc.
        if (bytes[4] == 0x66.toByte() && bytes[5] == 0x74.toByte() &&
            bytes[6] == 0x79.toByte() && bytes[7] == 0x70.toByte()
        ) {
            val brand = String(bytes, 8, 4)
            return when (brand) {
                "avif", "avis" -> "image/avif"
                "heic", "heix", "mif1", "msf1" -> "image/heic"
                else -> null
            }
        }
        return null
    }

    private fun HttpExchange.query(): Map<String, String> {
        val raw = requestURI.rawQuery ?: return emptyMap()
        return raw.split('&').mapNotNull { p ->
            val idx = p.indexOf('=')
            if (idx <= 0) null else URLDecoder.decode(p.substring(0, idx), StandardCharsets.UTF_8) to
                URLDecoder.decode(p.substring(idx + 1), StandardCharsets.UTF_8)
        }.toMap()
    }

    private fun respondJson(exchange: HttpExchange, status: Int, body: kotlinx.serialization.json.JsonElement) {
        val bytes = json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), body)
            .toByteArray(StandardCharsets.UTF_8)
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    /** Respond with an already-serialized JSON string (used for cached responses). */
    private fun respondJsonRaw(exchange: HttpExchange, status: Int, body: String) {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun respondText(exchange: HttpExchange, status: Int, text: String) {
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "text/plain; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun requestFailureMessage(error: Throwable, fallback: String): String {
        if (networkConfig.usesDesktopRelay) {
            generateSequence(error) { it.cause }.take(16)
                .mapNotNull { it.message }.firstOrNull { "verification_required" in it }?.let { return it }
        }
        return error.message ?: fallback
    }

    private fun respondError(exchange: HttpExchange, status: Int, message: String) {
        val verification = networkConfig.usesDesktopRelay && "verification_required" in message
        respondJson(exchange, if (verification) 409 else status, buildJsonObject {
            put("error", message)
            if (verification) {
                put("code", "verification_required")
                Regex("sourceId=(data:[a-z0-9][a-z0-9._-]*)").find(message)?.groupValues?.get(1)?.let { put("sourceId", it) }
            }
        })
    }

    // ----- Nyora Sync Sync -----

    private fun handleNyoraSyncStatus(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val config = com.nyora.hasan72341.shared.sync.NyoraSyncConfig
        respondJson(exchange, 200, buildJsonObject {
            put("isConfigured", config.isConfigured)
            put("isAuthenticated", config.isAuthenticated)
            put("userId", config.userId)
            put("email", config.email)
            put("lastSyncTimestamp", config.lastSyncTimestamp)
            put("googleDesktopClientId", config.googleDesktopClientId)
            put("googleServerClientId", config.googleServerClientId)
        })
    }

    private fun handleNyoraSyncSignIn(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val email = params["email"]
        val password = params["password"]
        if (email.isNullOrBlank() || password.isNullOrBlank()) {
            return respondError(exchange, 400, "Missing 'email' or 'password'")
        }
        val error = facade.nyoraSyncSignIn(email, password)
        if (error == null) {
            respondJson(exchange, 200, buildJsonObject { put("ok", true) })
        } else {
            respondError(exchange, 401, error)
        }
    }

    private fun handleNyoraSyncRegister(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val params = exchange.query()
        val email = params["email"]
        val password = params["password"]
        if (email.isNullOrBlank() || password.isNullOrBlank()) {
            return respondError(exchange, 400, "Missing 'email' or 'password'")
        }
        val error = facade.nyoraSyncRegister(email, password)
        if (error == null) {
            respondJson(exchange, 200, buildJsonObject { put("ok", true) })
        } else {
            respondError(exchange, 401, error)
        }
    }

    private fun handleNyoraSyncSignOut(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        facade.nyoraSyncSignOut()
        respondJson(exchange, 200, buildJsonObject { put("ok", true) })
    }

    private fun handleNyoraSync(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        if (!com.nyora.hasan72341.shared.sync.NyoraSyncConfig.isAuthenticated) {
            respondError(exchange, 401, "Sign in to Nyora Sync first"); return
        }
        runCatching {
            facade.nyoraSyncNow()
        }.fold(
            onSuccess = { respondJson(exchange, 200, buildJsonObject { put("ok", true) }) },
            onFailure = { respondError(exchange, 500, it.message ?: "Nyora Sync sync failed") },
        )
    }

    private fun handleNyoraSyncRestoreFromCloud(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        if (!com.nyora.hasan72341.shared.sync.NyoraSyncConfig.isAuthenticated) {
            respondError(exchange, 401, "Sign in to Nyora Sync first"); return
        }
        runCatching {
            facade.nyoraSyncRestoreFromCloud()
        }.fold(
            onSuccess = { respondJson(exchange, 200, buildJsonObject { put("ok", true) }) },
            onFailure = { respondError(exchange, 500, it.message ?: "Nyora Sync restore failed") },
        )
    }

    private fun handleNyoraSyncHasLocalData(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val hasData = facade.hasLocalSyncableData()
        respondJson(exchange, 200, buildJsonObject { put("hasLocalData", hasData) })
    }

    // ----- OTA parser updates -----

    // Parsers are compiled in natively (kotatsu-parsers-redo); there is no OTA bundle.
    // These endpoints are kept for client compatibility and report the static state.
    private fun handleOtaStatus(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        respondJson(exchange, 200, buildJsonObject {
            put("bundledVersion", 0)
            put("otaVersion", 0)
            put("isActive", false)
        })
    }

    private fun handleOtaCheck(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        respondJson(exchange, 200, buildJsonObject {
            put("bundledVersion", 0)
            put("otaVersion", 0)
            put("isActive", false)
        })
    }

    // ----- Trackers (generic, all services) -----
    //
    // Every tracker — AniList / MyAnimeList / Kitsu / Shikimori / MangaBaka —
    // runs through the shared android-ported Scrobbler in the
    // scrobbling package. The desktop app holds each service's OAuth access
    // token (Keychain-backed in Swift) and sends it as `Authorization: Bearer`
    // on every call, so nothing is persisted helper-side: we build a throwaway
    // scrobbler seeded with that token per request. The scrobbler performs the
    // service-specific search + create-or-update (including Kitsu / Shikimori
    // user-id + rate-id resolution) internally, and we return a normalized JSON
    // shape the Swift client parses uniformly for every service.

    private val scrobblerHttp by lazy { okhttp3.OkHttpClient() }

    // Cloudflare-aware client (CloudflareInterceptor → native WebView solve on this
    // host + cf_clearance replay) for tracker endpoints behind a CF challenge —
    // notably Kitsu's OAuth token endpoint, which a bare POST can't pass.
    private val cfHttp by lazy { buildOkHttpClient(networkConfig.snapshot()) }

    /// The `<slug>` in `/tracker/<slug>/{search,scrobble}`.
    private fun trackerSlug(exchange: HttpExchange): String? =
        exchange.requestURI.path.split('/').getOrNull(2)?.takeIf { it.isNotBlank() }

    private fun scrobblerForRequest(
        exchange: HttpExchange,
        token: String,
    ): com.nyora.hasan72341.shared.scrobbling.Scrobbler? {
        val svc = com.nyora.hasan72341.shared.scrobbling.ScrobblerService.fromSlug(trackerSlug(exchange))
            ?: return null
        val store = com.nyora.hasan72341.shared.scrobbling.InMemoryScrobblerTokenStore(accessToken = token)
        return com.nyora.hasan72341.shared.scrobbling.ScrobblerRepository.create(svc, store, scrobblerHttp)
    }

    private fun handleTrackerSearch(exchange: HttpExchange) {
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing tracker token")
        val title = exchange.query()["title"]?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Missing 'title'")
        val scrobbler = scrobblerForRequest(exchange, token)
            ?: return respondError(exchange, 404, "Unknown tracker")
        val results = try {
            runBlocking { scrobbler.search(title) }
        } catch (_: Exception) {
            return respondError(exchange, 502, "Tracker search failed")
        }
        val out = buildJsonObject {
            putJsonArray("results") {
                results.take(10).forEach { m ->
                    add(
                        buildJsonObject {
                            put("id", m.id)
                            put("title", m.name)
                            m.altName?.let { put("altTitle", it) }
                            m.cover?.let { put("cover", it) }
                            put("url", m.url)
                        },
                    )
                }
            }
        }
        respondJson(exchange, 200, out)
    }

    private fun handleTrackerScrobble(exchange: HttpExchange) {
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing tracker token")
        val params = exchange.query()
        val mediaId = params["mediaId"]?.toLongOrNull()
            ?: return respondError(exchange, 400, "Missing 'mediaId'")
        val progress = params["progress"]?.toIntOrNull()
        val rating = params["rating"]?.toFloatOrNull()
        val status = com.nyora.hasan72341.shared.scrobbling.ScrobblingStatus.fromCanonical(params["status"])
            ?: com.nyora.hasan72341.shared.scrobbling.ScrobblingStatus.READING
        val scrobbler = scrobblerForRequest(exchange, token)
            ?: return respondError(exchange, 404, "Unknown tracker")
        val info = try {
            runBlocking {
                scrobbler.updateProgress(mediaId, chapter = progress, status = status, rating = rating, comment = null)
            }
        } catch (_: Exception) {
            return respondError(exchange, 502, "Tracker update failed")
        }
        val out = buildJsonObject {
            put("ok", true)
            put("rateId", info.rateId)
            put("progress", info.chapter)
            info.status?.let { put("status", it.canonical) }
        }
        respondJson(exchange, 200, out)
    }

    // Current tracking state for a linked media id (status / progress / score),
    // so clients can render + edit a manga's tracking without a local cache.
    private fun handleTrackerState(exchange: HttpExchange) {
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing tracker token")
        val mediaId = exchange.query()["mediaId"]?.toLongOrNull()
            ?: return respondError(exchange, 400, "Missing 'mediaId'")
        val scrobbler = scrobblerForRequest(exchange, token)
            ?: return respondError(exchange, 404, "Unknown tracker")
        val info = try {
            runBlocking { scrobbler.getState(mediaId) }
        } catch (_: Exception) {
            return respondError(exchange, 502, "Tracker state failed")
        }
        val out = if (info == null) {
            buildJsonObject { put("linked", false) }
        } else {
            buildJsonObject {
                put("linked", true)
                put("mediaId", info.remoteId)
                info.status?.let { put("status", it.canonical) }
                put("progress", info.chapter)
                put("score", info.rating) // 0f..1f
                put("title", info.title)
                info.coverUrl?.let { put("cover", it) }
                put("url", info.url)
            }
        }
        respondJson(exchange, 200, out)
    }

    // ----- Tracker OAuth bridge (server-side login for web / thin clients) -----
    //
    // Lets a browser log in to a tracker without hitting CORS or exposing client
    // secrets. The client opens /tracker/<slug>/authorize in a popup; we 302 it
    // to the provider consent page (redirect_uri points back at /callback here).
    // The provider returns to /tracker/<slug>/callback, we run the PKCE / secret
    // code exchange server-side and serve a tiny page that postMessages the token
    // back to the opener. AniList uses the implicit grant (token in the URL
    // fragment) so its callback reads the fragment client-side. Kitsu uses a
    // password grant via POST /tracker/kitsu/login (no popup).
    //
    // OAuth apps must be registered with redirect
    // https://<helper>/tracker/<slug>/callback; client ids/secrets come from env
    // NYORA_TRK_<SLUG>_ID / NYORA_TRK_<SLUG>_SECRET.

    private data class TrackerAuth(
        val slug: String,
        val authorizeUrl: String,
        val tokenUrl: String,
        val responseType: String, // "code" | "token"
        val pkce: String?,        // null | "plain" | "S256"
        val scope: String?,       // appended raw (mangabaka uses '+')
        val userAgent: String?,
        val needsSecret: Boolean,
    )

    private val trackerAuthConfig: Map<String, TrackerAuth> = mapOf(
        "anilist" to TrackerAuth(
            "anilist", "https://anilist.co/api/v2/oauth/authorize",
            "https://anilist.co/api/v2/oauth/token", "token", null, null, null, false,
        ),
        "myanimelist" to TrackerAuth(
            "myanimelist", "https://myanimelist.net/v1/oauth2/authorize",
            "https://myanimelist.net/v1/oauth2/token", "code", "plain", null, null, true,
        ),
        "shikimori" to TrackerAuth(
            "shikimori", "https://shikimori.io/oauth/authorize",
            "https://shikimori.io/oauth/token", "code", null, "user_rates", "Nyora", true,
        ),
        "bangumi" to TrackerAuth(
            "bangumi", "https://bgm.tv/oauth/authorize",
            "https://bgm.tv/oauth/access_token", "code", null, null,
            "Nyora (https://github.com/Nyora-Manga)", true,
        ),
        "mangabaka" to TrackerAuth(
            "mangabaka", "https://mangabaka.org/auth/oauth2/authorize",
            "https://mangabaka.org/auth/oauth2/token", "code", "S256",
            "library.read+library.write+profile+offline_access+openid", null, false,
        ),
    )

    private data class PendingAuth(val slug: String, val verifier: String?, val createdAt: Long)
    private val pendingAuth = java.util.concurrent.ConcurrentHashMap<String, PendingAuth>()

    private fun trackerEnv(slug: String, suffix: String): String? =
        System.getenv("NYORA_TRK_${slug.uppercase()}_$suffix")?.takeIf { it.isNotBlank() }

    private fun oauthPublicBaseUrl(exchange: HttpExchange): String {
        System.getenv("NYORA_PUBLIC_URL")?.takeIf { it.isNotBlank() }?.let { return it.trimEnd('/') }
        val proto = exchange.requestHeaders.getFirst("X-Forwarded-Proto") ?: "https"
        val host = exchange.requestHeaders.getFirst("X-Forwarded-Host")
            ?: exchange.requestHeaders.getFirst("Host") ?: "localhost"
        return "$proto://$host"
    }

    private fun oauthPathSlug(exchange: HttpExchange): String? =
        exchange.requestURI.path.split('/').getOrNull(2)?.takeIf { it.isNotBlank() }

    private fun oauthRandomToken(): String {
        val bytes = ByteArray(32)
        java.security.SecureRandom().nextBytes(bytes)
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun oauthS256(verifier: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(verifier.toByteArray(StandardCharsets.UTF_8))
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    private fun handleTrackerAuthorize(exchange: HttpExchange) {
        val slug = oauthPathSlug(exchange) ?: return respondError(exchange, 400, "bad slug")
        val cfg = trackerAuthConfig[slug] ?: return respondError(exchange, 404, "unknown tracker")
        val clientId = trackerEnv(slug, "ID")
            ?: return respondError(exchange, 501, "tracker '$slug' is not configured on this server")
        val state = oauthRandomToken()
        val redirectUri = "${oauthPublicBaseUrl(exchange)}/tracker/$slug/callback"
        val sb = StringBuilder(cfg.authorizeUrl)
        sb.append("?client_id=").append(urlEncode(clientId))
        sb.append("&redirect_uri=").append(urlEncode(redirectUri))
        sb.append("&response_type=").append(cfg.responseType)
        sb.append("&state=").append(urlEncode(state))
        var verifier: String? = null
        if (cfg.pkce != null) {
            verifier = oauthRandomToken()
            val challenge = if (cfg.pkce == "S256") oauthS256(verifier) else verifier
            sb.append("&code_challenge=").append(urlEncode(challenge))
            sb.append("&code_challenge_method=").append(cfg.pkce)
        }
        if (cfg.scope != null) sb.append("&scope=").append(cfg.scope)
        // Prune expired pending auths (>10 min) and record this one.
        val cutoff = System.currentTimeMillis() - 600_000L
        pendingAuth.entries.removeIf { it.value.createdAt < cutoff }
        pendingAuth[state] = PendingAuth(slug, verifier, System.currentTimeMillis())
        applyCors(exchange)
        exchange.responseHeaders.add("Location", sb.toString())
        exchange.sendResponseHeaders(302, -1)
        exchange.close()
    }

    private fun handleTrackerCallback(exchange: HttpExchange) {
        val slug = oauthPathSlug(exchange) ?: return respondText(exchange, 400, "bad slug")
        val cfg = trackerAuthConfig[slug]
        // AniList (implicit): the token is in the URL fragment, invisible server-side.
        if (cfg != null && cfg.responseType == "token") {
            respondHtml(exchange, 200, oauthImplicitCallbackHtml(slug))
            return
        }
        val params = exchange.query()
        val err = params["error"]
        val code = params["code"]
        val state = params["state"]
        if (cfg == null || err != null || code.isNullOrBlank() || state.isNullOrBlank()) {
            respondHtml(exchange, 200, oauthTokenCallbackHtml(slug, state, null, err ?: "no_code"))
            return
        }
        val pending = pendingAuth.remove(state)
        if (pending == null || pending.slug != slug) {
            respondHtml(exchange, 200, oauthTokenCallbackHtml(slug, state, null, "bad_state"))
            return
        }
        val raw = try {
            val clientId = trackerEnv(slug, "ID") ?: error("no client id")
            val redirectUri = "${oauthPublicBaseUrl(exchange)}/tracker/$slug/callback"
            val form = StringBuilder()
            fun add(k: String, v: String) {
                if (form.isNotEmpty()) form.append('&')
                form.append(urlEncode(k)).append('=').append(urlEncode(v))
            }
            add("grant_type", "authorization_code")
            add("client_id", clientId)
            add("code", code)
            add("redirect_uri", redirectUri)
            if (cfg.needsSecret) add("client_secret", trackerEnv(slug, "SECRET") ?: error("no secret"))
            if (pending.verifier != null) add("code_verifier", pending.verifier)
            serviceRequest(
                url = cfg.tokenUrl,
                method = "POST",
                bearer = null,
                body = form.toString().toByteArray(StandardCharsets.UTF_8),
                contentType = "application/x-www-form-urlencoded",
                accept = "application/json",
                userAgent = cfg.userAgent,
            ) ?: error("token request failed")
        } catch (_: Exception) {
            respondHtml(exchange, 200, oauthTokenCallbackHtml(slug, state, null, "exchange_failed"))
            return
        }
        val obj = try {
            json.parseToJsonElement(raw).jsonObject
        } catch (_: Exception) {
            respondHtml(exchange, 200, oauthTokenCallbackHtml(slug, state, null, "bad_token_response"))
            return
        }
        respondHtml(exchange, 200, oauthTokenCallbackHtml(slug, state, obj, null))
    }

    private fun handleKitsuLogin(exchange: HttpExchange) {
        if (maybePreflight(exchange)) return
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val creds = try {
            json.parseToJsonElement(exchange.requestBody.readBytes().toString(StandardCharsets.UTF_8)).jsonObject
        } catch (_: Exception) {
            return respondError(exchange, 400, "bad body")
        }
        val username = creds["username"]?.jsonPrimitive?.contentOrNull
            ?: return respondError(exchange, 400, "missing username")
        val password = creds["password"]?.jsonPrimitive?.contentOrNull
            ?: return respondError(exchange, 400, "missing password")
        val form = "grant_type=password&username=${urlEncode(username)}&password=${urlEncode(password)}" +
            "&client_id=dd031b32d2f56c990b1425efe6c42ad847e7fe3ab46bf1299f05ecd856bdb7dd" +
            "&client_secret=54d7307928f63414defd96399fc31ba847961ceaecef3a5fd93144e960c0e151"
        // Kitsu's OAuth token endpoint sits behind a Cloudflare "Just a moment"
        // challenge (403 cf-mitigated). Go through cfHttp so the CloudflareInterceptor
        // clears it (native WebView solve on this host) and replays the POST with the
        // cf_clearance cookie. The public /api/edge/* endpoints aren't challenged.
        val resp = try {
            val req = okhttp3.Request.Builder()
                .url("https://kitsu.app/api/oauth/token")
                .header("Accept", "application/json")
                .post(form.toRequestBody("application/x-www-form-urlencoded".toMediaType()))
                .build()
            cfHttp.newCall(req).execute().use { it.body?.string() }
        } catch (_: Exception) {
            null
        } ?: return respondError(exchange, 502, "kitsu login failed")
        respondJsonRaw(exchange, 200, resp)
    }

    private fun oauthImplicitCallbackHtml(slug: String): String = """<!doctype html>
<html><body>Connecting…<script>
(function(){
  var h = new URLSearchParams((location.hash||'').replace(/^#/,''));
  var msg = { source:'nyora-tracker', slug:${oauthJsStr(slug)} };
  var t = h.get('access_token');
  if (t) { msg.access_token = t; } else { msg.error = h.get('error') || 'no_token'; }
  var st = h.get('state'); if (st) msg.state = st;
  try { if (window.opener) window.opener.postMessage(msg, '*'); } catch(e){}
  document.body.textContent = t ? 'Connected. You can close this window.' : 'Sign-in failed.';
  setTimeout(function(){ try{ window.close(); }catch(e){} }, 400);
})();
</script></body></html>"""

    private fun oauthTokenCallbackHtml(slug: String, state: String?, token: JsonObject?, error: String?): String {
        val payload = buildJsonObject {
            put("source", "nyora-tracker")
            put("slug", slug)
            if (state != null) put("state", state)
            if (error != null) put("error", error)
            val access = token?.get("access_token")?.jsonPrimitive?.contentOrNull
            val refresh = token?.get("refresh_token")?.jsonPrimitive?.contentOrNull
            if (access != null) put("access_token", access)
            if (refresh != null) put("refresh_token", refresh)
        }
        val payloadJson = json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), payload)
            .replace("<", "\\u003c")
        return """<!doctype html>
<html><body>Connecting…<script>
(function(){
  var msg = $payloadJson;
  try { if (window.opener) window.opener.postMessage(msg, '*'); } catch(e){}
  document.body.textContent = msg.error ? 'Sign-in failed.' : 'Connected. You can close this window.';
  setTimeout(function(){ try{ window.close(); }catch(e){} }, 400);
})();
</script></body></html>"""
    }

    private fun oauthJsStr(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("<", "\\u003c") + "\""

    private fun respondHtml(exchange: HttpExchange, status: Int, html: String) {
        val bytes = html.toByteArray(StandardCharsets.UTF_8)
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    // ----- Tracker: AniList (legacy per-service passthrough, superseded above) -----
    //
    // The Mac app sends the user's AniList personal access token in the
    // Authorization header on each call so we never persist credentials on
    // the helper side. Token storage is Keychain-backed up in Swift.

    private fun handleAniListSearch(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = exchange.requestHeaders.getFirst("Authorization")
            ?.removePrefix("Bearer ")?.trim()
        if (token.isNullOrBlank()) {
            return respondError(exchange, 401, "Missing AniList token")
        }
        val title = exchange.query()["title"]?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Missing 'title'")
        val query = """
            query (${'$'}search: String) {
              Page(perPage: 5) {
                media(search: ${'$'}search, type: MANGA) {
                  id
                  title { romaji english native }
                  coverImage { large }
                  averageScore
                  chapters
                }
              }
            }
        """.trimIndent()
        val body = buildJsonObject {
            put("query", query)
            put("variables", buildJsonObject { put("search", title) })
        }
        val raw = postJson("https://graphql.anilist.co", body, bearer = token)
            ?: return respondError(exchange, 502, "AniList request failed")
        // Pass the AniList response straight through; UI parses on the Swift side.
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    private fun handleAniListScrobble(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = exchange.requestHeaders.getFirst("Authorization")
            ?.removePrefix("Bearer ")?.trim()
        if (token.isNullOrBlank()) {
            return respondError(exchange, 401, "Missing AniList token")
        }
        val params = exchange.query()
        val mediaId = params["mediaId"]?.toIntOrNull()
            ?: return respondError(exchange, 400, "Missing 'mediaId'")
        val progress = params["progress"]?.toIntOrNull() ?: 0
        val status = params["status"] ?: "CURRENT"
        val mutation = """
            mutation (${'$'}mediaId: Int, ${'$'}progress: Int, ${'$'}status: MediaListStatus) {
              SaveMediaListEntry(mediaId: ${'$'}mediaId, progress: ${'$'}progress, status: ${'$'}status) {
                id progress status
              }
            }
        """.trimIndent()
        val body = buildJsonObject {
            put("query", mutation)
            put("variables", buildJsonObject {
                put("mediaId", mediaId)
                put("progress", progress)
                put("status", status)
            })
        }
        val raw = postJson("https://graphql.anilist.co", body, bearer = token)
            ?: return respondError(exchange, 502, "AniList request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    // ----- Tracker: MyAnimeList / Kitsu / Shikimori -----
    //
    // Like AniList above, these are thin bearer-token passthroughs: the desktop
    // app holds the OAuth access token (Keychain-backed in Swift) and sends it
    // in the Authorization header on every call, so no credentials are persisted
    // helper-side. Each handler forwards a single request to the upstream service
    // API and streams the raw JSON straight back; the UI parses on the client.

    private fun bearerOrNull(exchange: HttpExchange): String? =
        exchange.requestHeaders.getFirst("Authorization")
            ?.removePrefix("Bearer ")?.trim()?.takeIf { it.isNotBlank() }

    /// Perform an outbound request to a tracker API and pass the raw body back.
    /// Handles GET/POST/PUT/PATCH; PATCH (unsupported by HttpURLConnection) is
    /// tunnelled through POST + X-HTTP-Method-Override, which both Kitsu and
    /// Shikimori honour. Returns null on transport failure.
    private fun serviceRequest(
        url: String,
        method: String,
        bearer: String?,
        body: ByteArray? = null,
        contentType: String? = null,
        accept: String? = "application/json",
        userAgent: String? = null,
    ): String? {
        return try {
            val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                try {
                    requestMethod = method
                } catch (_: java.net.ProtocolException) {
                    // HttpURLConnection rejects PATCH; tunnel it via POST override.
                    requestMethod = "POST"
                    setRequestProperty("X-HTTP-Method-Override", method)
                }
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = true
                if (accept != null) setRequestProperty("Accept", accept)
                if (userAgent != null) setRequestProperty("User-Agent", userAgent)
                if (bearer != null) setRequestProperty("Authorization", "Bearer $bearer")
                if (body != null) {
                    doOutput = true
                    if (contentType != null) setRequestProperty("Content-Type", contentType)
                }
            }
            if (body != null) conn.outputStream.use { it.write(body) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }
        } catch (_: Exception) {
            null
        }
    }

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, StandardCharsets.UTF_8)

    // --- MyAnimeList (REST v2) ---

    private fun handleMalSearch(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing MyAnimeList token")
        val title = exchange.query()["title"]?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Missing 'title'")
        // MAL 400s on q longer than 64 chars.
        val url = "https://api.myanimelist.net/v2/manga?q=${urlEncode(title.take(64))}" +
            "&limit=5&nsfw=true&fields=id,title,main_picture,synopsis"
        val raw = serviceRequest(url, "GET", token)
            ?: return respondError(exchange, 502, "MyAnimeList request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    private fun handleMalScrobble(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing MyAnimeList token")
        val params = exchange.query()
        val mediaId = params["mediaId"]?.toLongOrNull()
            ?: return respondError(exchange, 400, "Missing 'mediaId'")
        // Build the my_list_status form body from whatever the client supplies.
        val form = buildList {
            params["progress"]?.toIntOrNull()?.let { add("num_chapters_read=$it") }
            params["status"]?.takeIf { it.isNotBlank() }?.let { add("status=${urlEncode(it)}") }
            params["score"]?.toIntOrNull()?.let { add("score=${it.coerceIn(0, 10)}") }
            params["comment"]?.let { add("comments=${urlEncode(it)}") }
        }.joinToString("&")
        val raw = serviceRequest(
            url = "https://api.myanimelist.net/v2/manga/$mediaId/my_list_status",
            method = "PUT",
            bearer = token,
            body = form.toByteArray(StandardCharsets.UTF_8),
            contentType = "application/x-www-form-urlencoded",
        ) ?: return respondError(exchange, 502, "MyAnimeList request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    // --- Kitsu (JSON:API) ---

    private fun handleKitsuSearch(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing Kitsu token")
        val title = exchange.query()["title"]?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Missing 'title'")
        val url = "https://kitsu.app/api/edge/manga?page[limit]=5&filter[text]=${urlEncode(title)}"
        val raw = serviceRequest(url, "GET", token, accept = "application/vnd.api+json")
            ?: return respondError(exchange, 502, "Kitsu request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    private fun handleKitsuScrobble(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing Kitsu token")
        val params = exchange.query()
        // rateId present -> PATCH an existing library-entry; else POST create
        // (needs mediaId + userId, which the client resolves via /users?self).
        val rateId = params["rateId"]?.takeIf { it.isNotBlank() }
        val attrs = buildJsonObject {
            params["progress"]?.toIntOrNull()?.let { put("progress", it) }
            params["status"]?.takeIf { it.isNotBlank() }?.let { put("status", it) }
            params["ratingTwenty"]?.toIntOrNull()?.let { put("ratingTwenty", it.coerceIn(2, 20)) }
            params["comment"]?.let { put("notes", it) }
        }
        val (url, method, payload) = if (rateId != null) {
            val body = buildJsonObject {
                putJsonObject("data") {
                    put("type", "libraryEntries")
                    put("id", rateId)
                    put("attributes", attrs)
                }
            }
            Triple("https://kitsu.app/api/edge/library-entries/$rateId", "PATCH", body)
        } else {
            val mediaId = params["mediaId"]?.takeIf { it.isNotBlank() }
                ?: return respondError(exchange, 400, "Missing 'mediaId' or 'rateId'")
            val userId = params["userId"]?.takeIf { it.isNotBlank() }
                ?: return respondError(exchange, 400, "Missing 'userId' for create")
            val body = buildJsonObject {
                putJsonObject("data") {
                    put("type", "libraryEntries")
                    put("attributes", attrs)
                    putJsonObject("relationships") {
                        putJsonObject("manga") {
                            putJsonObject("data") { put("type", "manga"); put("id", mediaId) }
                        }
                        putJsonObject("user") {
                            putJsonObject("data") { put("type", "users"); put("id", userId) }
                        }
                    }
                }
            }
            Triple("https://kitsu.app/api/edge/library-entries", "POST", body)
        }
        val raw = serviceRequest(
            url = url,
            method = method,
            bearer = token,
            body = json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), payload)
                .toByteArray(StandardCharsets.UTF_8),
            contentType = "application/vnd.api+json",
            accept = "application/vnd.api+json",
        ) ?: return respondError(exchange, 502, "Kitsu request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    // --- Shikimori (REST v2) ---

    private fun handleShikimoriSearch(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing Shikimori token")
        val title = exchange.query()["title"]?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Missing 'title'")
        val url = "https://shikimori.one/api/mangas?limit=10&censored=false&search=${urlEncode(title)}"
        val raw = serviceRequest(url, "GET", token, userAgent = "Nyora")
            ?: return respondError(exchange, 502, "Shikimori request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    private fun handleShikimoriScrobble(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val token = bearerOrNull(exchange) ?: return respondError(exchange, 401, "Missing Shikimori token")
        val params = exchange.query()
        // rateId present -> PATCH the user_rate; else POST create (needs mediaId + userId).
        val rateId = params["rateId"]?.takeIf { it.isNotBlank() }
        val payload = buildJsonObject {
            putJsonObject("user_rate") {
                if (rateId == null) {
                    params["mediaId"]?.toLongOrNull()?.let { put("target_id", it) }
                    put("target_type", "Manga")
                    params["userId"]?.toLongOrNull()?.let { put("user_id", it) }
                }
                params["progress"]?.toIntOrNull()?.let { put("chapters", it) }
                params["status"]?.takeIf { it.isNotBlank() }?.let { put("status", it) }
                params["score"]?.toIntOrNull()?.let { put("score", it.coerceIn(0, 10)) }
                params["comment"]?.let { put("text", it) }
            }
        }
        if (rateId == null &&
            (params["mediaId"]?.toLongOrNull() == null || params["userId"]?.toLongOrNull() == null)
        ) {
            return respondError(exchange, 400, "Missing 'rateId' or ('mediaId' and 'userId')")
        }
        val url = if (rateId != null) {
            "https://shikimori.one/api/v2/user_rates/$rateId"
        } else {
            "https://shikimori.one/api/v2/user_rates"
        }
        val raw = serviceRequest(
            url = url,
            method = if (rateId != null) "PATCH" else "POST",
            bearer = token,
            body = json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), payload)
                .toByteArray(StandardCharsets.UTF_8),
            contentType = "application/json",
            userAgent = "Nyora",
        ) ?: return respondError(exchange, 502, "Shikimori request failed")
        respondText(exchange, 200, raw)
        exchange.responseHeaders.set("Content-Type", "application/json")
    }

    /// POST a JSON body to `url`. Returns the response body string on 2xx,
    /// null otherwise. Used for AniList GraphQL.
    private fun postJson(url: String, body: kotlinx.serialization.json.JsonElement, bearer: String? = null): String? {
        return try {
            val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                if (bearer != null) setRequestProperty("Authorization", "Bearer $bearer")
            }
            val payload = json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), body)
                .toByteArray(StandardCharsets.UTF_8)
            conn.outputStream.use { it.write(payload) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }
        } catch (_: Exception) {
            null
        }
    }

    // ----- Filters -----

    /// Returns the per-source filter descriptors so the UI can render
    /// genre / sort / status pickers driven by what the parser actually supports.
    private fun handleFilters(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val id = exchange.query()["id"] ?: return respondError(exchange, 400, "Missing 'id'")
        val source = facade.listSources().firstOrNull { it.id == id }
            ?: return respondError(exchange, 404, "Unknown source: $id")
        val options = try {
            runBlocking { openInstalled(source).getBrowseOptions() }
        } catch (error: Exception) {
            respondError(exchange, 502, "Could not load source filters"); return
        }
        val arr = options.filters.map { d ->
            buildJsonObject {
                put("name", d.name)
                put("typeName", d.typeName)
                put("multiple", d.multiple)
                put("values", kotlinx.serialization.json.JsonArray(
                    d.values.map { kotlinx.serialization.json.JsonPrimitive(it) }
                ))
            }
        }
        respondJson(exchange, 200, buildJsonObject {
            put("filters", kotlinx.serialization.json.JsonArray(arr))
            put("tags", kotlinx.serialization.json.JsonArray(options.tags.map { (key, title) ->
                buildJsonObject { put("key", key); put("title", title) }
            }))
            put("multipleTags", options.multipleTags)
            put("tagsExclusion", options.tagsExclusion)
            put("searchWithFilters", options.searchWithFilters)
        })
    }

    /// Turn the wire-format filter array into the typed SourceFilter list.
    /// Unknown types are silently skipped.
    private fun parseFilters(raw: String?): List<com.nyora.hasan72341.shared.extension.SourceFilter> {
        if (raw.isNullOrBlank()) return emptyList()
        val arr = try {
            json.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonArray
        } catch (_: Exception) { null } ?: return emptyList()
        return arr.mapNotNull { el ->
            val obj = el as? JsonObject ?: return@mapNotNull null
            val name = obj["name"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                "text" -> com.nyora.hasan72341.shared.extension.TextSourceFilter(
                    name = name,
                    value = obj["value"]?.jsonPrimitive?.contentOrNull ?: ""
                )
                "select" -> com.nyora.hasan72341.shared.extension.SelectSourceFilter(
                    name = name,
                    selectedIndex = obj["selectedIndex"]?.jsonPrimitive?.intOrNull ?: 0
                )
                "check" -> com.nyora.hasan72341.shared.extension.CheckSourceFilter(
                    name = name,
                    checked = obj["checked"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false
                )
                else -> null
            }
        }
    }

    // ----- Stats -----

    private fun handleStats(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val history = facade.history(limit = 5000)
        val totalChapters = history.size
        val distinctManga = history.map { row -> row.manga.id }.distinct().size
        val sources = facade.listSources().associateBy { it.id }
        val perSource: List<kotlinx.serialization.json.JsonElement> = history
            .groupingBy { row -> row.sourceId }.eachCount()
            .entries.sortedByDescending { it.value }
            .take(5)
            .map { entry ->
                val sid = entry.key
                val count = entry.value
                buildJsonObject {
                    put("sourceId", sid)
                    put("sourceName", sources[sid]?.name ?: sid)
                    put("count", count)
                }
            }
        // Reading streak: consecutive days that have at least one history entry,
        // counting back from the most recent day in the history.
        val days = history.map { it.updatedAt / 86_400_000L }.toSet().sortedDescending()
        var streak = 0
        if (days.isNotEmpty()) {
            var cursor = days.first()
            for (d in days) {
                if (d == cursor || d == cursor - 1) {
                    if (d != cursor) streak++
                    cursor = d
                }
            }
            streak += 1 // include the first day
        }
        val payload = buildJsonObject {
            put("totalChapters", totalChapters)
            put("distinctManga", distinctManga)
            put("favouritesCount", facade.favourites().size)
            put("longestStreakDays", streak)
            put("topSources", kotlinx.serialization.json.JsonArray(perSource))
        }
        respondJson(exchange, 200, payload)
    }

    // ----- Suggestions -----

    private fun handleSuggestions(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        // Pick a recent favourite as the seed and pull its source's popular
        // list, filtering out anything the user already favourited.
        val favs = facade.favourites()
        if (favs.isEmpty()) {
            respondJson(exchange, 200, buildJsonObject { put("entries", kotlinx.serialization.json.JsonArray(emptyList())) })
            return
        }
        val favIds = favs.map { it.id }.toSet()
        val seed = favs.first()
        val seedSrcId = openableHistorySourceId(seed.source, "")
        val seedSource = facade.listSources().firstOrNull { it.id == seedSrcId }
        val parserSource = seedSource ?: facade.listSources().firstOrNull {
            it.engine == com.nyora.hasan72341.shared.model.SourceEngine.JavaScript && it.isInstalled
        }
        if (parserSource == null) {
            respondJson(exchange, 200, buildJsonObject { put("entries", kotlinx.serialization.json.JsonArray(emptyList())) })
            return
        }
        val service = openInstalled(parserSource)
        val list: List<com.nyora.hasan72341.shared.model.Manga> = try {
            kotlinx.coroutines.runBlocking { service.getPopular(page = 1).entries }
        } catch (_: Exception) {
            emptyList()
        }
        val filtered: List<kotlinx.serialization.json.JsonElement> = list
            .filter { it.id !in favIds }
            .take(30)
            .map { mangaToJson(it) }
        respondJson(exchange, 200, buildJsonObject {
            put("entries", kotlinx.serialization.json.JsonArray(filtered))
        })
    }

    // ----- Alternative sources -----

    private fun handleAlternatives(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val query = exchange.query()["title"]?.takeIf { it.isNotBlank() }
            ?: return respondError(exchange, 400, "Missing 'title'")
        val sources = facade.listSources()
            .filter { it.isInstalled && it.engine == com.nyora.hasan72341.shared.model.SourceEngine.JavaScript }
        val results = mutableListOf<kotlinx.serialization.json.JsonElement>()
        for (src in sources) {
            val service = openInstalled(src)
            val matches: List<com.nyora.hasan72341.shared.model.Manga> = try {
                kotlinx.coroutines.runBlocking { service.search(query, page = 1).entries }
            } catch (_: Exception) {
                emptyList()
            }
            for (m in matches.take(3)) {
                if (m.title.lowercase().contains(query.lowercase()) ||
                    query.lowercase().contains(m.title.lowercase())) {
                    results.add(buildJsonObject {
                        put("sourceId", src.id)
                        put("sourceName", src.name)
                        put("manga", mangaToJson(m))
                    })
                }
            }
            if (results.size > 40) break // safety cap
        }
        respondJson(exchange, 200, buildJsonObject {
            put("entries", kotlinx.serialization.json.JsonArray(results))
        })
    }

    // ----- Backup -----

    private fun handleBackupExport(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val repository = backupRepository
            ?: return respondError(exchange, 503, "Portable backup storage is unavailable")
        val bytes = try {
            com.nyora.hasan72341.shared.backup.NyoraBackupExporter(
                repository,
                appVersion = backupAppVersion,
                platform = backupPlatform,
            ).export()
        } catch (e: Exception) {
            respondError(exchange, 500, "Backup failed: ${e.message}"); return
        }
        val stamp = java.time.LocalDateTime.now()
            .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm"))
        applyCors(exchange)
        exchange.responseHeaders.add("Content-Type", "application/vnd.nyora.backup")
        exchange.responseHeaders.add("Content-Disposition", "attachment; filename=\"nyora_$stamp.nyorabk\"")
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun handleBackupPlan(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val repository = backupRepository
            ?: return respondError(exchange, 503, "Portable backup storage is unavailable")
        val mode = com.nyora.hasan72341.shared.backup.NyoraRestoreMode.parse(exchange.query()["mode"])
            ?: return respondError(exchange, 400, "mode must be merge or replace")
        val bytes = readBackupBody(exchange) ?: return
        val plan = try {
            com.nyora.hasan72341.shared.backup.NyoraBackupImporter(repository).plan(bytes, mode)
        } catch (e: com.nyora.hasan72341.shared.backup.NyoraBackupCodec.InvalidBackupException) {
            respondError(exchange, 400, e.message ?: "Invalid backup file"); return
        } catch (e: Exception) {
            respondError(exchange, 500, "Backup planning failed: ${e.message}"); return
        }
        respondJson(exchange, 200, json.encodeToJsonElement(plan))
    }

    private fun handleBackupImport(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
            respondText(exchange, 405, "Method not allowed"); return
        }
        val repository = backupRepository
            ?: return respondError(exchange, 503, "Portable backup storage is unavailable")
        val mode = com.nyora.hasan72341.shared.backup.NyoraRestoreMode.parse(exchange.query()["mode"])
            ?: return respondError(exchange, 400, "mode must be merge or replace")
        val bytes = readBackupBody(exchange) ?: return
        val result = try {
            com.nyora.hasan72341.shared.backup.NyoraBackupImporter(repository).apply(bytes, mode)
        } catch (e: com.nyora.hasan72341.shared.backup.NyoraBackupCodec.InvalidBackupException) {
            respondError(exchange, 400, e.message ?: "Invalid backup file"); return
        } catch (e: Exception) {
            respondError(exchange, 500, "Restore failed: ${e.message}"); return
        }
        respondJson(exchange, 200, json.encodeToJsonElement(result))
    }

    private fun readBackupBody(exchange: HttpExchange): ByteArray? {
        val declared = exchange.requestHeaders.getFirst("Content-Length")?.toLongOrNull()
        if (declared != null && declared > BACKUP_MAX_BYTES) {
            respondError(exchange, 413, "Backup archive is too large")
            return null
        }
        val bytes = exchange.requestBody.use { it.readNBytes(BACKUP_MAX_BYTES + 1) }
        if (bytes.isEmpty()) {
            respondError(exchange, 400, "Empty request body")
            return null
        }
        if (bytes.size > BACKUP_MAX_BYTES) {
            respondError(exchange, 413, "Backup archive is too large")
            return null
        }
        return bytes
    }

    /// Compact JSON projection of a Manga used by suggestions/alternatives.
    private fun mangaToJson(m: com.nyora.hasan72341.shared.model.Manga): kotlinx.serialization.json.JsonElement {
        val sid = openableHistorySourceId(m.source, "")
        return buildJsonObject {
            put("id", m.id)
            put("title", m.title)
            put("coverUrl", m.coverUrl)
            put("sourceId", sid)
            put("publicUrl", m.publicUrl)
            put("description", m.description)
        }
    }
}

/** Self-contained Swagger UI page (CDN assets) that loads the spec from same-origin /openapi.yaml. */
private val SWAGGER_UI_HTML: String = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Nyora Parser API — Reference</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #0f1115; }
    .nyora-topbar { display:flex; align-items:center; gap:14px; padding:14px 22px;
      background:#15181f; border-bottom:1px solid #262b36;
      font:600 16px/1.2 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; color:#e8eaed; }
    .nyora-topbar .dot { width:10px; height:10px; border-radius:50%; background:#6ea8fe; }
    .nyora-topbar .spacer { flex:1; }
    .nyora-topbar a { font-size:13px; font-weight:500; color:#9bb7ff; text-decoration:none;
      padding:6px 10px; border:1px solid #2c3344; border-radius:8px; }
    .nyora-topbar a:hover { background:#1c212c; }
    .swagger-ui .topbar { display:none; }
  </style>
</head>
<body>
  <div class="nyora-topbar">
    <span class="dot"></span><span>Nyora Parser API</span>
    <span class="spacer"></span><a href="/openapi.yaml" download>openapi.yaml</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "/openapi.yaml",
      dom_id: "#swagger-ui",
      deepLinking: true,
      docExpansion: "list",
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 3,
      tryItOutEnabled: true,
      filter: true,
      displayRequestDuration: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: "StandaloneLayout"
    });
  </script>
</body>
</html>
""".trimIndent()

/**
 * HTTP server executor. On JDK 21+ this is a virtual-thread-per-task executor (Project
 * Loom): each request runs on its own cheap virtual thread, so thousands of concurrent,
 * I/O-bound parser requests cost ~tens of MB instead of one OS-thread stack each — the
 * key to serving ~1k users in a tight RAM budget. Falls back to a bounded pool pre-21.
 */
/**
 * Overload + abuse guard applied to every route. Two protections so the small VM
 * degrades gracefully under load (target: survive 5k users) instead of thrashing:
 *  - Global in-flight cap → shed excess with 503 (bounds threads/memory/CPU).
 *  - Per-client-IP token bucket → one abuser can't monopolize the box (429).
 * Loopback + long-poll (device relay) bypass the caps. Tunable via env.
 */
// Browser origins allowed to read the API cross-origin: nyora.xyz + any subdomain (and localhost
// for local dev). Overridable via NYORA_ALLOWED_ORIGINS (comma-separated host suffixes). Other
// origins get no ACAO header, so their browser blocks the response; native clients (iOS/desktop)
// send no Origin and are unaffected.
private val ALLOWED_ORIGIN_SUFFIXES: List<String> =
    System.getenv("NYORA_ALLOWED_ORIGINS")
        ?.split(",")?.map { it.trim() }?.filter { it.isNotBlank() }
        ?: listOf("nyora.xyz")

/** Returns the request Origin to echo in Access-Control-Allow-Origin, or null if it isn't allowed. */
private fun allowedCorsOrigin(exchange: HttpExchange): String? {
    val origin = exchange.requestHeaders.getFirst("Origin") ?: return null
    val host = runCatching { java.net.URI(origin).host }.getOrNull()?.lowercase() ?: return null
    val allowed = host == "localhost" || host == "127.0.0.1" ||
        ALLOWED_ORIGIN_SUFFIXES.any { host == it || host.endsWith(".$it") }
    return if (allowed) origin else null
}

private object GuardFilter : Filter() {
    private val maxInFlight = System.getenv("NYORA_MAX_INFLIGHT")?.toIntOrNull() ?: 150
    private val perIpRate = System.getenv("NYORA_PER_IP_RATE")?.toDoubleOrNull() ?: 25.0   // tokens/sec
    private val perIpBurst = System.getenv("NYORA_PER_IP_BURST")?.toDoubleOrNull() ?: 60.0

    private val inFlight = java.util.concurrent.atomic.AtomicInteger(0)

    private class Bucket(var tokens: Double, var last: Long)
    private val buckets = java.util.concurrent.ConcurrentHashMap<String, Bucket>()

    private fun clientIp(exchange: HttpExchange): String {
        exchange.requestHeaders.getFirst("X-Real-IP")?.let { if (it.isNotBlank()) return it.trim() }
        exchange.requestHeaders.getFirst("X-Forwarded-For")?.let {
            val first = it.substringBefore(',').trim(); if (first.isNotBlank()) return first
        }
        return exchange.remoteAddress?.address?.hostAddress ?: "?"
    }

    private fun allow(ip: String): Boolean {
        val now = System.currentTimeMillis()
        val b = buckets.computeIfAbsent(ip) { Bucket(perIpBurst, now) }
        synchronized(b) {
            b.tokens = minOf(perIpBurst, b.tokens + (now - b.last) / 1000.0 * perIpRate)
            b.last = now
            if (buckets.size > 20_000) buckets.clear() // crude cap so the map can't grow unbounded
            if (b.tokens < 1.0) return false
            b.tokens -= 1.0
            return true
        }
    }

    private fun reject(exchange: HttpExchange, code: Int, msg: String) {
        try {
            val bytes = msg.toByteArray()
            allowedCorsOrigin(exchange)?.let { exchange.responseHeaders.add("Access-Control-Allow-Origin", it) }
            exchange.responseHeaders.add("Retry-After", "2")
            exchange.sendResponseHeaders(code, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        } catch (_: Throwable) { /* client gone */ } finally { exchange.close() }
    }

    override fun doFilter(exchange: HttpExchange, chain: Chain) {
        val ip = clientIp(exchange)
        val path = exchange.requestURI.path.orEmpty()
        val loopback = ip == "127.0.0.1" || ip == "::1" || ip == "?"
        val bypass = loopback || path == "/health"

        if (!bypass && !allow(ip)) { reject(exchange, 429, "Too many requests"); return }
        if (!bypass) {
            if (inFlight.incrementAndGet() > maxInFlight) {
                inFlight.decrementAndGet()
                reject(exchange, 503, "Server busy, retry shortly")
                return
            }
        }
        try {
            chain.doFilter(exchange)
        } finally {
            if (!bypass) inFlight.decrementAndGet()
        }
    }

    override fun description() = "Nyora overload/rate guard"
}

private fun newServerExecutor(): java.util.concurrent.Executor =
    runCatching {
        java.util.concurrent.Executors::class.java
            .getMethod("newVirtualThreadPerTaskExecutor")
            .invoke(null) as java.util.concurrent.Executor
    }.getOrElse {
        java.util.concurrent.Executors.newFixedThreadPool(200)
    }

private fun com.nyora.hasan72341.shared.model.MangaSource.toAndroidJsSourceName(): String {
    val parserId = id.removePrefix("parser:")
    return if (parserId == id) name else "JS_$parserId"
}


private fun com.nyora.hasan72341.shared.model.MangaSourceRef.Script.toOpenableSourceId(): String {
    if (name.startsWith("data:")) {
        return "data:${canonicalDataSourceId(name.removePrefix("data:"))}"
    }
    val parserId = name.removePrefix("JS_")
    return currentDataSourceIdForLegacyParser(parserId) ?: "parser:$parserId"
}

/// Resolve a history row to a source id the client can actually open.
/// The manga's source ref wins; the stored column is only trusted when it is a
/// clean, recognizable id (never a leaked Kotlin class string). Returns "" when
/// the source is genuinely unknown (e.g. a legacy non-JS row) so the client can
/// degrade gracefully instead of forwarding garbage to /details.
internal fun openableHistorySourceId(
    ref: com.nyora.hasan72341.shared.model.MangaSourceRef,
    storedSourceId: String,
): String {
    val fromRef = when (ref) {
        is com.nyora.hasan72341.shared.model.MangaSourceRef.Parser ->
            currentDataSourceIdForLegacyParser(ref.name) ?: "parser:${ref.name}"
        is com.nyora.hasan72341.shared.model.MangaSourceRef.Script -> ref.toOpenableSourceId()
        is com.nyora.hasan72341.shared.model.MangaSourceRef.Local -> "local:"
        com.nyora.hasan72341.shared.model.MangaSourceRef.Unknown -> ""
    }
    if (fromRef.isNotBlank()) return fromRef
    val stored = storedSourceId.trim()
    return when {
        stored.startsWith("data:") ->
            "data:${canonicalDataSourceId(stored.removePrefix("data:"))}"
        stored.startsWith("parser:") -> currentDataSourceIdForLegacyParser(stored) ?: stored
        stored.startsWith("local:") -> stored
        else -> ""
    }
}

@kotlinx.serialization.Serializable
private data class SourceListResponse(val sources: List<MangaSource>)

@kotlinx.serialization.Serializable
private data class SourceResponse(val source: MangaSource)

@kotlinx.serialization.Serializable
private data class BrowseResponse(
    val entries: List<Manga>,
    val hasNextPage: Boolean,
)

@kotlinx.serialization.Serializable
private data class DetailsResponse(
    val manga: Manga,
    val chapters: List<MangaChapter>,
)

@kotlinx.serialization.Serializable
private data class PagesResponse(val pages: List<MangaPage>)

@kotlinx.serialization.Serializable
private data class CatalogResponse(val entries: List<CatalogEntry>)

@kotlinx.serialization.Serializable
private data class HistoryResponse(val entries: List<HistoryRowDto>)

@kotlinx.serialization.Serializable
private data class HistoryRowDto(
    val mangaId: String,
    val mangaUrl: String,
    val mangaTitle: String,
    val mangaCoverUrl: String,
    val sourceId: String,
    val sourceName: String,
    val chapterId: String,
    val chapterTitle: String,
    val page: Int,
    val percent: Float,
    val updatedAt: Long,
)

@kotlinx.serialization.Serializable
private data class FavouritesResponse(val entries: List<Manga>)

@kotlinx.serialization.Serializable
private data class MangaPrefsDto(
    val mangaId: String,
    val readerMode: String,
    val brightness: Double,
    val contrast: Double,
    val saturation: Double,
    val hue: Double,
    val palette: String,
    val present: Boolean,
)

@kotlinx.serialization.Serializable
private data class DownloadsResponse(val entries: List<DownloadDto>)

@kotlinx.serialization.Serializable
private data class DownloadResponse(val entry: DownloadDto)

@kotlinx.serialization.Serializable
private data class DownloadDto(
    val id: String,
    val sourceId: String,
    val mangaTitle: String,
    val chapterTitle: String,
    val chapterUrl: String,
    val totalPages: Int,
    val completedPages: Int,
    val failedPages: Int,
    val status: String,
    val filePath: String?,
    val error: String?,
    val startedAt: Long,
    val finishedAt: Long?,
)

@kotlinx.serialization.Serializable
private data class CategoriesResponse(val categories: List<CategoryDto>)

@kotlinx.serialization.Serializable
private data class CategoryDto(val id: Long, val title: String, val mangaCount: Int)

@kotlinx.serialization.Serializable
private data class GlobalSearchResponse(
    val query: String,
    val groups: List<GlobalSearchGroup>,
)

@kotlinx.serialization.Serializable
private data class GlobalSearchGroup(
    val sourceId: String,
    val sourceName: String,
    val entries: List<Manga>,
    val error: String? = null,
)

@kotlinx.serialization.Serializable
private data class LocalScanResponse(val entries: List<LocalCbzEntry>)

@kotlinx.serialization.Serializable
private data class LocalCbzEntry(val path: String, val name: String, val sizeBytes: Long)

@kotlinx.serialization.Serializable
private data class LocalChapterResponse(val name: String, val pageCount: Int, val pageUrls: List<String>)

@kotlinx.serialization.Serializable
private data class UpdatesResponse(val entries: List<UpdateDto>)

@kotlinx.serialization.Serializable
private data class UpdateDto(
    val mangaId: String,
    val mangaTitle: String,
    val mangaCoverUrl: String,
    val sourceId: String,
    val newChapters: Int,
    val totalChapters: Int,
    val latestChapterTitle: String,
    val lastSyncedAt: Long,
)

@kotlinx.serialization.Serializable
private data class BookmarksResponse(val entries: List<BookmarkDto>)

@kotlinx.serialization.Serializable
private data class BookmarkDto(
    val id: Long,
    val mangaId: String,
    val mangaTitle: String,
    val mangaCoverUrl: String,
    val chapterId: String,
    val chapterTitle: String,
    val page: Int,
    val note: String,
    val createdAt: Long,
    val sourceId: String,
    val mangaUrl: String,
    val chapterUrl: String?,
)

@kotlinx.serialization.Serializable
private data class CatalogEntry(
    val id: String,
    val name: String,
    val lang: String,
    val engine: String,
    val contentType: String,
    val isBroken: Boolean,
    val isInstalled: Boolean,
    val isNsfw: Boolean = false,
    val supportedFormats: List<String> = emptyList(),
)

@kotlinx.serialization.Serializable
private data class DownloadSettingsResponse(val settings: DownloadSettings)

@kotlinx.serialization.Serializable
private data class NetworkSettingsResponse(val settings: HelperNetworkSettings)
