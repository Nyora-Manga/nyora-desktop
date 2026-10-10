package com.nyora.hasan72341.shared.scrobbling

import okhttp3.OkHttpClient

/**
 * Registry of every available desktop [Scrobbler], keyed by [ScrobblerService].
 * Mirrors Android's `scrobbling/common/domain/ScrobblerRepositoryMap.kt`.
 *
 * Each service gets its own [ScrobblerTokenStore]; the default builds
 * in-memory stores, but the desktop app injects Keychain / SQLDelight-backed
 * stores (TS-010/TS-011) via [tokenStoreFactory].
 */
class ScrobblerRepository(
	private val http: OkHttpClient = OkHttpClient(),
	tokenStoreFactory: (ScrobblerService) -> ScrobblerTokenStore = { InMemoryScrobblerTokenStore() },
) {

	private val scrobblers: Map<ScrobblerService, Scrobbler> = buildMap {
		for (svc in ScrobblerService.entries) {
			put(svc, create(svc, tokenStoreFactory(svc), http))
		}
	}

	fun all(): List<Scrobbler> = scrobblers.values.toList()

	operator fun get(service: ScrobblerService): Scrobbler =
		scrobblers.getValue(service)

	fun byId(id: Int): Scrobbler? =
		ScrobblerService.fromId(id)?.let { scrobblers[it] }

	fun bySlug(slug: String?): Scrobbler? =
		ScrobblerService.fromSlug(slug)?.let { scrobblers[it] }

	/** The scrobblers the user is currently signed in to. */
	fun authorized(): List<Scrobbler> = scrobblers.values.filter { it.isAuthorized }

	companion object {
		/**
		 * A repository whose tokens persist to disk (TS-011), so desktop tracker
		 * logins survive an app restart. Backed by [PersistentScrobblerTokenStore].
		 */
		fun persistent(http: OkHttpClient = OkHttpClient()): ScrobblerRepository =
			ScrobblerRepository(http) { PersistentScrobblerTokenStore(it) }

		/**
		 * Build a single scrobbler for [service] backed by [tokens]. Used for
		 * stateless, per-request construction (e.g. the REST server injects a
		 * bearer token into an [InMemoryScrobblerTokenStore] per call).
		 */
		fun create(
			service: ScrobblerService,
			tokens: ScrobblerTokenStore,
			http: OkHttpClient = OkHttpClient(),
		): Scrobbler = when (service) {
			ScrobblerService.ANILIST -> AniListScrobbler(tokens, http)
			ScrobblerService.MAL -> MalScrobbler(tokens, http)
			ScrobblerService.MANGABAKA -> MangaBakaScrobbler(tokens, http)
		}
	}
}
