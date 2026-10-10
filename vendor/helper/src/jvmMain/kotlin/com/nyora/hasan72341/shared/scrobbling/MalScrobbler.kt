package com.nyora.hasan72341.shared.scrobbling

import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.SecureRandom
import java.util.Base64

/**
 * MyAnimeList tracker (REST v2, PKCE OAuth). JVM port of Android's
 * `scrobbling/mal/data/MALRepository.kt`.
 */
class MalScrobbler(
	tokens: ScrobblerTokenStore,
	http: OkHttpClient = OkHttpClient(),
) : Scrobbler(ScrobblerService.MAL, tokens, http) {

	private companion object {
		const val REDIRECT_URI = "nyora://mal-auth"
		const val WEB = "https://myanimelist.net"
		const val API = "https://api.myanimelist.net/v2"
	}

	init {
		statuses[ScrobblingStatus.PLANNED] = "plan_to_read"
		statuses[ScrobblingStatus.READING] = "reading"
		statuses[ScrobblingStatus.RE_READING] = "reading"
		statuses[ScrobblingStatus.COMPLETED] = "completed"
		statuses[ScrobblingStatus.ON_HOLD] = "on_hold"
		statuses[ScrobblingStatus.DROPPED] = "dropped"
	}

	// MAL PKCE "plain" challenge == verifier.
	val codeVerifier: String by lazy {
		val bytes = ByteArray(50)
		SecureRandom().nextBytes(bytes)
		Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
	}

	override val defaultRedirectUri: String = REDIRECT_URI

	override val oauthUrl: String
		get() = "$WEB/v1/oauth2/authorize?response_type=code" +
			"&client_id=${service.clientId}" +
			"&redirect_uri=${enc(redirectUri)}" +
			"&code_challenge=$codeVerifier&code_challenge_method=plain"

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
		val resp = callJson(
			Request.Builder().url("$WEB/v1/oauth2/token").post(body).build(),
		)
		tokens.accessToken = resp.str("access_token")
		tokens.refreshToken = resp.str("refresh_token")
		return loadUser()
	}

	override suspend fun loadUser(): ScrobblerUser {
		val resp = callJson(authedBuilder().url("$API/users/@me").get().build())
		return ScrobblerUser(
			id = resp.long("id") ?: 0L,
			nickname = resp.str("name").orEmpty(),
			avatar = resp.str("picture"),
			service = service,
		)
	}

	override suspend fun search(query: String, offset: Int): List<ScrobblerManga> {
		val url = "$API/manga".toHttpUrl().newBuilder()
			.addQueryParameter("offset", offset.toString())
			.addQueryParameter("nsfw", "true")
			.addQueryParameter("q", query.take(64)) // MAL 400s over 64 chars
			.build()
		val resp = callJson(authedBuilder().url(url).get().build())
		return resp.arr("data").orEmpty().mapNotNull { el ->
			val node = (el as? JsonObject)?.obj("node") ?: return@mapNotNull null
			val id = node.long("id") ?: return@mapNotNull null
			ScrobblerManga(
				id = id,
				name = node.str("title").orEmpty(),
				altName = null,
				cover = node.obj("main_picture")?.str("large"),
				url = "$WEB/manga/$id",
				isBestMatch = node.str("title").equals(query, true),
			)
		}
	}

	override suspend fun getMangaInfo(remoteId: Long): ScrobblerMangaInfo {
		val resp = callJson(
			authedBuilder().url(
				"$API/manga/$remoteId".toHttpUrl().newBuilder()
					.addQueryParameter("fields", "synopsis,main_picture,title").build(),
			).get().build(),
		)
		return ScrobblerMangaInfo(
			id = resp.long("id") ?: remoteId,
			name = resp.str("title").orEmpty(),
			cover = resp.obj("main_picture")?.str("large").orEmpty(),
			url = "$WEB/manga/$remoteId",
			descriptionHtml = resp.str("synopsis").orEmpty(),
		)
	}

	override suspend fun getState(remoteId: Long): ScrobblingInfo? {
		val resp = callJson(
			authedBuilder().url(
				"$API/manga/$remoteId".toHttpUrl().newBuilder()
					.addQueryParameter("fields", "my_list_status,synopsis,main_picture,title").build(),
			).get().build(),
		)
		val listStatus = resp.obj("my_list_status") ?: return null
		return resp.toInfo(remoteId, listStatus)
	}

	override suspend fun updateProgress(
		remoteId: Long,
		chapter: Int?,
		status: ScrobblingStatus?,
		rating: Float?,
		comment: String?,
	): ScrobblingInfo {
		val body = okhttp3.FormBody.Builder().apply {
			if (chapter != null) add("num_chapters_read", chapter.toString())
			remoteStatus(status)?.let { add("status", it) }
			if (rating != null) add("score", (rating * 10f).toInt().coerceIn(0, 10).toString())
			if (comment != null) add("comments", comment)
		}.build()
		val listStatus = callJson(
			authedBuilder().url("$API/manga/$remoteId/my_list_status").put(body).build(),
		)
		val info = getMangaInfo(remoteId)
		return ScrobblingInfo(
			service = service,
			rateId = remoteId,
			remoteId = remoteId,
			status = statusFromRemote(listStatus.str("status")),
			chapter = listStatus.int("num_chapters_read") ?: 0,
			rating = ((listStatus.float("score") ?: 0f) / 10f).coerceIn(0f, 1f),
			comment = listStatus.str("comments"),
			title = info.name,
			coverUrl = info.cover,
			description = info.descriptionHtml,
			url = info.url,
		)
	}

	private fun JsonObject.toInfo(remoteId: Long, listStatus: JsonObject) = ScrobblingInfo(
		service = service,
		rateId = remoteId,
		remoteId = remoteId,
		status = statusFromRemote(listStatus.str("status")),
		chapter = listStatus.int("num_chapters_read") ?: 0,
		rating = ((listStatus.float("score") ?: 0f) / 10f).coerceIn(0f, 1f),
		comment = listStatus.str("comments"),
		title = str("title").orEmpty(),
		coverUrl = obj("main_picture")?.str("large"),
		description = str("synopsis"),
		url = "$WEB/manga/$remoteId",
	)
}
