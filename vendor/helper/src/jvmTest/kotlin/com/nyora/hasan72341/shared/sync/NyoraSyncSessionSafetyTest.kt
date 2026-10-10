package com.nyora.hasan72341.shared.sync

import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer

class NyoraSyncSessionSafetyTest {

    @Test
    fun restoreDoesNotClearLocalDataWhenSessionRefreshFails() {
        val directory = Files.createTempDirectory("nyora-sync-session-safety-test")
        val previous = SyncConfigSnapshot.capture()
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            repository.createCategory("Keep offline")

            MockWebServer().use { server ->
                server.start()
                server.enqueue(MockResponse.Builder().code(401).body("expired").build())
                server.enqueue(MockResponse.Builder().code(401).body("unauthorized").build())

                NyoraSyncConfig.url = server.url("/").toString().trimEnd('/')
                NyoraSyncConfig.accessToken = "expired-access-token"
                NyoraSyncConfig.refreshToken = "expired-refresh-token"
                NyoraSyncConfig.userId = "user-1"
                NyoraSyncConfig.email = "reader@example.com"

                val error = assertFailsWith<IllegalStateException> {
                    NyoraSync(repository, directory).restoreFromCloud()
                }

                assertEquals("Nyora Sync session expired. Sign in again.", error.message)
                assertEquals(listOf("Keep offline"), repository.favouriteCategories().map { it.title })
                assertEquals(1, server.requestCount)
            }
        } finally {
            previous.restore()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun restoreRollsBackLocalDeletionWhenTheCloudPullFailsPartwayThrough() {
        val directory = Files.createTempDirectory("nyora-sync-restore-rollback-test")
        val previous = SyncConfigSnapshot.capture()
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            repository.createCategory("Keep on failed restore")

            MockWebServer().use { server ->
                server.start()
                server.enqueue(
                    MockResponse.Builder()
                        .code(200)
                        .body("""{"access_token":"e30.eyJzdWIiOiJ1c2VyLTEifQ.sig","refresh_token":"rotated"}""")
                        .build(),
                )
                server.enqueue(MockResponse.Builder().code(200).body("""{"data":[]}""").build())
                server.enqueue(MockResponse.Builder().code(503).body("temporarily unavailable").build())

                NyoraSyncConfig.url = server.url("/").toString().trimEnd('/')
                NyoraSyncConfig.accessToken = "expired-access-token"
                NyoraSyncConfig.refreshToken = "refresh-token"
                NyoraSyncConfig.userId = "user-1"
                NyoraSyncConfig.email = "reader@example.com"

                val error = assertFailsWith<IllegalStateException> {
                    NyoraSync(repository, directory).restoreFromCloud()
                }

                assertTrue(error.message.orEmpty().contains("fetch nyora_favourite failed 503"))
                assertEquals(
                    listOf("Keep on failed restore"),
                    repository.favouriteCategories().map { it.title },
                )
                assertEquals(3, server.requestCount)
            }
        } finally {
            previous.restore()
            directory.toFile().deleteRecursively()
        }
    }

    private data class SyncConfigSnapshot(
        val url: String,
        val accessToken: String,
        val refreshToken: String,
        val userId: String,
        val email: String,
        val lastSyncTimestamp: String,
    ) {
        fun restore() {
            NyoraSyncConfig.url = url
            NyoraSyncConfig.accessToken = accessToken
            NyoraSyncConfig.refreshToken = refreshToken
            NyoraSyncConfig.userId = userId
            NyoraSyncConfig.email = email
            NyoraSyncConfig.lastSyncTimestamp = lastSyncTimestamp
        }

        companion object {
            fun capture() = SyncConfigSnapshot(
                url = NyoraSyncConfig.url,
                accessToken = NyoraSyncConfig.accessToken,
                refreshToken = NyoraSyncConfig.refreshToken,
                userId = NyoraSyncConfig.userId,
                email = NyoraSyncConfig.email,
                lastSyncTimestamp = NyoraSyncConfig.lastSyncTimestamp,
            )
        }
    }
}
