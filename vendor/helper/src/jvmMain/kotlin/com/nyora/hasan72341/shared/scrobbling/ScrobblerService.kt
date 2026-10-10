package com.nyora.hasan72341.shared.scrobbling

/**
 * The multi-service tracker registry for the desktop (mac / linux / windows)
 * variants. Mirrors Android's
 * `scrobbling/common/domain/model/ScrobblerService.kt` (same integer [id]s so
 * the sync `tracker_id` slug <-> int mapping stays stable across platforms).
 *
 * OAuth [clientId] / [clientSecret] values are the SAME real credentials the
 * Android app ships in `res/values/constants.xml` — reused here per TS-008 so
 * the desktop OAuth flows (TS-011) authenticate against the same registered
 * applications.
 */
enum class ScrobblerService(
	val id: Int,
	/** Canonical `tracker_id` used in the `nyora_tracking` sync table. */
	val slug: String,
	val title: String,
	val clientId: String,
	val clientSecret: String?,
) {

	ANILIST(
		id = 2,
		slug = "anilist",
		title = "AniList",
		// Nyora's AniList OAuth app (matches nyora-mac / Android). Confidential
		// authorization-code client: it issues a secret and rejects the implicit
		// grant, so the token exchange sends this secret (see AniListScrobbler).
		clientId = "46413",
		clientSecret = "1g354gn5JLiP0b0CyIJLk4SHCfq5d9Zip2ufxGHj",
	),

	MAL(
		id = 3,
		slug = "myanimelist",
		// Nyora's MyAnimeList OAuth app (matches nyora-mac). PKCE public client.
		clientId = "f3fec032a062ca0ba0c37330ca63730a",
		title = "MyAnimeList",
		clientSecret = null, // MAL uses PKCE (public client, no secret)
	),

	MANGABAKA(
		id = 6,
		slug = "mangabaka",
		title = "MangaBaka",
		// Nyora's MangaBaka OAuth app (matches nyora-mac / Android). S256 PKCE public client.
		clientId = "WFVyyltyYIteXTlesNaCnZwLnkjwGWRp",
		clientSecret = null,
	);

	companion object {
		fun fromId(id: Int): ScrobblerService? = entries.firstOrNull { it.id == id }
		fun fromSlug(slug: String?): ScrobblerService? =
			entries.firstOrNull { it.slug.equals(slug, ignoreCase = true) }
	}
}
