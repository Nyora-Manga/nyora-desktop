package com.nyora.hasan72341.shared.sync

import kotlinx.serialization.json.*
import java.nio.file.Files
import kotlin.test.*

class DesktopSyncBridgeTest {
    private fun session(token: String = "old-access") = buildJsonObject {
        put("accessToken", token); put("refreshToken", "refresh"); put("userId", "fixture-user")
        put("email", "fixture@example.com"); put("lastSyncTimestamp", "1970-01-01T00:00:00Z")
    }
    @Test fun sessionRotationReturnsOnlyToMainAndClearsHelperMemoryEvenOnFailure() {
        val bridge = DesktopSyncBridge { action, _, _ ->
            assertEquals("now", action)
            assertEquals("old-access", NyoraSyncConfig.accessToken)
            NyoraSyncConfig.accessToken = "rotated-access"
            "simulated failure after rotation"
        }
        val result = bridge.execute(buildJsonObject { put("action", "now"); put("session", session()) })
        assertEquals("rotated-access", result["session"]!!.jsonObject["accessToken"]!!.jsonPrimitive.content)
        assertNotNull(result["error"])
        assertEquals("", NyoraSyncConfig.accessToken)
        assertEquals("", NyoraSyncConfig.refreshToken)
        assertEquals("", NyoraSyncConfig.url)
    }
    @Test fun rejectsArbitraryServerActionsAndUnsignedAccountSessionsBeforeRunning() {
        var calls = 0
        val bridge = DesktopSyncBridge { _, _, _ -> calls++; null }
        for (request in listOf(
            buildJsonObject { put("action", "restore"); put("session", session()) },
            buildJsonObject { put("action", "now"); put("url", "https://evil.example"); put("session", session()) },
            buildJsonObject { put("action", "now") },
        )) assertFailsWith<IllegalArgumentException> { bridge.execute(request) }
        assertEquals(0, calls)
    }
    @Test fun isolatedSyncNeverWritesPlaintextTokens() {
        val previous = System.getProperty("nyora.desktop.isolated")
        val directory = Files.createTempDirectory("nyora-desktop-sync")
        try {
            System.setProperty("nyora.desktop.isolated", "true")
            NyoraSyncConfig.saveTokens(directory)
            assertFalse(Files.exists(directory.resolve("nyora-sync-tokens.properties")))
        } finally {
            if (previous == null) System.clearProperty("nyora.desktop.isolated") else System.setProperty("nyora.desktop.isolated", previous)
            directory.toFile().deleteRecursively()
        }
    }
    @Test fun signingInDoesNotTriggerAnyLibraryMerge() {
        val actions = mutableListOf<String>()
        val result = DesktopSyncBridge { action, email, password ->
            actions += action
            assertEquals("fixture@example.com", email); assertEquals("fixture-password", password)
            NyoraSyncConfig.accessToken = "new-access"; NyoraSyncConfig.refreshToken = "new-refresh"
            NyoraSyncConfig.userId = "fixture-user"; NyoraSyncConfig.email = email
            null
        }.execute(buildJsonObject { put("action", "signIn"); put("email", "fixture@example.com"); put("password", "fixture-password") })
        assertEquals(listOf("signIn"), actions)
        assertNull(result["error"])
        assertEquals("", NyoraSyncConfig.userId)
    }
}
