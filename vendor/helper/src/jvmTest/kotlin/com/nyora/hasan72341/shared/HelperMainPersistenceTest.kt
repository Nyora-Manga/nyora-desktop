package com.nyora.hasan72341.shared

import java.io.IOException
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class HelperMainPersistenceTest {
    @Test
    fun startupMigratesMixedCaseSourcesWithoutChangingMangaIdsOrPreferences() {
        val directory = Files.createTempDirectory("nyora-source-case-migration")
        val previous = System.getProperty("nyora.data.dir")
        System.setProperty("nyora.data.dir", directory.toString())
        try {
            val first = HelperMain.bootstrap()
            val source = first.facade.listSources().single { it.id.equals("data:MANGAFIRE_EN", ignoreCase = true) }
            first.repository.deleteSource(source.id)
            first.repository.upsertSource(source.copy(id = "data:MANGAFIRE_EN", isInstalled = false, isPinned = true))
            first.repository.upsertManga(com.nyora.hasan72341.shared.model.Manga(
                id = "opaque-existing-id", title = "Preserve identity", url = "/existing",
                source = com.nyora.hasan72341.shared.model.MangaSourceRef.Script("data:MANGAFIRE_EN"),
            ))
            Files.deleteIfExists(directory.resolve(".source_id_case_v1"))
            val second = HelperMain.bootstrap()
            val migrated = second.facade.listSources().single { it.id == "data:mangafire_en" }
            assertEquals(false, migrated.isInstalled)
            assertEquals(true, migrated.isPinned)
            val manga = second.repository.load().mangas.single()
            assertEquals("opaque-existing-id", manga.id)
            assertEquals("data:mangafire_en", manga.source.name)
        } finally {
            if (previous == null) System.clearProperty("nyora.data.dir") else System.setProperty("nyora.data.dir", previous)
            directory.toFile().deleteRecursively()
        }
    }


    @Test
    fun failedCatalogueWriteLeavesThePreviousPersistedCatalogueIntact() {
        val directory = Files.createTempDirectory("nyora-catalogue-persistence-test")
        try {
            val target = directory.resolve("data-driven-catalogue.json")
            Files.writeString(target, "old catalogue")

            assertFailsWith<IOException> {
                persistAtomically(target, "new catalogue") { temporary, _ ->
                    Files.writeString(temporary, "partial catalogue")
                    throw IOException("disk full")
                }
            }

            assertEquals("old catalogue", target.readText())
        } finally {
            directory.toFile().deleteRecursively()
        }
    }
}
