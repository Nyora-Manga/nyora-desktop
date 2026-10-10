package com.nyora.hasan72341.shared.scrobbling

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * MangaBaka tracker (OAuth2, S256 PKCE). JVM port of Android's
 * `scrobbling/mangabaka/data/MangaBakaRepository.kt` into the shared [Scrobbler]
 * abstraction. Auth at mangabaka.org; the library/series API is at
 * api.mangabaka.org. Progress is written by upserting the user's library entry
 * (`POST /v1/my/library/{seriesId}` with `{state, progress_chapter}`).
 */
class MangaBakaScrobbler(
	tokens: ScrobblerTokenStore,
	http: OkHttpClient = OkHttpClient(),
) : Scrobbler(ScrobblerService.MANGABAKA, tokens, http) {

	private companion object {
		const val REDIRECT_URI = "nyora://mangabaka-auth"
		const val OAUTH = "https://mangabaka.org/auth/oauth2"
		const val API = "https://api.mangabaka.org"
		const val WEB = "https://mangabaka.org"
		// Space-separated scopes, `+`-encoded as MangaBaka expects them.
		const val SCOPE = "library.read+library.write+profile+offline_access+openid"
		const val STATE_READING = "reading"
	}

	init {
		statuses[ScrobblingStatus.PLANNED] = "plan_to_read"
		statuses[ScrobblingStatus.READING] = "reading"
		statuses[ScrobblingStatus.RE_READING] = "rereading"
		statuses[ScrobblingStatus.COMPLETED] = "completed"
		statuses[ScrobblingStatus.ON_HOLD] = "paused"
		statuses[ScrobblingStatus.DROPPED] = "dropped"
	}

	private val codeVerifier: String by lazy {
		val bytes = ByteArray(50)
		SecureRandom().nextBytes(bytes)
		Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
	}

	private fun codeChallenge(): String {
		val digest = MessageDigest.getInstance("SHA-256").digest(codeVerifier.toByteArray())
		return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
	}

	override val defaultRedirectUri: String = REDIRECT_URI

	override val oauthUrl: String
		get() = "$OAUTH/authorize?response_type=code" +
			"&client_id=${service.clientId}" +
			"&redirect_uri=${enc(redirectUri)}" +
			"&scope=$SCOPE" +
			"&code_challenge=${codeChallenge()}&code_challenge_method=S256"

	override suspend fun authorize(code: String?): ScrobblerUser {
		val body = if (code != null) {
			formBody(
				"client_id" to service.clientId,
				"grant_type" to "authorization_code",
				"code" to code,
				"redirect_uri" to redirectUri,
				"code_verifier" to codeVerifier,
			)
		} else {
			formBody(
				"client_id" to service.clientId,
				"grant_type" to "refresh_token",
				"refresh_token" to tokens.refreshToken,
			)
		}
		val resp = callJson(Request.Builder().url("$OAUTH/token").post(body).build())
		tokens.accessToken = resp.str("access_token")
		tokens.refreshToken = resp.str("refresh_token") ?: tokens.refreshToken
		return loadUser()
	}

	override suspend fun loadUser(): ScrobblerUser {
		val data = callJson(authedBuilder().url("$API/v1/my/profile").get().build()).data()
		return ScrobblerUser(
			id = data.long("id") ?: 0L,
			nickname = data.str("username") ?: data.str("name").orEmpty(),
			avatar = data.str("avatar"),
			service = service,
		)
	}

	override suspend fun search(query: String, offset: Int): List<ScrobblerManga> {
		val url = "$API/v1/series/search".toHttpUrl().newBuilder()
			.addQueryParameter("q", query)
			.build()
		val resp = callJson(authedBuilder().url(url).get().build())
		return resp.arr("data").orEmpty().mapNotNull { el ->
			val o = el as? JsonObject ?: return@mapNotNull null
			val id = o.long("id") ?: return@mapNotNull null
			val title = o.str("title") ?: o.str("native_title").orEmpty()
			ScrobblerManga(
				id = id,
				name = title,
				altName = o.str("native_title"),
				cover = o.coverUrl(),
				url = "$WEB/series/$id",
				isBestMatch = title.equals(query, ignoreCase = true),
			)
		}
	}

	override suspend fun getMangaInfo(remoteId: Long): ScrobblerMangaInfo {
		val data = callJson(authedBuilder().url("$API/v1/series/$remoteId").get().build()).data()
		return ScrobblerMangaInfo(
			id = data.long("id") ?: remoteId,
			name = data.str("title").orEmpty(),
			cover = data.coverUrl().orEmpty(),
			url = "$WEB/series/$remoteId",
			descriptionHtml = data.str("description").orEmpty(),
		)
	}

	override suspend fun getState(remoteId: Long): ScrobblingInfo? {
		val resp = runCatching {
			callJson(authedBuilder().url("$API/v1/my/library/$remoteId").get().build())
		}.getOrNull() ?: return null
		val data = resp.data()
		// Not on the user's list yet → no state to report.
		if (data.str("state") == null && data["progress_chapter"] == null) return null
		return data.toInfo(remoteId)
	}

	override suspend fun updateProgress(
		remoteId: Long,
		chapter: Int?,
		status: ScrobblingStatus?,
		rating: Float?,
		comment: String?,
	): ScrobblingInfo {
		val payload = buildJsonObject {
			put("state", remoteStatus(status) ?: STATE_READING)
			if (chapter != null) put("progress_chapter", chapter)
			if (rating != null) put("rating", (rating * 100f).toInt().coerceIn(0, 100))
		}
		// Upsert; MangaBaka answers 201 { data:true } with no useful body, so re-read.
		call(authedBuilder().url("$API/v1/my/library/$remoteId").post(jsonBody(payload)).build())
		val data = callJson(authedBuilder().url("$API/v1/my/library/$remoteId").get().build()).data()
		return data.toInfo(remoteId)
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private fun JsonObject.data(): JsonObject = obj("data") ?: this

	private suspend fun JsonObject.toInfo(remoteId: Long): ScrobblingInfo {
		val info = runCatching { getMangaInfo(remoteId) }.getOrNull()
		return ScrobblingInfo(
			service = service,
			rateId = remoteId,
			remoteId = remoteId,
			status = statusFromRemote(str("state")),
			chapter = int("progress_chapter") ?: 0,
			rating = ((float("rating") ?: 0f) / 100f).coerceIn(0f, 1f),
			comment = null,
			title = info?.name ?: str("title").orEmpty(),
			coverUrl = info?.cover ?: coverUrl(),
			description = info?.descriptionHtml,
			url = "$WEB/series/$remoteId",
		)
	}

	// MangaBaka returns nested cover-size variants; return the first URL found.
	private fun JsonObject.coverUrl(): String? {
		val cover = obj("cover") ?: return null
		cover.str("default")?.let { return it }
		cover.obj("raw")?.str("url")?.let { return it }
		cover.obj("x250")?.str("x1")?.let { return it }
		return null
	}
}
