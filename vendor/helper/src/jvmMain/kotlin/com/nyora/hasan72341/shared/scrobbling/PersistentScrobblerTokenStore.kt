package com.nyora.hasan72341.shared.scrobbling

import com.nyora.hasan72341.shared.HelperProfile
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties

/**
 * A disk-backed [ScrobblerTokenStore] so desktop tracker logins survive an app
 * restart (TS-011). All services share one `scrobbler_tokens.properties` file
 * in the Nyora data dir, keyed `<service.slug>.access_token` /
 * `<service.slug>.refresh_token`, mirroring how [com.nyora.hasan72341.shared.sync.NyoraSyncConfig]
 * persists its own tokens.
 *
 * Reads and writes load-modify-store the shared file under a process-wide lock
 * so concurrent per-service stores don't clobber each other.
 */
class PersistentScrobblerTokenStore(
	private val service: ScrobblerService,
	private val file: Path = defaultFile(),
) : ScrobblerTokenStore {

	override var accessToken: String? = read("access_token")
		set(value) {
			field = value
			write("access_token", value)
		}

	override var refreshToken: String? = read("refresh_token")
		set(value) {
			field = value
			write("refresh_token", value)
		}

	override fun clear() {
		accessToken = null
		refreshToken = null
	}

	private fun key(name: String) = "${service.slug}.$name"

	private fun read(name: String): String? = synchronized(LOCK) {
		load().getProperty(key(name))?.takeIf { it.isNotEmpty() }
	}

	private fun write(name: String, value: String?) = synchronized(LOCK) {
		val props = load()
		if (value.isNullOrEmpty()) props.remove(key(name)) else props.setProperty(key(name), value)
		HelperProfile.confine(file)
		file.parent?.let { Files.createDirectories(it) }
		Files.newBufferedWriter(file).use { props.store(it, "Nyora tracker OAuth tokens") }
	}

	private fun load(): Properties {
		val props = Properties()
		HelperProfile.confine(file)
		if (Files.exists(file)) {
			runCatching { Files.newBufferedReader(file).use { props.load(it) } }
		}
		return props
	}

	companion object {
		private val LOCK = Any()

		/** Nyora data dir file, matching the SQLDelight/library data-dir convention. */
		fun defaultFile(): Path {
			HelperProfile.isolatedPath("scrobbler_tokens.properties")?.let { return it }
			System.getProperty("nyora.data.dir")?.takeIf { it.isNotBlank() }?.let {
				return Path.of(it).also { d -> Files.createDirectories(d) }.resolve("scrobbler_tokens.properties")
			}
			val osName = System.getProperty("os.name", "").lowercase()
			val home = Path.of(System.getProperty("user.home"))
			val base = when {
				osName.contains("win") -> {
					val appData = System.getenv("APPDATA")?.takeIf { it.isNotBlank() }
						?: home.resolve("AppData").resolve("Roaming").toString()
					Path.of(appData, "Nyora")
				}
				osName.contains("mac") ->
					home.resolve("Library").resolve("Application Support").resolve("Nyora")
				else -> {
					val xdgData = System.getenv("XDG_DATA_HOME")?.let { Path.of(it) }
						?: home.resolve(".local").resolve("share")
					xdgData.resolve("nyora")
				}
			}
			Files.createDirectories(base)
			return base.resolve("scrobbler_tokens.properties")
		}
	}
}
