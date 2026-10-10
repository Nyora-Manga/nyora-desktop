package com.nyora.hasan72341.shared.extension

import app.nyora.core.model.ContentRating as EngineContentRating
import app.nyora.core.model.Manga as EngineManga
import app.nyora.core.model.MangaChapter as EngineMangaChapter
import app.nyora.core.model.MangaPage as EngineMangaPage
import app.nyora.core.model.MangaListFilter
import app.nyora.core.model.MangaTag as EngineMangaTag
import app.nyora.core.model.MangaState as EngineMangaState
import app.nyora.data.engine.ContentType as EngineContentType
import app.nyora.data.engine.EngineRegistry
import app.nyora.data.engine.SourceEngine as DataEngine
import app.nyora.data.runtime.DefaultEngineContext
import com.nyora.hasan72341.shared.model.ContentRating
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.MangaState
import com.nyora.hasan72341.shared.model.MangaTag
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.NYORA_BROWSER_UA
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.Locale

/** Bridges one bundled data-engine source to the desktop extension API. */
class DataDrivenExtensionService private constructor(
    private val source: MangaSource,
    private val engine: DataEngine,
    private val legacySourceName: String,
) : MangaExtensionService {
    /** Keeps the existing engine-injection seam used by focused service tests. */
    constructor(source: MangaSource, entry: DataDrivenSource, engine: DataEngine) : this(
        source = source,
        engine = engine,
        legacySourceName = entry.legacySourceName(),
    )

    constructor(
        source: MangaSource,
        entry: DataDrivenSource,
        networkConfig: HelperNetworkConfig = HelperNetworkConfig(),
    ) : this(
        source = source,
        engine = EngineRegistry.create(
            entry.engineKey,
            entry.definition,
            DefaultEngineContext(
                userAgent = NYORA_BROWSER_UA,
                clientProvider = { networkConfig.sourceHttpClient(source.id) },
                effectiveDomain = { entry.definition.domain },
            ),
        ).let { networkConfig.desktopRelay?.guardEngine(it) ?: it },
        legacySourceName = entry.legacySourceName(),
    )

    override val supportsLatest: Boolean = true
    override val domain: String = source.baseUrl.removePrefix("https://").removePrefix("http://")

    override fun getHeaders(): Map<String, String> = mapOf("Referer" to "${source.baseUrl.trimEnd('/')}/")

    override suspend fun getPopular(page: Int): MangaSearchPage = engine.getPopular(page.zeroIndexed()).toSearchPage()

    override suspend fun getLatest(page: Int): MangaSearchPage = engine.getLatest(page.zeroIndexed()).toSearchPage()

    override suspend fun search(query: String, page: Int, filters: List<SourceFilter>): MangaSearchPage {
        val normalizedQuery = query.trim().ifBlank { null }
        return engine.search(
            page.zeroIndexed(),
            normalizedQuery,
            filters.toEngineFilter(normalizedQuery, engine.source.id),
        ).toSearchPage()
    }

    override suspend fun getBrowseOptions(): SourceBrowseOptions {
        val options = engine.advancedFilterOptions
        return SourceBrowseOptions(
            filters = options.filterKeys { it != "Tags" && it != "Excluded tags" }
                .map { (name, values) -> SourceFilterDescriptor(name, "text", values, name in engine.multiValueFilters) },
            tags = if ("Tags" in options) engine.getAvailableTags().map { it.key to it.title } else emptyList(),
            multipleTags = engine.capabilities.multipleTags,
            tagsExclusion = "Excluded tags" in options,
            searchWithFilters = engine.capabilities.searchWithFilters,
        )
    }

    override fun getFilterList(): List<SourceFilterDescriptor> = buildList {
        add(SourceFilterDescriptor(name = FILTER_TAGS, typeName = FILTER_TEXT))
        if (engine.capabilities.tagsExclusion) {
            add(SourceFilterDescriptor(name = FILTER_EXCLUDED_TAGS, typeName = FILTER_TEXT))
        }
        if (engine.capabilities.year) {
            add(SourceFilterDescriptor(name = FILTER_YEAR, typeName = FILTER_TEXT))
        }
        if (engine.capabilities.authorSearch) {
            add(SourceFilterDescriptor(name = FILTER_AUTHOR, typeName = FILTER_TEXT))
        }
        add(SourceFilterDescriptor(FILTER_STATE, FILTER_SELECT, anyPlus(EngineMangaState.entries)))
        add(SourceFilterDescriptor(FILTER_TYPE, FILTER_SELECT, anyPlus(EngineContentType.entries)))
        add(SourceFilterDescriptor(FILTER_RATING, FILTER_SELECT, anyPlus(EngineContentRating.entries)))
        add(SourceFilterDescriptor(name = FILTER_LOCALE, typeName = FILTER_TEXT))
    }

    override suspend fun getDetails(url: String): MangaDetails {
        val detailed = engine.getDetails(EngineManga(id = url, title = "", url = url))
        val manga = detailed.toShared(source, legacySourceName)
        return MangaDetails(manga = manga, chapters = detailed.chapters.orEmpty().mapIndexed { index, chapter ->
            chapter.toShared(index)
        })
    }

    override suspend fun getPageList(chapter: MangaChapter): List<MangaPage> {
        val dataChapter = EngineMangaChapter(
            id = chapter.id,
            title = chapter.title.ifBlank { null },
            number = chapter.number,
            volume = chapter.volume,
            url = chapter.url,
            scanlator = chapter.scanlator,
            uploadDate = chapter.uploadDate,
            branch = chapter.branch,
        )
        val pages = engine.getPageList(dataChapter)
        val sourceHeaders = getHeaders()
        return coroutineScope {
            pages.map { page ->
                async(Dispatchers.IO) {
                    pageResolveGate.withPermit {
                        // Resolver-style engines return an HTML reader URL in page.url and must
                        // scrape the actual image here. Any failure therefore aborts this chapter
                        // response so the REST layer cannot cache HTML as an image for seven days;
                        // a later request (or the Cloudflare solver) can retry cleanly.
                        val resolved = engine.resolvePageImageRequest(page)
                        MangaPage(
                            url = resolved.url,
                            headers = buildMap {
                                putAll(sourceHeaders)
                                putAll(page.headers)
                                putAll(resolved.headers)
                            },
                        )
                    }
                }
            }.awaitAll()
        }
    }

    private fun List<EngineManga>.toSearchPage(): MangaSearchPage = MangaSearchPage(
        entries = map { it.toShared(source, legacySourceName) },
        // The data-engine contract returns a list rather than an explicit paginator signal.
        hasNextPage = isNotEmpty(),
    )

    private fun Int.zeroIndexed(): Int = (this - 1).coerceAtLeast(0)

    private companion object {
        const val PAGE_RESOLVE_CONCURRENCY = 8
        val pageResolveGate = Semaphore(PAGE_RESOLVE_CONCURRENCY)

        const val FILTER_TAGS = "Tags"
        const val FILTER_EXCLUDED_TAGS = "Excluded tags"
        const val FILTER_YEAR = "Year"
        const val FILTER_AUTHOR = "Author"
        const val FILTER_STATE = "State"
        const val FILTER_TYPE = "Type"
        const val FILTER_RATING = "Rating"
        const val FILTER_LOCALE = "Locale"
        const val FILTER_TEXT = "text"
        const val FILTER_SELECT = "select"

        fun <T : Enum<T>> anyPlus(values: Iterable<T>): List<String> =
            listOf("Any") + values.map { it.name }
    }
}

private fun List<SourceFilter>.toEngineFilter(query: String?, sourceId: String): MangaListFilter {
    val tags = linkedSetOf<EngineMangaTag>()
    val excludedTags = linkedSetOf<EngineMangaTag>()
    val states = linkedSetOf<EngineMangaState>()
    val types = linkedSetOf<EngineContentType>()
    val ratings = linkedSetOf<EngineContentRating>()
    var sortOrder: app.nyora.core.model.SortOrder? = null
    var year = 0
    var author: String? = null
    var locale: Locale? = null

    for (filter in this) {
        when (filter.normalizedName()) {
            "sort" -> if (filter is TextSourceFilter) {
                sortOrder = app.nyora.core.model.SortOrder.entries.firstOrNull { it.name == filter.value }
            }
            "tag", "tags", "genre", "genres", "includedtag", "includedtags" ->
                if (filter is TextSourceFilter) tags += filter.value.toEngineTags(sourceId)
            "excludedtag", "excludedtags", "tagsexclude", "excludedgenre", "excludedgenres" ->
                if (filter is TextSourceFilter) excludedTags += filter.value.toEngineTags(sourceId)
            "year", "publishedyear" ->
                if (filter is TextSourceFilter) year = filter.value.trim().toIntOrNull() ?: 0
            "author", "authors" ->
                if (filter is TextSourceFilter) author = filter.value.trim().ifBlank { null }
            "state", "status" -> states += filter.enumValues(EngineMangaState.entries)
            "type", "contenttype" -> types += filter.enumValues(EngineContentType.entries)
            "rating", "contentrating" -> ratings += filter.enumValues(EngineContentRating.entries)
            "locale", "language" -> if (filter is TextSourceFilter) {
                locale = filter.value.trim().takeIf { it.isNotBlank() }?.let(Locale::forLanguageTag)
            }
        }
    }
    return MangaListFilter(
        query = query,
        sortOrder = sortOrder,
        tags = tags,
        tagsExclude = excludedTags,
        states = states,
        types = types,
        contentRating = ratings,
        year = year,
        author = author,
        locale = locale,
    )
}

private fun SourceFilter.normalizedName(): String =
    name.lowercase(Locale.ROOT).filter(Char::isLetterOrDigit)

private fun String.toEngineTags(sourceId: String): Set<EngineMangaTag> =
    split(',', ';')
        .map(String::trim)
        .filter(String::isNotBlank)
        .mapTo(linkedSetOf()) { value -> EngineMangaTag(title = value, key = value, source = sourceId) }

private fun <T : Enum<T>> SourceFilter.enumValues(options: List<T>): Set<T> = when (this) {
    is SelectSourceFilter -> listOfNotNull(options.getOrNull(selectedIndex - 1)).toSet()
    is TextSourceFilter -> value.split(',', ';')
        .map(String::trim)
        .mapNotNull { value -> options.firstOrNull { it.name.equals(value, ignoreCase = true) } }
        .toSet()
    is CheckSourceFilter -> emptySet()
}

internal fun EngineManga.toShared(source: MangaSource): Manga =
    toShared(source, source.id.substringAfter(':', source.id).uppercase())

private fun EngineManga.toShared(source: MangaSource, legacySourceName: String): Manga = Manga(
    id = legacyMangaId(legacySourceName, url).toString(),
    title = title,
    altTitles = altTitles.toList(),
    url = url,
    publicUrl = publicUrl.ifBlank { source.absoluteUrl(url) },
    rating = rating,
    isNsfw = isNsfw || source.isNsfw || contentRating == EngineContentRating.ADULT,
    contentRating = contentRating?.toShared(),
    coverUrl = coverUrl.orEmpty().let(source::absoluteUrl),
    largeCoverUrl = largeCoverUrl?.let(source::absoluteUrl),
    state = state?.toShared(),
    authors = authors.toList(),
    source = MangaSourceRef.Script(source.id),
    description = description.orEmpty(),
    tags = tags.map { MangaTag(key = it.key, title = it.title) },
    chapters = chapters.orEmpty().mapIndexed { index, chapter -> chapter.toShared(index) },
)

private fun EngineMangaChapter.toShared(index: Int): MangaChapter = MangaChapter(
    id = id,
    title = title.orEmpty(),
    number = number,
    volume = volume,
    url = url,
    scanlator = scanlator,
    uploadDate = uploadDate,
    branch = branch,
    index = index,
)

private fun EngineContentRating.toShared(): ContentRating = when (this) {
    EngineContentRating.SAFE -> ContentRating.SAFE
    EngineContentRating.SUGGESTIVE -> ContentRating.SUGGESTIVE
    EngineContentRating.ADULT -> ContentRating.ADULT
}

private fun EngineMangaState.toShared(): MangaState? = when (this) {
    EngineMangaState.ONGOING -> MangaState.ONGOING
    EngineMangaState.FINISHED -> MangaState.FINISHED
    EngineMangaState.ABANDONED -> MangaState.ABANDONED
    EngineMangaState.PAUSED -> MangaState.PAUSED
    EngineMangaState.UPCOMING -> MangaState.UPCOMING
}

private fun MangaSource.absoluteUrl(value: String): String = when {
    value.isBlank() || value.startsWith("http://") || value.startsWith("https://") -> value
    else -> "${baseUrl.trimEnd('/')}/${value.trimStart('/')}"
}

private fun DataDrivenSource.legacySourceName(): String = definition.id
    .ifBlank { source.id.substringAfter(':', source.id) }
    .let(::legacyParserSourceName)
