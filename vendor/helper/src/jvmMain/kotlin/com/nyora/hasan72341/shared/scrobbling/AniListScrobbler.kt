package com.nyora.hasan72341.shared.scrobbling

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.math.roundToInt

/**
 * AniList tracker (GraphQL). JVM port of Android's
 * `scrobbling/anilist/data/AniListRepository.kt`.
 */
class AniListScrobbler(
	tokens: ScrobblerTokenStore,
	http: OkHttpClient = OkHttpClient(),
) : Scrobbler(ScrobblerService.ANILIST, tokens, http) {

	private companion object {
		const val REDIRECT_URI = "nyora://anilist-auth"
		const val OAUTH_BASE = "https://anilist.co/api/v2/"
		const val ENDPOINT = "https://graphql.anilist.co"
		const val PAGE_SIZE = 10
	}

	init {
		statuses[ScrobblingStatus.PLANNED] = "PLANNING"
		statuses[ScrobblingStatus.READING] = "CURRENT"
		statuses[ScrobblingStatus.RE_READING] = "REPEATING"
		statuses[ScrobblingStatus.COMPLETED] = "COMPLETED"
		statuses[ScrobblingStatus.ON_HOLD] = "PAUSED"
		statuses[ScrobblingStatus.DROPPED] = "DROPPED"
	}

	override val defaultRedirectUri: String = REDIRECT_URI

	override val oauthUrl: String
		get() = "${OAUTH_BASE}oauth/authorize?client_id=${service.clientId}" +
			"&redirect_uri=${enc(redirectUri)}&response_type=code"

	override suspend fun authorize(code: String?): ScrobblerUser {
		// AniList's registered client (46413) is confidential — it issues a secret
		// and rejects the implicit grant with "unsupported_grant_type" — so this is
		// the authorization-code grant: exchange the `code` delivered by the
		// nyora:// deep link (or refresh) for tokens using the client id + secret.
		val body = if (code != null) {
			formBody(
				"client_id" to service.clientId,
				"client_secret" to service.clientSecret,
				"grant_type" to "authorization_code",
				"redirect_uri" to redirectUri,
				"code" to code,
			)
		} else {
			formBody(
				"client_id" to service.clientId,
				"client_secret" to service.clientSecret,
				"grant_type" to "refresh_token",
				"refresh_token" to tokens.refreshToken,
			)
		}
		val resp = callJson(
			Request.Builder().url("${OAUTH_BASE}oauth/token").post(body).build(),
		)
		tokens.accessToken = resp.str("access_token")
		tokens.refreshToken = resp.str("refresh_token")
		return loadUser()
	}

	override suspend fun loadUser(): ScrobblerUser {
		val data = query(
			"""
			AniChartUser {
				user { id name avatar { medium } }
			}
			""",
		).obj("data")?.obj("AniChartUser")?.obj("user") ?: error("AniList: no user")
		return ScrobblerUser(
			id = data.long("id") ?: 0L,
			nickname = data.str("name").orEmpty(),
			avatar = data.obj("avatar")?.str("medium"),
			service = service,
		)
	}

	override suspend fun search(query: String, offset: Int): List<ScrobblerManga> {
		val page = offset / PAGE_SIZE + 1
		val data = query(
			"""
			Page(page: $page, perPage: $PAGE_SIZE) {
				media(type: MANGA, sort: SEARCH_MATCH, search: ${quote(query)}) {
					id
					title { userPreferred native }
					coverImage { medium }
					siteUrl
				}
			}
			""",
			authed = false,
		).obj("data")?.obj("Page")?.arr("media").orEmpty()
		return data.mapNotNull { el ->
			val jo = el as? JsonObject ?: return@mapNotNull null
			val title = jo.obj("title")
			ScrobblerManga(
				id = jo.long("id") ?: return@mapNotNull null,
				name = title?.str("userPreferred").orEmpty(),
				altName = title?.str("native"),
				cover = jo.obj("coverImage")?.str("medium"),
				url = jo.str("siteUrl").orEmpty(),
				isBestMatch = title?.str("userPreferred").equals(query, true) ||
					title?.str("native").equals(query, true),
			)
		}
	}

	override suspend fun getMangaInfo(remoteId: Long): ScrobblerMangaInfo {
		val media = query(
			"""
			Media(id: $remoteId) {
				id title { userPreferred } coverImage { large } description siteUrl
			}
			""",
			authed = false,
		).obj("data")?.obj("Media") ?: error("AniList: media $remoteId not found")
		return ScrobblerMangaInfo(
			id = media.long("id") ?: remoteId,
			name = media.obj("title")?.str("userPreferred").orEmpty(),
			cover = media.obj("coverImage")?.str("large").orEmpty(),
			url = media.str("siteUrl").orEmpty(),
			descriptionHtml = media.str("description").orEmpty(),
		)
	}

	override suspend fun getState(remoteId: Long): ScrobblingInfo? {
		val media = query(
			"""
			Media(id: $remoteId) {
				id title { userPreferred } coverImage { large } description siteUrl
				mediaListEntry { id status score(format: POINT_100) progress notes }
			}
			""",
		).obj("data")?.obj("Media") ?: return null
		val entry = media.obj("mediaListEntry") ?: return null
		return media.toInfo(entry)
	}

	override suspend fun updateProgress(
		remoteId: Long,
		chapter: Int?,
		status: ScrobblingStatus?,
		rating: Float?,
		comment: String?,
	): ScrobblingInfo {
		val parts = StringBuilder("mediaId: $remoteId")
		if (chapter != null) parts.append(", progress: $chapter")
		remoteStatus(status)?.let { parts.append(", status: $it") }
		if (rating != null) parts.append(", scoreRaw: ${(rating * 100f).roundToInt()}")
		if (comment != null) parts.append(", notes: ${quote(comment)}")
		val entry = mutation(
			"""
			SaveMediaListEntry($parts) {
				id mediaId status score(format: POINT_100) progress notes
			}
			""",
		).obj("data")?.obj("SaveMediaListEntry") ?: error("AniList: save failed")
		// Fetch media metadata for a complete state object.
		val info = getMangaInfo(remoteId)
		return ScrobblingInfo(
			service = service,
			rateId = entry.long("id") ?: 0L,
			remoteId = remoteId,
			status = statusFromRemote(entry.str("status")),
			chapter = entry.int("progress") ?: 0,
			rating = ((entry.float("score") ?: 0f) / 100f).coerceIn(0f, 1f),
			comment = entry.str("notes"),
			title = info.name,
			coverUrl = info.cover,
			description = info.descriptionHtml,
			url = info.url,
		)
	}

	private fun JsonObject.toInfo(entry: JsonObject): ScrobblingInfo = ScrobblingInfo(
		service = service,
		rateId = entry.long("id") ?: 0L,
		remoteId = long("id") ?: 0L,
		status = statusFromRemote(entry.str("status")),
		chapter = entry.int("progress") ?: 0,
		rating = ((entry.float("score") ?: 0f) / 100f).coerceIn(0f, 1f),
		comment = entry.str("notes"),
		title = obj("title")?.str("userPreferred").orEmpty(),
		coverUrl = obj("coverImage")?.str("large"),
		description = str("description"),
		url = str("siteUrl").orEmpty(),
	)

	// ── GraphQL plumbing ──────────────────────────────────────────────────────

	private suspend fun query(payload: String, authed: Boolean = true): JsonObject = graphql("query", payload, authed)
	private suspend fun mutation(payload: String): JsonObject = graphql("mutation", payload, true)

	private suspend fun graphql(type: String, payload: String, authed: Boolean = true): JsonObject {
		val body = buildJsonObject {
			put("query", "$type { ${payload.replace(Regex("\\s+"), " ").trim()} }")
		}
		// AniList rejects the ENTIRE query with "Invalid token" if the Authorization
		// header carries an invalid/expired token — even for public reads like
		// search. So public queries must be sent unauthenticated; only mutations and
		// the viewer's own list actually need the token.
		val builder = if (authed) authedBuilder() else Request.Builder().header("Accept", "application/json")
		return callJson(builder.url(ENDPOINT).post(jsonBody(body)).build())
	}

	private fun quote(value: String): String =
		"\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
