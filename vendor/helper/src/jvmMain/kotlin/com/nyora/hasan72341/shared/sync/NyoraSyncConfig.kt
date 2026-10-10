package com.nyora.hasan72341.shared.sync

import com.nyora.hasan72341.shared.HelperProfile
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.Properties

object NyoraSyncConfig {
    // The production Nyora Sync backend (FastAPI/OAuth2/JWT) — the SAME endpoint the web app
    // (nyora-web) talks to, so a user's library merges across web and desktop. Auth is the Bearer
    // JWT only; there is no Nyora Sync apikey/anon key any more. Overridable via NYORA_SYNC_URL for
    // dev/self-hosting.
    var url: String = "https://sync.nyora.xyz"
    var accessToken: String = ""
    var refreshToken: String = ""
    var userId: String = ""
    var email: String = ""
    var lastSyncTimestamp: String = "1970-01-01T00:00:00Z"
    var googleDesktopClientId: String = "181067068545-5r2ob1jv4mc0v8gd52fgk2jt28pk3370.apps.googleusercontent.com"
    var googleServerClientId: String = "181067068545-4jkfesn716ucqbuhcbtvdtlqfg3ar38u.apps.googleusercontent.com"
    // Provided at build/run time via GOOGLE_CLIENT_SECRET env var or .env.sync —
    // never baked into the open-source tree. load() fills this in.
    var googleClientSecret: String = ""

    val isConfigured: Boolean get() = url.isNotBlank()
    val isAuthenticated: Boolean get() = accessToken.isNotBlank() && userId.isNotBlank()

    fun load(dataDir: Path) {
        if (HelperProfile.isolated) {
            url = ""
            accessToken = ""; refreshToken = ""; userId = ""; email = ""
            lastSyncTimestamp = "1970-01-01T00:00:00Z"
            googleClientSecret = ""
            return
        }
        val env = readEnvSync()
        // Secrets baked into the packaged artifact at BUILD time (CI writes
        // /nyora-oauth.properties into the app's resources from an Actions secret;
        // the file is gitignored and never committed). This is how the desktop
        // OAuth client secret reaches end-user machines — they have no env var or
        // .env.sync. Resolution order: env var > dev .env.sync > baked resource.
        val res = readResourceProps()
        fun cfg(key: String): String? = System.getenv(key)?.takeIf { it.isNotBlank() }
            ?: env[key]?.takeIf { it.isNotBlank() }
            ?: res[key]?.takeIf { it.isNotBlank() }

        // The Nyora sync server (OAuth2/JWT). Defaults to the web app's production endpoint
        // so desktop and web sync the same account; env overrides allow dev/self-hosting.
        url = cfg("NYORA_SYNC_URL") ?: "https://sync.nyora.xyz"

        cfg("GOOGLE_DESKTOP_CLIENT_ID")?.let { googleDesktopClientId = it }
        cfg("GOOGLE_SERVER_CLIENT_ID")?.let { googleServerClientId = it }
        cfg("GOOGLE_CLIENT_SECRET")?.let { googleClientSecret = it }

        val tokenFile = dataDir.resolve("nyora-sync-tokens.properties")
        // One-time migration: an older build stored the session under the Supabase-era filename.
        // Rename it so returning users stay signed in after the token file was renamed.
        val legacyTokenFile = dataDir.resolve("supabase_tokens.properties")
        if (!Files.exists(tokenFile) && Files.exists(legacyTokenFile)) {
            runCatching { Files.move(legacyTokenFile, tokenFile) }
        }
        if (Files.exists(tokenFile)) {
            val p = Properties().also { it.load(Files.newBufferedReader(tokenFile)) }
            accessToken = p.getProperty("access_token", "")
            refreshToken = p.getProperty("refresh_token", "")
            userId = p.getProperty("user_id", "")
            email = p.getProperty("email", "")
            lastSyncTimestamp = p.getProperty("last_sync_timestamp", "1970-01-01T00:00:00Z")
        }
    }

    fun saveTokens(dataDir: Path) {
        if (HelperProfile.isolated) return // Electron persists the returned session with OS encryption.
        val p = Properties()
        p["access_token"] = accessToken
        p["refresh_token"] = refreshToken
        p["user_id"] = userId
        p["email"] = email
        p["last_sync_timestamp"] = lastSyncTimestamp
        Files.newBufferedWriter(HelperProfile.confine(dataDir.resolve("nyora-sync-tokens.properties")))
            .use { w -> p.store(w, null) }
    }

    fun clearTokens(dataDir: Path) {
        accessToken = ""; refreshToken = ""; userId = ""; email = ""; lastSyncTimestamp = "1970-01-01T00:00:00Z"
        if (!HelperProfile.isolated) Files.deleteIfExists(HelperProfile.confine(dataDir.resolve("nyora-sync-tokens.properties")))
    }

    fun parseUserIdFromJwt(token: String): String = runCatching {
        val payload = token.split(".").getOrNull(1) ?: return ""
        val padded = payload + "=".repeat((4 - payload.length % 4) % 4)
        val decoded = String(Base64.getUrlDecoder().decode(padded))
        Regex("\"sub\"\\s*:\\s*\"([^\"]+)\"").find(decoded)?.groupValues?.get(1) ?: ""
    }.getOrDefault("")

    fun parseEmailFromJwt(token: String): String = runCatching {
        val payload = token.split(".").getOrNull(1) ?: return ""
        val padded = payload + "=".repeat((4 - payload.length % 4) % 4)
        val decoded = String(Base64.getUrlDecoder().decode(padded))
        Regex("\"email\"\\s*:\\s*\"([^\"]+)\"").find(decoded)?.groupValues?.get(1) ?: ""
    }.getOrDefault("")

    private fun readProp(dataDir: Path, key: String): String {
        val file = dataDir.resolve("nyora-sync-config.properties")
        if (!Files.exists(file)) return ""
        return Properties()
            .also { it.load(Files.newBufferedReader(file)) }
            .getProperty(key, "")
    }

    // KEY=VALUE pairs baked into the packaged app at build time. CI writes
    // /nyora-oauth.properties into the artifact's resources from an Actions
    // secret (gitignored, never committed), so a distributed app carries the
    // OAuth client secret without it living in the source tree or git history.
    private fun readResourceProps(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        runCatching {
            NyoraSyncConfig::class.java.getResourceAsStream("/nyora-oauth.properties")?.use { stream ->
                Properties().also { it.load(stream) }.forEach { (k, v) -> out[k.toString()] = v.toString() }
            }
        }
        return out
    }

    // Reads KEY=VALUE pairs (active, uncommented lines) from the canonical env
    // owned by nyora-shared, then a local .env.sync in the working dir as an
    // override. Lets the private shared engine own one env for all desktop apps.
    private fun readEnvSync(): Map<String, String> {
        val dir = System.getProperty("user.dir") ?: "."
        val merged = LinkedHashMap<String, String>()
        for (rel in listOf("nyora-shared/.env.sync", ".env.sync")) {
            val file = Path.of(dir, rel)
            if (!Files.exists(file)) continue
            runCatching {
                Files.readAllLines(file).forEach { line ->
                    val t = line.trim()
                    if (t.isEmpty() || t.startsWith("#")) return@forEach
                    val i = t.indexOf('=')
                    if (i > 0) merged[t.substring(0, i).trim()] = t.substring(i + 1).trim()
                }
            }
        }
        return merged
    }
}
