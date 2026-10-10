package com.nyora.hasan72341.shared.scrobbling

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Cross-platform (JVM) port of the Android `Scrobbler` abstraction
 * (`scrobbling/common/domain/Scrobbler.kt` + `data/ScrobblerRepository.kt`),
 * consumed by the desktop variants (mac / linux / windows) through
 * nyora-shared.
 *
 * A [Scrobbler] talks to ONE tracker service and exposes the three operations
 * the desktop UI needs (TS-008): [search], [getState] and [updateProgress],
 * plus the OAuth affordances ([oauthUrl] / [authorize]). Concrete
 * implementations live alongside this file: [AniListScrobbler], [MalScrobbler],
 * [MangaBakaScrobbler].
 *
 * All network calls block on OkHttp inside `Dispatchers.IO`.
 */
abstract class Scrobbler(
	val service: ScrobblerService,
	protected val tokens: ScrobblerTokenStore,
	protected val http: OkHttpClient = OkHttpClient(),
) {

	protected val json = Json { ignoreUnknownKeys = true; isLenient = true }

	/** service enum-status -> the wire string the service expects. */
	protected val statuses: MutableMap<ScrobblingStatus, String> = HashMap()

	/** The URL to open in a browser to start the OAuth authorization flow. */
	abstract val oauthUrl: String

	/**
	 * The service's built-in `nyora://…` deep-link redirect. Used unless the
	 * desktop loopback login flow ([ScrobblerOAuth.login]) overrides
	 * [redirectUri] first.
	 */
	protected abstract val defaultRedirectUri: String

	private var redirectOverride: String? = null

	/**
	 * The effective OAuth `redirect_uri`. Defaults to [defaultRedirectUri]
	 * (a `nyora://` deep link); [ScrobblerOAuth.login] sets this to a
	 * `http://127.0.0.1:<port>/callback` loopback address before building
	 * [oauthUrl] and exchanging the code, so both halves of the flow agree.
	 *
	 * NOTE: a loopback (or `nyora://`) redirect must be registered with the
	 * service's OAuth application (AniList / MAL / Shikimori) or the authorize
	 * step is rejected — see [ScrobblerOAuth].
	 */
	var redirectUri: String
		get() = redirectOverride ?: defaultRedirectUri
		set(value) { redirectOverride = value }

	val isAuthorized: Boolean
		get() = !tokens.accessToken.isNullOrEmpty()

	/**
	 * Exchange an authorization [code] (or refresh, when null) for tokens and
	 * return the signed-in user.
	 */
	abstract suspend fun authorize(code: String?): ScrobblerUser

	/** Load the currently authenticated user. */
	abstract suspend fun loadUser(): ScrobblerUser

	open fun logout() = tokens.clear()

	/** Search the service catalogue. */
	abstract suspend fun search(query: String, offset: Int = 0): List<ScrobblerManga>

	/** Extended metadata for a single service entry. */
	abstract suspend fun getMangaInfo(remoteId: Long): ScrobblerMangaInfo

	/**
	 * Fetch the signed-in user's current list state for [remoteId], or null if
	 * the entry is not on their list yet.
	 */
	abstract suspend fun getState(remoteId: Long): ScrobblingInfo?

	/**
	 * Create-or-update the user's list entry for [remoteId]. Any argument left
	 * null is not changed. [rating] (when given) is `0f..1f`. Returns the new
	 * live state.
	 */
	abstract suspend fun updateProgress(
		remoteId: Long,
		chapter: Int? = null,
		status: ScrobblingStatus? = null,
		rating: Float? = null,
		comment: String? = null,
	): ScrobblingInfo

	// ── status mapping ──────────────────────────────────────────────────────

	protected fun remoteStatus(status: ScrobblingStatus?): String? = status?.let { statuses[it] }

	protected fun statusFromRemote(remote: String?): ScrobblingStatus? {
		if (remote == null) return null
		return statuses.entries.firstOrNull { it.value.equals(remote, ignoreCase = true) }?.key
	}

	// ── HTTP helpers ──────────────────────────────────────────────────────────

	protected fun authedBuilder(): Request.Builder {
		val b = Request.Builder()
		tokens.accessToken?.let { b.header("Authorization", "Bearer $it") }
		b.header("Accept", "application/json")
		return b
	}

	protected suspend fun call(request: Request): String = withContext(Dispatchers.IO) {
		http.newCall(request).execute().use { resp ->
			resp.body?.string().orEmpty()
		}
	}

	/** Like [call] but throws with the status + body when the response isn't 2xx,
	 *  so a rejected write (a tracker refusing a scrobble) surfaces as a failure
	 *  instead of being silently swallowed and reported as success. */
	protected suspend fun callChecked(request: Request): String = withContext(Dispatchers.IO) {
		http.newCall(request).execute().use { resp ->
			val body = resp.body?.string().orEmpty()
			if (!resp.isSuccessful) error("HTTP ${resp.code}: ${body.take(300)}")
			body
		}
	}

	/** Execute [request] and return (status code, body) without throwing, so a
	 *  caller can branch on the status (e.g. create-vs-update on a 409 conflict). */
	protected suspend fun callWithStatus(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
		http.newCall(request).execute().use { resp ->
			resp.code to resp.body?.string().orEmpty()
		}
	}

	protected suspend fun callJson(request: Request): JsonObject {
		val text = call(request)
		return parseObject(text)
	}

	protected fun parseObject(text: String): JsonObject =
		json.parseToJsonElement(text.ifBlank { "{}" }).jsonObject

	protected fun parseArray(text: String): JsonArray =
		json.parseToJsonElement(text.ifBlank { "[]" }).jsonArray

	protected fun formBody(vararg pairs: Pair<String, String?>): RequestBody {
		val b = okhttp3.FormBody.Builder()
		for ((k, v) in pairs) if (v != null) b.add(k, v)
		return b.build()
	}

	protected fun jsonBody(element: JsonElement, contentType: String = "application/json"): RequestBody {
		val mt = "$contentType; charset=utf-8".toMediaType()
		return json.encodeToString(JsonElement.serializer(), element).toRequestBody(mt)
	}

	/** URL-encode a value for safe use as a query parameter (loopback redirects contain `://` and `:`). */
	protected fun enc(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")

	// ── JSON navigation shorthands ─────────────────────────────────────────────

	protected fun JsonObject.obj(key: String): JsonObject? = this[key]?.let { it as? JsonObject }
	protected fun JsonObject.arr(key: String): JsonArray? = this[key]?.let { it as? JsonArray }
	protected fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
	protected fun JsonObject.int(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull
	protected fun JsonObject.long(key: String): Long? =
		this[key]?.jsonPrimitive?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() }
	protected fun JsonObject.float(key: String): Float? =
		this[key]?.jsonPrimitive?.let { it.floatOrNull ?: it.doubleOrNull?.toFloat() }
}
