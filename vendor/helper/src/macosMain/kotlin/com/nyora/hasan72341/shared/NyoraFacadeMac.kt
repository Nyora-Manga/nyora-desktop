package com.nyora.hasan72341.shared

import com.nyora.hasan72341.shared.extension.CommonMangaExtensionRuntime
import com.nyora.hasan72341.shared.extension.MangaExtensionRuntime
import com.nyora.hasan72341.shared.model.Library
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.repository.LibraryRepository

/**
 * macOS-native bootstrap exposed to SwiftUI through the NyoraShared.framework binding.
 *
 * The native target intentionally cannot execute Mihon APKs or GraalVM JavaScript.
 * The macOS app launches a JVM "helper" sidecar (see docs/MAC_HELPER.md) that owns
 * the real extension runtime and HTTP work; this native facade is used for
 * platform-side state caching, navigation, and offline reading.
 */
object NyoraFacadeMacFactory {
    fun create(repository: LibraryRepository = InMemoryRepository()): NyoraFacade = NyoraFacade(
        repository = repository,
        runtime = CommonMangaExtensionRuntime(),
    )
}

class InMemoryRepository : LibraryRepository {
    private var library: Library = Library()

    override fun load(): Library = library

    override fun save(library: Library) {
        this.library = library
    }

    override fun upsertManga(manga: Manga) {
        library = library.copy(
            mangas = (listOf(manga) + library.mangas.filterNot { it.id == manga.id }).distinctBy { it.id },
        )
    }

    override fun upsertSource(source: MangaSource) {
        library = library.copy(
            sources = (listOf(source) + library.sources.filterNot { it.id == source.id }).distinctBy { it.id },
        )
    }
}
