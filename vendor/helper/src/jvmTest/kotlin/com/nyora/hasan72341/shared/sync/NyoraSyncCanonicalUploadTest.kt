package com.nyora.hasan72341.shared.sync

import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import java.nio.file.Files
import java.sql.DriverManager
import kotlinx.serialization.json.*
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NyoraSyncCanonicalUploadTest {
    @Test
    fun outgoingSyncExcludesUnresolvedSourcesAndTheirChildrenWithoutDeletingLocalData() {
        val directory = Files.createTempDirectory("nyora-canonical-upload")
        val previousUrl = NyoraSyncConfig.url
        val previousToken = NyoraSyncConfig.accessToken
        val previousUser = NyoraSyncConfig.userId
        val previousTimestamp = NyoraSyncConfig.lastSyncTimestamp
        try {
            val database = directory.resolve("library.db")
            val repo = SqlDelightLibraryRepository(database)
            for ((id, source) in listOf(
                "valid" to MangaSourceRef.Script("data:manganelo"),
                "unresolved" to MangaSourceRef.Parser("UNRESOLVED_LEGACY"),
                "local" to MangaSourceRef.Local,
                "bookmark-only" to MangaSourceRef.Script("data:unavailable-valid-source"),
            )) repo.upsertManga(Manga(id = id, title = id, source = source))
            repo.upsertSource(MangaSource("data:manganelo", "Valid", "en", "https://example.com"))
            repo.upsertSource(MangaSource("parser:UNRESOLVED_LEGACY", "Unresolved", "en", "https://example.com"))
            DriverManager.getConnection("jdbc:sqlite:$database").use { connection ->
                connection.createStatement().use { sql ->
                    for (id in listOf("valid", "unresolved", "local")) {
                        sql.executeUpdate("INSERT INTO manga_favourite (manga_id, added_at) VALUES ('$id', 1)")
                        sql.executeUpdate("INSERT INTO manga_history (manga_id, source_id, updated_at) VALUES ('$id', 'UNRESOLVED_LEGACY', 1)")
                        sql.executeUpdate("INSERT INTO bookmark (manga_id, chapter_id, created_at) VALUES ('$id', 'chapter', 1)")
                        sql.executeUpdate("INSERT INTO manga_prefs (manga_id) VALUES ('$id')")
                        sql.executeUpdate("INSERT INTO manga_update (manga_id, source_id, last_synced_at) VALUES ('$id', 'UNRESOLVED_LEGACY', 1)")
                        sql.executeUpdate("INSERT INTO tracking (tracker_id, manga_id, source_id, updated_at) VALUES ('tracker', '$id', 'UNRESOLVED_LEGACY', '2026-01-01T00:00:00Z')")
                    }
                    sql.executeUpdate("INSERT INTO bookmark (manga_id, chapter_id, created_at) VALUES ('bookmark-only', 'chapter', 1)")
                }
            }
            MockWebServer().use { server ->
                server.start()
                repeat(40) { server.enqueue(MockResponse.Builder().body("{}").build()) }
                NyoraSyncConfig.url = server.url("/").toString().trimEnd('/')
                NyoraSyncConfig.accessToken = "test-token"
                NyoraSyncConfig.userId = "user-1"
                NyoraSyncConfig.lastSyncTimestamp = "1970-01-01T00:00:00Z"
                NyoraSync(repo, directory).pushAll()
                val sentMangaIds = mutableSetOf<String>()
                val seenTables = mutableSetOf<String>()
                repeat(server.requestCount) {
                    val body = Json.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
                    val table = body.getValue("table").jsonPrimitive.content
                    seenTables += table
                    for (row in body.getValue("rows").jsonArray.map { it.jsonObject }) {
                        if (table == "nyora_manga") {
                            val id = row.getValue("id").jsonPrimitive.content
                            assertTrue(id in setOf("valid", "bookmark-only"), "Unexpected parent $id")
                            sentMangaIds += id
                        }
                        row["manga_id"]?.jsonPrimitive?.content?.let { id ->
                            assertTrue(id in sentMangaIds, "$table uploaded an orphan child for $id")
                        }
                        row["source_id"]?.jsonPrimitive?.content?.let { id ->
                            assertTrue(id.matches(Regex("data:[a-z0-9][a-z0-9._-]*")), "$table wrote $id")
                        }
                    }
                }
                assertEquals(setOf("valid", "bookmark-only"), sentMangaIds)
                assertTrue(seenTables.containsAll(listOf("nyora_favourite", "nyora_history", "nyora_bookmark", "nyora_manga_prefs", "nyora_update", "nyora_tracking", "nyora_source_prefs")))
            }
            assertEquals(4, repo.load().mangas.size)
            assertEquals(3, repo.allFavouritesIncludingDeleted().size)
            assertEquals(4, repo.allBookmarksIncludingDeleted().size)
        } finally {
            NyoraSyncConfig.url = previousUrl
            NyoraSyncConfig.accessToken = previousToken
            NyoraSyncConfig.userId = previousUser
            NyoraSyncConfig.lastSyncTimestamp = previousTimestamp
            directory.toFile().deleteRecursively()
        }
    }
}
