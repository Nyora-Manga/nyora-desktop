package com.nyora.hasan72341.shared.repository

import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaSourceRef
import java.nio.file.Files
import java.sql.DriverManager
import kotlin.test.Test
import kotlin.test.assertEquals

class SqlDelightLibraryRepositorySourceRefTest {

    @Test
    fun dataDrivenScriptSourceSurvivesSqlRepositoryRoundTrip() {
        val directory = Files.createTempDirectory("nyora-data-source-ref-test")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            repository.upsertManga(
                Manga(
                    id = "-8888176714300257652",
                    title = "Secret Class",
                    url = "/manga/secret-class/",
                    source = MangaSourceRef.Script("data:porncomic18"),
                ),
            )

            val restored = repository.load().mangas.single()

            assertEquals(MangaSourceRef.Script("data:porncomic18"), restored.source)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun mangaIdMigrationMatchesGenericAndNativeBrowseIdentity() {
        val directory = Files.createTempDirectory("nyora-manga-id-migration-test")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            val cases = listOf(
                Triple(MangaSourceRef.Script("data:porncomic18"), "/manga/secret-class/", "-8888176714300257652"),
                Triple(MangaSourceRef.Parser("MANGAFIRE_EN"), "/title/fire-1-fire-title", "6906297880919939313"),
                Triple(MangaSourceRef.Parser("TOONILY_ME"), "toon-1", "3628026392916723550"),
                Triple(MangaSourceRef.Script("data:manganato"), "/manga/nato-title", "-88357243894273658"),
                Triple(MangaSourceRef.Script("data:manganelo"), "/manga/nato-title", "-4928346791005383400"),
                Triple(MangaSourceRef.Script("data:mangakakalot"), "/manga/nato-title", "-3741407860380787571"),
                Triple(MangaSourceRef.Script("data:mangakakalottv"), "/manga/nato-title", "-7363512028750130229"),
            )
            cases.forEachIndexed { index, (source, url, _) ->
                repository.upsertManga(
                    Manga(
                        id = "pre-stable-$index",
                        title = "Manga $index",
                        url = url,
                        source = source,
                    ),
                )
            }

            repository.migrateMangaIdsToNyoraId()

            assertEquals(
                cases.associate { (_, url, expectedId) -> url + expectedId to expectedId },
                repository.load().mangas.associate { it.url + it.id to it.id },
            )
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun mangaIdMigrationRewritesRetiredParserRefsToTheirOpenableDataSuccessor() {
        val directory = Files.createTempDirectory("nyora-parser-source-successor-test")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            repository.upsertManga(
                Manga(
                    id = "-4928346791005383400",
                    title = "Nato title",
                    url = "/manga/nato-title",
                    source = MangaSourceRef.Parser("MANGANELO_COM"),
                ),
            )

            repository.migrateMangaIdsToNyoraId()

            assertEquals(MangaSourceRef.Script("data:manganelo"), repository.load().mangas.single().source)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun mangaIdMigrationMergesNewerStateAndRekeysTrackingAndPageCache() {
        val directory = Files.createTempDirectory("nyora-manga-id-collision-test")
        try {
            val dbPath = directory.resolve("library.db")
            val repository = SqlDelightLibraryRepository(dbPath)
            val oldId = "raw-engine-id"
            val canonicalId = "-8888176714300257652"
            val url = "/manga/secret-class/"
            val source = MangaSourceRef.Script("data:porncomic18")
            repository.upsertManga(
                Manga(
                    id = canonicalId,
                    title = "Canonical metadata",
                    url = url,
                    source = source,
                    description = "Keep the richer synced row",
                    progress = 0.1f,
                ),
            )
            repository.upsertManga(
                Manga(
                    id = oldId,
                    title = "Alias metadata",
                    url = url,
                    source = source,
                    progress = 0.9f,
                ),
            )

            DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
                connection.prepareStatement("UPDATE manga SET source_ref = ? WHERE id = ?").use { statement ->
                    statement.setString(1, """{"name":"{\"name\":\"DD_porncomic18\"}"}""")
                    statement.setString(2, oldId)
                    statement.executeUpdate()
                }
                connection.createStatement().use { sql ->
                    sql.executeUpdate("UPDATE manga SET updated_at = 1 WHERE id = '$canonicalId'")
                    sql.executeUpdate("UPDATE manga SET updated_at = 2 WHERE id = '$oldId'")
                    sql.executeUpdate(
                        "INSERT INTO manga_history " +
                            "(manga_id, chapter_id, page, percent, updated_at) " +
                            "VALUES ('$canonicalId', 'canonical-chapter', 1, 0.1, 2)",
                    )
                    sql.executeUpdate(
                        "INSERT INTO manga_history " +
                            "(manga_id, chapter_id, page, percent, updated_at, deleted_at) " +
                            "VALUES ('$oldId', 'newer-alias-chapter', 9, 0.9, 1, 3)",
                    )
                    sql.executeUpdate(
                        "INSERT INTO manga_prefs (manga_id, reader_mode, updated_at) " +
                            "VALUES ('$canonicalId', 'PAGED', 1)",
                    )
                    sql.executeUpdate(
                        "INSERT INTO manga_prefs (manga_id, reader_mode, updated_at) " +
                            "VALUES ('$oldId', 'WEBTOON', 2)",
                    )
                    sql.executeUpdate(
                        "INSERT INTO tracking " +
                            "(tracker_id, manga_id, remote_id, last_read_chapter, updated_at) " +
                            "VALUES ('anilist', '$canonicalId', '123', 1, '2026-01-01T00:00:00Z')",
                    )
                    sql.executeUpdate(
                        "INSERT INTO tracking " +
                            "(tracker_id, manga_id, remote_id, last_read_chapter, updated_at, deleted_at) " +
                            "VALUES ('anilist', '$oldId', '123', 9, '2025-12-01T00:00:00Z', " +
                            "'2026-03-01T00:00:00Z')",
                    )
                    sql.executeUpdate(
                        "INSERT INTO chapter_pages (chapter_url, manga_id, pages_json, fetched_at) " +
                            "VALUES ('/chapter/9', '$oldId', '[]', 2)",
                    )
                }
            }

            repository.migrateMangaIdsToNyoraId()

            assertEquals(
                Manga(
                    id = canonicalId,
                    title = "Canonical metadata",
                    url = url,
                    source = source,
                    description = "Keep the richer synced row",
                    progress = 0.9f,
                ),
                repository.load().mangas.single(),
            )
            DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
                connection.createStatement().use { sql ->
                    sql.executeQuery(
                        "SELECT chapter_id, page, percent, deleted_at FROM manga_history WHERE manga_id = '$canonicalId'",
                    ).use { row ->
                        row.next()
                        assertEquals("newer-alias-chapter", row.getString(1))
                        assertEquals(9, row.getInt(2))
                        assertEquals(0.9, row.getDouble(3))
                        assertEquals(3L, row.getLong(4))
                    }
                    sql.executeQuery(
                        "SELECT reader_mode FROM manga_prefs WHERE manga_id = '$canonicalId'",
                    ).use { row ->
                        row.next()
                        assertEquals("WEBTOON", row.getString(1))
                    }
                    sql.executeQuery(
                        "SELECT last_read_chapter, deleted_at FROM tracking WHERE manga_id = '$canonicalId'",
                    ).use { row ->
                        row.next()
                        assertEquals(9.0, row.getDouble(1))
                        assertEquals("2026-03-01T00:00:00Z", row.getString(2))
                    }
                    sql.executeQuery("SELECT manga_id FROM chapter_pages WHERE chapter_url = '/chapter/9'").use { row ->
                        row.next()
                        assertEquals(canonicalId, row.getString(1))
                    }
                    listOf("manga", "manga_history", "manga_prefs", "tracking").forEach { table ->
                        sql.executeQuery("SELECT COUNT(*) FROM $table WHERE ${if (table == "manga") "id" else "manga_id"} = '$oldId'")
                            .use { row ->
                                row.next()
                                assertEquals(0, row.getInt(1), table)
                            }
                    }
                }
            }
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun webtoonsLegacyPathMigratesToTheEngineTitleNumberIdentity() {
        val directory = Files.createTempDirectory("nyora-webtoons-id-migration-test")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            repository.upsertManga(
                Manga(
                    id = "4351408267434886448",
                    title = "I'm the Max-Level Newbie",
                    url = "/en/action/im-the-max-level-newbie/list?title_no=3915",
                    source = MangaSourceRef.Parser("WEBTOONS"),
                ),
            )

            repository.migrateMangaIdsToNyoraId()

            val migrated = repository.load().mangas.single()
            assertEquals("4210925046420603624", migrated.id)
            assertEquals("3915", migrated.url)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun nestedAndroidAliasMergesWithExistingLegacyJsCanonicalRow() {
        val directory = Files.createTempDirectory("nyora-atsumoe-id-collision-test")
        try {
            val dbPath = directory.resolve("library.db")
            val repository = SqlDelightLibraryRepository(dbPath)
            val aliasId = "1076149343"
            val canonicalId = "1246448929784379464"
            val url = "/manga/VRSVH"
            repository.upsertManga(
                Manga(
                    id = canonicalId,
                    title = "Canonical ATSUMOE",
                    url = url,
                    source = MangaSourceRef.Script("JS_ATSUMOE"),
                ),
            )
            repository.upsertManga(
                Manga(
                    id = aliasId,
                    title = "Android ATSUMOE alias",
                    url = url,
                    source = MangaSourceRef.Script("data:ATSUMOE"),
                ),
            )
            DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
                connection.createStatement().use { sql ->
                    sql.executeUpdate(
                        "UPDATE manga SET source_ref = '{\"name\":\"{\\\"name\\\":\\\"DD_ATSUMOE\\\"}\"}' " +
                            "WHERE id = '$aliasId'",
                    )
                    sql.executeUpdate(
                        "INSERT INTO manga_history (manga_id, chapter_id, page, updated_at) " +
                            "VALUES ('$canonicalId', 'old-canonical', 1, 1)",
                    )
                    sql.executeUpdate(
                        "INSERT INTO manga_history (manga_id, chapter_id, page, updated_at) " +
                            "VALUES ('$aliasId', 'newer-alias', 7, 2)",
                    )
                }
            }

            repository.migrateMangaIdsToNyoraId()

            val manga = repository.load().mangas.single()
            assertEquals(canonicalId, manga.id)
            assertEquals(MangaSourceRef.Script("data:atsumoe"), manga.source)
            DriverManager.getConnection("jdbc:sqlite:$dbPath").use { connection ->
                connection.createStatement().use { sql ->
                    sql.executeQuery(
                        "SELECT chapter_id, page FROM manga_history WHERE manga_id = '$canonicalId'",
                    ).use { row ->
                        row.next()
                        assertEquals("newer-alias", row.getString(1))
                        assertEquals(7, row.getInt(2))
                    }
                    sql.executeQuery("SELECT COUNT(*) FROM manga WHERE id = '$aliasId'").use { row ->
                        row.next()
                        assertEquals(0, row.getInt(1))
                    }
                }
            }
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun existingGenericJsParserIdentityIsNotRehashedFromItsAbsoluteStoredUrl() {
        val directory = Files.createTempDirectory("nyora-asura-stable-id-test")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            // Generic JS rows were already assigned by that parser. Migration is allowed to use
            // source equivalence to validate a DD collision, but never to manufacture a new JS id.
            val stableId = "922337203685477580"
            val storedUrl = "https://asurascans.com/comics/solo-leveling-89829cb7"
            repository.upsertManga(
                Manga(
                    id = stableId,
                    title = "Solo Leveling",
                    url = storedUrl,
                    source = MangaSourceRef.Script("JS_ASURASCANS_US"),
                ),
            )

            repository.migrateMangaIdsToNyoraId()

            val unchanged = repository.load().mangas.single()
            assertEquals(stableId, unchanged.id)
            assertEquals(storedUrl, unchanged.url)
            assertEquals(MangaSourceRef.Script("JS_ASURASCANS_US"), unchanged.source)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun retiredAsuraDataRowMigratesToTheLiveSuccessor() {
        val directory = Files.createTempDirectory("nyora-asura-data-successor-test")
        try {
            val repository = SqlDelightLibraryRepository(directory.resolve("library.db"))
            val stableId = "-7930331079980969865"
            repository.upsertManga(
                Manga(
                    id = stableId,
                    title = "Solo Leveling",
                    url = "https://asurascans.com/comics/solo-leveling-89829cb7",
                    source = MangaSourceRef.Script("data:ASURASCANS_US"),
                ),
            )

            repository.migrateMangaIdsToNyoraId()

            val migrated = repository.load().mangas.single()
            assertEquals(stableId, migrated.id)
            assertEquals("/comics/solo-leveling-89829cb7", migrated.url)
            assertEquals(MangaSourceRef.Script("data:asurascans"), migrated.source)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }
}
