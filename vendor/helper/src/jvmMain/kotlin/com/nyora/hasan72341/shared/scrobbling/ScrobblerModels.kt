package com.nyora.hasan72341.shared.scrobbling

/** A search hit from a tracker service. */
data class ScrobblerManga(
	val id: Long,
	val name: String,
	val altName: String?,
	val cover: String?,
	val url: String,
	val isBestMatch: Boolean,
)

/** Extended metadata for a single tracker entry (used to render details). */
data class ScrobblerMangaInfo(
	val id: Long,
	val name: String,
	val cover: String,
	val url: String,
	val descriptionHtml: String,
)

/** The authenticated user on a tracker service. */
data class ScrobblerUser(
	val id: Long,
	val nickname: String,
	val avatar: String?,
	val service: ScrobblerService,
)

/**
 * The live state of a tracked entry as reported by the service. Rating is
 * normalized to `0f..1f` regardless of the service's native scale so the
 * canonical `nyora_tracking.score` stays comparable across trackers.
 */
data class ScrobblingInfo(
	val service: ScrobblerService,
	/** The list-entry id used for subsequent updates (0 when unknown). */
	val rateId: Long,
	/** The media / manga id on the tracker service. */
	val remoteId: Long,
	val status: ScrobblingStatus?,
	val chapter: Int,
	/** Normalized rating in `0f..1f`. */
	val rating: Float,
	val comment: String?,
	val title: String,
	val coverUrl: String?,
	val description: String?,
	val url: String,
)

/**
 * Token storage for a scrobbler. Desktop wires a Keychain / SQLDelight-backed
 * implementation later (TS-010/TS-011); the default keeps tokens in memory so
 * the abstraction is usable / testable standalone.
 */
interface ScrobblerTokenStore {
	var accessToken: String?
	var refreshToken: String?
	fun clear()
}

class InMemoryScrobblerTokenStore(
	override var accessToken: String? = null,
	override var refreshToken: String? = null,
) : ScrobblerTokenStore {
	override fun clear() {
		accessToken = null
		refreshToken = null
	}
}
