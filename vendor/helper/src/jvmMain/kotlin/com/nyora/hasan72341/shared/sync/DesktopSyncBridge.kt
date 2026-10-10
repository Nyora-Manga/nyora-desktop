package com.nyora.hasan72341.shared.sync

import kotlinx.serialization.json.*
import java.time.Instant

/** Private main-to-helper boundary. Never register on the hosted API. */
internal class DesktopSyncBridge(private val perform: (String, String, String) -> String?) {
    @Synchronized
    fun execute(request: JsonObject): JsonObject {
        require(request.keys.all { it in setOf("action", "session", "email", "password") }) { "Unexpected account field" }
        val action = request["action"]?.jsonPrimitive?.contentOrNull
        require(action in setOf("signIn", "register", "now")) { "Unsupported account operation" }
        val session = request["session"]?.takeUnless { it == JsonNull }?.jsonObject
        val fields = setOf("accessToken", "refreshToken", "userId", "email", "lastSyncTimestamp")
        require(session == null || session.keys == fields) { "Invalid account session" }
        fun field(name: String): String = session?.get(name)?.jsonPrimitive?.contentOrNull.orEmpty().also {
            require(it.length <= if (name.endsWith("Token")) 16384 else 1024) { "Account field too long" }
        }
        val email = request["email"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val password = request["password"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (action != "now") require(email.length in 3..254 && '@' in email && password.length in 1..4096) { "Enter your email and password" }
        else require(session != null && field("accessToken").isNotEmpty() && field("userId").isNotEmpty()) { "Sign in to Nyora Cloud first" }
        val timestamp = field("lastSyncTimestamp").ifEmpty { "1970-01-01T00:00:00Z" }
        Instant.parse(timestamp)
        val config = NyoraSyncConfig
        // Main owns the account between requests. No background helper operation
        // may retain credentials or begin syncing after the user signs out.
        config.url = "https://sync.nyora.xyz"
        config.accessToken = field("accessToken"); config.refreshToken = field("refreshToken")
        config.userId = field("userId"); config.email = field("email")
        config.lastSyncTimestamp = timestamp
        try {
            val failure = try { perform(requireNotNull(action), email, password) }
            catch (_: Exception) { "Nyora Cloud could not finish syncing. Check your connection and try again." }
            return buildJsonObject {
                put("session", buildJsonObject {
                    put("accessToken", config.accessToken); put("refreshToken", config.refreshToken)
                    put("userId", config.userId); put("email", config.email)
                    put("lastSyncTimestamp", config.lastSyncTimestamp)
                })
                if (failure != null) put("error", if (action == "now") "Nyora Cloud could not finish syncing. Try again or sign in again if your session has expired." else "Could not connect this account. Check your email and password, or try again later.")
            }
        } finally {
            config.url = ""; config.accessToken = ""; config.refreshToken = ""; config.userId = ""; config.email = ""
            config.lastSyncTimestamp = "1970-01-01T00:00:00Z"
        }
    }
}
