package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage

interface MangaExtensionService {
    val supportsLatest: Boolean

    /** The source's live domain (host). Used to open the manual Cloudflare solver for it. */
    val domain: String get() = ""

    fun getHeaders(): Map<String, String> = emptyMap()

    suspend fun getPopular(page: Int): MangaSearchPage

    suspend fun getLatest(page: Int): MangaSearchPage

    suspend fun search(
        query: String,
        page: Int,
        filters: List<SourceFilter> = emptyList(),
    ): MangaSearchPage

    suspend fun getDetails(url: String): MangaDetails

    suspend fun getPageList(chapter: MangaChapter): List<MangaPage>

    fun getFilterList(): List<SourceFilterDescriptor> = emptyList()

    suspend fun getBrowseOptions(): SourceBrowseOptions = SourceBrowseOptions(filters = getFilterList())

    fun getSourcePreferences(): List<SourcePreferenceDescriptor> = emptyList()
}

data class MangaSearchPage(
    val entries: List<Manga>,
    val hasNextPage: Boolean,
)

data class MangaDetails(
    val manga: Manga,
    val chapters: List<MangaChapter>,
)

sealed interface SourceFilter {
    val name: String
}

data class TextSourceFilter(
    override val name: String,
    val value: String,
) : SourceFilter

data class SelectSourceFilter(
    override val name: String,
    val selectedIndex: Int,
) : SourceFilter

data class CheckSourceFilter(
    override val name: String,
    val checked: Boolean,
) : SourceFilter

data class SourceFilterDescriptor(
    val name: String,
    val typeName: String,
    val values: List<String> = emptyList(),
    val multiple: Boolean = false,
)

data class SourcePreferenceDescriptor(
    val key: String,
    val title: String,
    val summary: String,
    val typeName: String,
)

/** Desktop advanced browsing, using source keys rather than display labels. */
data class SourceBrowseOptions(
    val filters: List<SourceFilterDescriptor> = emptyList(),
    val tags: List<Pair<String, String>> = emptyList(),
    val multipleTags: Boolean = false,
    val tagsExclusion: Boolean = false,
    val searchWithFilters: Boolean = false,
)
