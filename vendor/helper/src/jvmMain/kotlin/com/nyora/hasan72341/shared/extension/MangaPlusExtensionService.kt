package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.buildOkHttpClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.UUID
import com.nyora.hasan72341.shared.model.MangaSource as NyoraMangaSource

/**
 * Native source for MANGA Plus by SHUEISHA — the official free-manga service.
 *
 * The bundled parser asks the API for `format=json`, a convenience mode the service used to
 * offer and no longer does: every request now comes back as a bare nginx `403 Forbidden`,
 * which reads exactly like a geo-block and is why this looked unfixable. The API itself is
 * fine. Its own web client speaks protobuf and needs three things:
 *
 *  - the `SESSION-TOKEN` header (any UUID; it is a session id, not a credential),
 *  - `Origin`/`Referer` of `mangaplus.shueisha.co.jp`,
 *  - and crucially *no* `format` parameter at all.
 *
 * Responses are `application/x-protobuf`, decoded by [ProtoMessage]. The field numbers below
 * were derived by decoding live responses rather than from a `.proto`, so each one is named
 * for what it was observed to carry.
 *
 * MANGA Plus publishes the same catalogue in several languages, and the upstream enum splits
 * that into one source per language (`MANGAPLUSPARSER_EN`, `_ES`, `_FR`, …). The API returns
 * every language in one list and tags each title with [Title.language], so each source here
 * filters the shared catalogue down to its own — the split is real, not cosmetic: a title
 * exists separately per language with its own id, chapters and covers.
 *
 * Page images are XOR-encrypted with a per-page key. The key rides to the image proxy on the
 * page's own headers (`X-Nyora-Image-Key`), which the proxy strips before fetching and then
 * applies to the bytes — see NyoraRestServer.decodeXorImage.
 *
 * One caveat that is NOT a bug in this code: `jumpg-assets3` refuses the signed page-image
 * URLs with a bare nginx 400, while the API and the (equally signed) cover URLs on
 * `jumpg-assets` answer normally. Everything client-side has been ruled out — a real Chrome
 * on the same connection is refused identically, as are: every Referer variant including the
 * viewer page, Origin, the same SESSION-TOKEN that minted the url, browser header sets,
 * HTTP/1.1 vs h2, HEAD and Range, IPv4-only and IPv6-only for both the mint and the fetch,
 * and every title tried. No Set-Cookie is involved. The url is transmitted byte-identically
 * to what the API returned.
 *
 * So the rejection is server-side and specific to the chapter-page edge. Getting these bytes
 * needs a different egress — the helper's residential-proxy or device-relay paths — or the
 * signature scheme changing again. Please do not re-debug it as a parser bug.
 */
class MangaPlusExtensionService(
    source: NyoraMangaSource,
    private val networkConfig: HelperNetworkConfig,
) : MangaExtensionService {

    private val sourceName = source.id.removePrefix("parser:").ifBlank { source.name }

    /** The API's language code for this source, e.g. `MANGAPLUSPARSER_ES` -> 1 (Spanish). */
    private val languageId: Int = LANGUAGES[sourceName.substringAfterLast('_')] ?: LANGUAGE_ENGLISH

    override val domain: String = SITE_DOMAIN
    private val client: OkHttpClient
        get() = networkConfig.sharedHttpClient()

    override val supportsLatest: Boolean = true

    override fun getHeaders(): Map<String, String> = mapOf("Referer" to "https://$SITE_DOMAIN/")

    // -- browse ------------------------------------------------------------

    /**
     * `title_list/allV2` is the whole catalogue in one response — there is no paging and no
     * server-side search, which is what the official clients do too. It is cached briefly so
     * that browsing pages and searching do not re-download it each time.
     */
    private suspend fun catalogue(): List<Manga> {
        cached?.takeIf { System.currentTimeMillis() - it.first < CATALOGUE_TTL_MS }?.let { return it.second }
        val response = api("/title_list/allV2")
        val titles = response.message(FIELD_SUCCESS)
            ?.message(FIELD_ALL_TITLES)
            ?.messages(FIELD_ALL_TITLES_GROUP)
            .orEmpty()
            .flatMap { group -> group.messages(FIELD_GROUP_TITLES) }
            .filter { (it.int(TITLE_LANGUAGE) ?: LANGUAGE_ENGLISH) == languageId }
            .mapNotNull { it.toManga() }
        synchronized(this) { cached = System.currentTimeMillis() to titles }
        return titles
    }

    override suspend fun getPopular(page: Int): MangaSearchPage = pageOf(catalogue(), page)

    /** The catalogue is alphabetical; "latest" is the ranking endpoint's ordering. */
    override suspend fun getLatest(page: Int): MangaSearchPage {
        val ranked = runCatching {
            api("/title_list/rankingV2?type=hottest")
                .message(FIELD_SUCCESS)
                ?.message(FIELD_RANKING)
                ?.messages(FIELD_RANKING_GROUP)
                .orEmpty()
                .flatMap { it.messages(FIELD_GROUP_TITLES) }
                .filter { (it.int(TITLE_LANGUAGE) ?: LANGUAGE_ENGLISH) == languageId }
                .mapNotNull { it.toManga() }
        }.getOrDefault(emptyList())
        return pageOf(ranked.ifEmpty { catalogue() }, page)
    }

    override suspend fun search(query: String, page: Int, filters: List<SourceFilter>): MangaSearchPage {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return pageOf(catalogue(), page)
        val hits = catalogue().filter {
            it.title.lowercase().contains(needle) || it.authors.any { a -> a.lowercase().contains(needle) }
        }
        return pageOf(hits, page)
    }

    private fun pageOf(all: List<Manga>, page: Int): MangaSearchPage {
        val from = (page.coerceAtLeast(1) - 1) * PAGE_SIZE
        if (from >= all.size) return MangaSearchPage(emptyList(), hasNextPage = false)
        val slice = all.subList(from, minOf(from + PAGE_SIZE, all.size))
        return MangaSearchPage(entries = slice, hasNextPage = from + slice.size < all.size)
    }

    private fun ProtoMessage.toManga(): Manga? {
        val id = long(TITLE_ID) ?: return null
        val name = string(TITLE_NAME)?.takeIf { it.isNotBlank() } ?: return null
        return Manga(
            id = nyoraId("/titles/$id").toString(),
            title = name,
            url = "/titles/$id",
            publicUrl = "https://$SITE_DOMAIN/titles/$id",
            coverUrl = string(TITLE_PORTRAIT).orEmpty(),
            authors = listOfNotNull(string(TITLE_AUTHOR)?.takeIf { it.isNotBlank() }),
            source = MangaSourceRef.Parser(sourceName),
        )
    }

    // -- details -----------------------------------------------------------

    override suspend fun getDetails(url: String): MangaDetails {
        val titleId = url.trimEnd('/').substringAfterLast('/')
        val detail = api("/title_detailV3?title_id=$titleId")
            .message(FIELD_SUCCESS)
            ?.message(FIELD_TITLE_DETAIL)
            ?: error("MANGA Plus returned no detail for title $titleId")
        val title = detail.message(DETAIL_TITLE)

        val manga = Manga(
            id = nyoraId("/titles/$titleId").toString(),
            title = title?.string(TITLE_NAME).orEmpty(),
            url = "/titles/$titleId",
            publicUrl = "https://$SITE_DOMAIN/titles/$titleId",
            coverUrl = detail.string(DETAIL_COVER) ?: title?.string(TITLE_PORTRAIT).orEmpty(),
            authors = listOfNotNull(title?.string(TITLE_AUTHOR)?.takeIf { it.isNotBlank() }),
            description = detail.string(DETAIL_OVERVIEW).orEmpty(),
            source = MangaSourceRef.Parser(sourceName),
        )

        // Chapters arrive in groups (the site paginates them as "1-50", "51-100", …); the
        // groups are already in reading order, as are the chapters inside each.
        val chapters = detail.messages(DETAIL_CHAPTER_GROUPS)
            .flatMap { it.messages(GROUP_CHAPTERS) }
            .mapIndexedNotNull { index, chapter ->
                val chapterId = chapter.long(CHAPTER_ID) ?: return@mapIndexedNotNull null
                val name = chapter.string(CHAPTER_NAME).orEmpty()
                val subtitle = chapter.string(CHAPTER_SUBTITLE).orEmpty()
                MangaChapter(
                    id = nyoraId("/viewer/$chapterId").toString(),
                    title = listOf(name, subtitle).filter { it.isNotBlank() }.joinToString(": "),
                    number = index + 1f,
                    url = "/viewer/$chapterId",
                    uploadDate = (chapter.long(CHAPTER_START_AT) ?: 0L) * 1000L,
                    index = index,
                )
            }
        return MangaDetails(manga = manga, chapters = chapters)
    }

    // -- reader ------------------------------------------------------------

    override suspend fun getPageList(chapter: MangaChapter): List<MangaPage> {
        val chapterId = chapter.url.trimEnd('/').substringAfterLast('/')
        val viewer = api("/manga_viewer_v3?chapter_id=$chapterId&split=yes&img_quality=high")
            .message(FIELD_SUCCESS)
            ?.message(FIELD_VIEWER)
            ?: error("MANGA Plus returned no pages for chapter $chapterId")

        return viewer.messages(VIEWER_PAGES).mapNotNull { wrapper ->
            val page = wrapper.message(PAGE_IMAGE) ?: return@mapNotNull null
            val image = page.string(IMAGE_URL)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val key = page.string(IMAGE_KEY).orEmpty()
            MangaPage(
                url = image,
                // Carried through to the image proxy, which XORs the bytes back. Blank for
                // the pages MANGA Plus serves unencrypted.
                headers = if (key.isBlank()) emptyMap() else mapOf(IMAGE_KEY_HEADER to key),
            )
        }
    }

    // -- plumbing ----------------------------------------------------------

    private suspend fun api(path: String): ProtoMessage = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(API_URL + path)
            // Any UUID: the API only checks that a session id is present.
            .header("SESSION-TOKEN", UUID.randomUUID().toString())
            .header("Origin", "https://$SITE_DOMAIN")
            .header("Referer", "https://$SITE_DOMAIN/")
            .header("Accept", "*/*")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                error("MANGA Plus request failed with HTTP ${response.code}: $path")
            }
            ProtoMessage(response.body?.bytes() ?: ByteArray(0))
        }
    }

    /** Matches [KotatsuParserExtensionService.nyoraId] so ids stay stable across engines. */
    private fun nyoraId(url: String): Long {
        var h = 1125899906842597L
        for (c in sourceName + url) h = 31 * h + c.code
        return h
    }

    @Volatile
    private var cached: Pair<Long, List<Manga>>? = null

    private companion object {
        const val SITE_DOMAIN = "mangaplus.shueisha.co.jp"
        const val API_URL = "https://jumpg-webapi.tokyo-cdn.com/api"
        const val PAGE_SIZE = 40
        const val CATALOGUE_TTL_MS = 10 * 60 * 1000L

        /** Header name the image proxy reads the XOR key from. */
        const val IMAGE_KEY_HEADER = "X-Nyora-Image-Key"

        // Field numbers, read off live responses (see the class comment).
        const val FIELD_SUCCESS = 1           // Response.success
        const val FIELD_ALL_TITLES = 25       // SuccessResult.allTitlesViewV2
        const val FIELD_ALL_TITLES_GROUP = 1  // AllTitlesViewV2.groups
        const val FIELD_GROUP_TITLES = 2      // group.titles
        const val FIELD_RANKING = 6           // SuccessResult.titleRankingView
        const val FIELD_RANKING_GROUP = 1
        const val FIELD_TITLE_DETAIL = 8      // SuccessResult.titleDetailView
        const val FIELD_VIEWER = 10           // SuccessResult.mangaViewer

        const val TITLE_ID = 1
        const val TITLE_NAME = 2
        const val TITLE_AUTHOR = 3
        const val TITLE_PORTRAIT = 4
        const val TITLE_LANGUAGE = 7          // absent means English

        const val DETAIL_TITLE = 1
        const val DETAIL_COVER = 2
        const val DETAIL_OVERVIEW = 3
        const val DETAIL_CHAPTER_GROUPS = 28
        const val GROUP_CHAPTERS = 2

        const val CHAPTER_ID = 2
        const val CHAPTER_NAME = 3
        const val CHAPTER_SUBTITLE = 4
        const val CHAPTER_START_AT = 6

        const val VIEWER_PAGES = 1
        const val PAGE_IMAGE = 1
        const val IMAGE_URL = 1
        const val IMAGE_KEY = 5

        const val LANGUAGE_ENGLISH = 0

        /**
         * Suffix of the upstream source name -> the API's language id. The upstream enum
         * splits MANGA Plus per language and the API tags each title the same way, so this
         * is what makes `MANGAPLUSPARSER_ES` show Spanish titles and nothing else.
         */
        // Derived by decoding the live catalogue and matching titles to ids: Russian
        // resolved against "Чёрный клевер", Thai against "2.5 มิติ ริริสะ", Vietnamese
        // against "KAIJU NO.8 (Quái vật số 8)". Note 8 is unused and Vietnamese is 9.
        val LANGUAGES = mapOf(
            "EN" to 0,
            "ES" to 1,
            "FR" to 2,
            "ID" to 3,
            "PT" to 4,
            "PTBR" to 4,
            "RU" to 5,
            "TH" to 6,
            "DE" to 7,
            "VI" to 9,
        )
    }
}
