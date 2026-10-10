package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaState
import com.nyora.hasan72341.shared.model.MangaTag
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.HelperNetworkSettings
import com.nyora.hasan72341.shared.net.buildOkHttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup
import java.time.Instant
import com.nyora.hasan72341.shared.model.MangaSource as NyoraMangaSource

/**
 * ToonTop adapter for the existing Toonily/ToonDex and BeeHentai source identities.
 * Browse and details use api.toontop.io; chapter pages come from the public reader document.
 * The former WordPress parser no longer matches either redirected source.
 *
 * API endpoints:
 *   GET /titles/search?sort=popular|latest&page=N   and   ?q=<query>&page=N   → browse/search
 *   GET /titles/{id}                                                          → details
 *   GET /titles/{id}/chapters?page=N                                          → chapter list
 * The /images API only returns previews, so page images use the chapter's __NEXT_DATA__ payload.
 */
class ToonDexExtensionService internal constructor(
    private val source: NyoraMangaSource,
    private val networkConfig: HelperNetworkConfig,
    private val clientFactory: (HelperNetworkSettings) -> OkHttpClient,
    apiUrlOverride: String?,
    siteUrlOverride: String?,
) : MangaExtensionService {

    constructor(source: NyoraMangaSource, networkConfig: HelperNetworkConfig) : this(
        source = source,
        networkConfig = networkConfig,
        clientFactory = { networkConfig.sourceHttpClient(source.id) },
        apiUrlOverride = null,
        siteUrlOverride = null,
    )

    private val apiUrl = apiUrlOverride?.trimEnd('/') ?: "https://api.toontop.io"
    private val siteUrl = siteUrlOverride?.trimEnd('/') ?: "https://toontop.io"
    private val legacySourceName = legacyParserSourceName(source.id)
    private val resultSourceRef = source.nativeResultSourceRef()

    private val json = Json { ignoreUnknownKeys = true }

    override val supportsLatest: Boolean = true
    // Cookies, Referer, and Cloudflare setup target the reader host.
    override val domain: String = runCatching { java.net.URI(siteUrl).host }.getOrNull().orEmpty()

    override fun getHeaders(): Map<String, String> = mapOf("Referer" to "$siteUrl/")

    private fun newRequest(url: String): Request = Request.Builder()
        .url(url)
        .header("Referer", "$siteUrl/")
        .header("Accept", "application/json")
        .get()
        .build()

    private suspend fun fetchBody(url: String): String = withContext(Dispatchers.IO) {
        clientFactory(networkConfig.snapshot()).newCall(newRequest(url)).execute().use { response ->
            if (!response.isSuccessful) error("ToonTop request failed with HTTP ${response.code}")
            response.body?.string().orEmpty()
        }
    }

    // -- browse ------------------------------------------------------------
    private suspend fun browse(params: List<Pair<String, String>>): MangaSearchPage {
        val url = "$apiUrl/titles/search".toHttpUrl().newBuilder()
            .apply { params.forEach { addQueryParameter(it.first, it.second) } }
            .build()
        val data = json.decodeFromString<Envelope<SearchData>>(fetchBody(url.toString())).data
        return MangaSearchPage(
            entries = data.items.map { it.toNyora() },
            hasNextPage = data.pagination?.hasNext ?: false,
        )
    }

    override suspend fun getPopular(page: Int) = browse(listOf("sort" to "popular", "page" to "$page"))

    override suspend fun getLatest(page: Int) = browse(listOf("sort" to "latest", "page" to "$page"))

    override suspend fun search(query: String, page: Int, filters: List<SourceFilter>): MangaSearchPage =
        if (query.isBlank()) {
            browse(listOf("sort" to "popular", "page" to "$page"))
        } else {
            browse(listOf("q" to query, "page" to "$page"))
        }

    // -- details + chapters ------------------------------------------------
    override suspend fun getDetails(url: String): MangaDetails {
        val id = url.trim('/')
        val title = json.decodeFromString<Envelope<TitleData>>(fetchBody("$apiUrl/titles/$id")).data.title

        val chapters = mutableListOf<MangaChapter>()
        var page = 1
        var hasNext: Boolean
        do {
            val chUrl = "$apiUrl/titles/$id/chapters".toHttpUrl().newBuilder()
                .addQueryParameter("page", "$page")
                .build()
            val data = json.decodeFromString<Envelope<ChaptersData>>(fetchBody(chUrl.toString())).data
            data.chapters.forEach { chapters.add(it.toNyora(id)) }
            hasNext = data.pagination?.hasNext ?: false
            page++
        } while (hasNext && page <= 200)

        // API returns chapters newest-first; the engine's convention is oldest-first.
        chapters.reverse()

        return MangaDetails(manga = title.toNyora(), chapters = chapters)
    }

    // -- pages -------------------------------------------------------------
    // Read the same public chapter document as the browser. The homepage is now
    // a static landing page with no buildId; the /images API only offers previews.
    override suspend fun getPageList(chapter: MangaChapter): List<MangaPage> {
        val path = chapter.url.trim('/')
        val document = Jsoup.parse(fetchBody("$siteUrl/$path"))
        val payload = document.selectFirst("script#__NEXT_DATA__")?.data()
            ?.takeIf { it.isNotBlank() } ?: error("ToonTop chapter data is unavailable")
        val images = json.decodeFromString<ChapterDocument>(payload).props.pageProps.initialChapter.images
        check(images.isNotEmpty()) { "ToonTop chapter has no available pages" }
        return images.map { MangaPage(url = it, headers = mapOf("Referer" to "$siteUrl/")) }
    }

    private fun TitleItem.toNyora(): Manga = Manga(
        id = legacyMangaId(legacySourceName, id).toString(),
        title = name,
        url = id,
        publicUrl = siteUrl + url,
        coverUrl = cover.orEmpty(),
        largeCoverUrl = cover,
        source = resultSourceRef,
        isNsfw = source.isNsfw,
    )

    private fun TitleFull.toNyora(): Manga {
        val tags = buildList {
            genres?.forEach { add(it.name) }
            themes?.forEach { add(it.name) }
        }.distinct()
        return Manga(
            id = legacyMangaId(legacySourceName, id).toString(),
            title = name,
            url = id,
            publicUrl = siteUrl + (url ?: "/$slug"),
            coverUrl = cover.orEmpty(),
            largeCoverUrl = cover,
            authors = authors?.map { it.name }.orEmpty(),
            description = summary?.let { Jsoup.parse(it).text() }.orEmpty(),
            tags = tags.map { MangaTag(key = it, title = it) },
            state = when (status?.lowercase()) {
                "ongoing", "releasing" -> MangaState.ONGOING
                "completed", "finished" -> MangaState.FINISHED
                "hiatus", "on hold" -> MangaState.PAUSED
                "cancelled", "dropped" -> MangaState.ABANDONED
                else -> null
            },
            source = resultSourceRef,
            isNsfw = source.isNsfw,
        )
    }

    private fun ChapterItem.toNyora(@Suppress("unused") mangaId: String): MangaChapter = MangaChapter(
        id = id,
        title = name ?: number?.let { "Chapter ${it.toString().removeSuffix(".0")}" } ?: "Chapter",
        number = number ?: 0f,
        // The "<mangaSlug>/<chapterSlug>" path (from the API's url field) drives the _next/data page route.
        url = (url ?: "$mangaId/$id").trim('/'),
        uploadDate = updatedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L,
    )
}

// -- API DTOs ---------------------------------------------------------------
@Serializable
private class Envelope<T>(val data: T)

@Serializable
private class Pagination(@SerialName("has_next") val hasNext: Boolean = false)

@Serializable
private class SearchData(val items: List<TitleItem> = emptyList(), val pagination: Pagination? = null)

@Serializable
private class TitleItem(
    val id: String,
    val url: String,
    val name: String,
    val slug: String? = null,
    val cover: String? = null,
    val status: String? = null,
)

@Serializable
private class TitleData(val title: TitleFull)

@Serializable
private class TitleFull(
    val id: String,
    val url: String? = null,
    val name: String,
    val slug: String? = null,
    val cover: String? = null,
    val summary: String? = null,
    val status: String? = null,
    val authors: List<NamedRef>? = null,
    val genres: List<NamedRef>? = null,
    val themes: List<NamedRef>? = null,
)

@Serializable
private class NamedRef(val name: String)

@Serializable
private class ChaptersData(val chapters: List<ChapterItem> = emptyList(), val pagination: Pagination? = null)

@Serializable
private class ChapterItem(
    val id: String,
    val url: String? = null,
    val name: String? = null,
    val number: Float? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

// Public reader document: { props: { pageProps: { initialChapter: { images: [...] } } } }
@Serializable
private class ChapterDocument(val props: NextData)

@Serializable
private class NextData(val pageProps: NextPageProps)

@Serializable
private class NextPageProps(val initialChapter: NextChapter)

@Serializable
private class NextChapter(val images: List<String> = emptyList())
