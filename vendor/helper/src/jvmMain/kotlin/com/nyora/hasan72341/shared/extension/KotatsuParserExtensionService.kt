package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.ContentRating
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaPage
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.MangaState
import com.nyora.hasan72341.shared.model.MangaTag
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import com.nyora.hasan72341.shared.model.MangaSource as NyoraMangaSource
import org.koitharu.kotatsu.parsers.model.Manga as LibManga
import org.koitharu.kotatsu.parsers.model.MangaChapter as LibMangaChapter
import org.koitharu.kotatsu.parsers.model.MangaPage as LibMangaPage
import org.koitharu.kotatsu.parsers.model.MangaListFilter
import org.koitharu.kotatsu.parsers.model.MangaParserSource
import org.koitharu.kotatsu.parsers.model.SortOrder
import org.koitharu.kotatsu.parsers.util.toAbsoluteUrl

/**
 * MangaExtensionService backed by a native kotatsu-parsers-redo [org.koitharu.kotatsu.parsers.MangaParser].
 * The parser is resolved from the source id (`parser:<ENUM_NAME>`) against [MangaParserSource].
 */
class KotatsuParserExtensionService(
    source: NyoraMangaSource,
    networkConfig: HelperNetworkConfig,
) : MangaExtensionService {

    private val parserName = source.id.removePrefix("parser:").ifBlank { source.name }

    private val parserSource = MangaParserSource.entries.firstOrNull { it.name == parserName }
        ?: error("Unknown native parser source: $parserName")

    private val context = KotatsuLoaderContext(networkConfig)
    // Bind the parser so its own Interceptor (per-request headers like the *Lib
    // family's Site-Id/Authorization) is applied to the client it uses.
    private val parser = context.newParserInstance(parserSource).also { context.bindParser(it) }

    override val domain: String get() = parser.domain

    override val supportsLatest: Boolean
        get() = SortOrder.UPDATED in parser.availableSortOrders

    override fun getHeaders(): Map<String, String> =
        parser.getRequestHeaders().toMap()

    override suspend fun getPopular(page: Int): MangaSearchPage =
        toPage(parser.getList(offsetFor(page), pickOrder(SortOrder.POPULARITY), MangaListFilter.EMPTY))

    override suspend fun getLatest(page: Int): MangaSearchPage =
        toPage(parser.getList(offsetFor(page), pickOrder(SortOrder.UPDATED), MangaListFilter.EMPTY))

    override suspend fun search(query: String, page: Int, filters: List<SourceFilter>): MangaSearchPage =
        toPage(parser.getList(offsetFor(page), pickOrder(SortOrder.RELEVANCE), MangaListFilter(query = query)))

    override suspend fun getDetails(url: String): MangaDetails {
        val seed = LibManga(
            id = url.hashCode().toLong(),
            title = "",
            altTitles = emptySet(),
            url = url,
            publicUrl = publicUrlFor(url),
            rating = RATING_UNKNOWN,
            contentRating = null,
            coverUrl = null,
            tags = emptySet(),
            state = null,
            authors = emptySet(),
            source = parserSource,
        )
        val full = parser.getDetails(seed)
        val chapters = full.chapters.orEmpty().map { it.toNyora() }
        return MangaDetails(
            manga = full.toNyora().withMetadataFrom(url),
            chapters = chapters.ifEmpty { recoverChapters(url) },
        )
    }

    /**
     * Last-resort chapter list, read straight off the title page.
     *
     * When a site redesigns, its parser's chapter selectors stop matching and `getDetails`
     * returns a title with zero chapters — the manga is visible but unreadable. Manganato is
     * the current example: it dropped `ul.row-content-chapter` entirely and now renders
     * chapters as ordinary links.
     *
     * The one thing every such site still does is put each chapter at a url one segment
     * below the manga's own, so that is the only rule used here: same host, path starts with
     * the manga's path, exactly one segment deeper. That ignores the sidebar links to other
     * titles that a naive `a[href*=chapter]` would sweep up.
     *
     * Only runs when the parser found nothing, so a working source can never be affected.
     * It recovers urls, titles and ordering — not upload dates or scanlators, which are not
     * reliably derivable from a link.
     */
    private suspend fun recoverChapters(url: String): List<MangaChapter> {
        val pageUrl = publicUrlFor(url).ifBlank { return emptyList() }
        val document = runCatching { fetchDocument(pageUrl) }.getOrNull() ?: return emptyList()
        val base = pageUrl.toHttpUrlOrNull() ?: return emptyList()
        val basePath = base.encodedPath.trimEnd('/')

        val seen = LinkedHashMap<String, String>()
        for (anchor in document.select("a[href]")) {
            val href = anchor.absUrl("href").toHttpUrlOrNull() ?: continue
            if (href.host != base.host) continue
            val path = href.encodedPath.trimEnd('/')
            if (!path.startsWith("$basePath/")) continue
            if (path.removePrefix("$basePath/").contains('/')) continue
            seen.putIfAbsent(path, anchor.text().trim())
        }
        if (seen.size < MIN_RECOVERED_CHAPTERS) return emptyList()

        // Sites list newest first; Nyora numbers chapters ascending.
        return seen.entries
            .map { (path, text) -> path to text }
            .sortedBy { (path, _) -> chapterNumberOf(path) }
            .mapIndexed { index, (path, text) ->
                MangaChapter(
                    id = nyoraId(path).toString(),
                    title = text.ifBlank { path.substringAfterLast('/') },
                    number = index + 1f,
                    volume = 0,
                    url = path,
                    scanlator = null,
                    uploadDate = 0L,
                    branch = null,
                    index = index,
                )
            }
    }

    /** Trailing number of a chapter slug — `…/chapter-15.2` -> 15.2. Unparseable slugs sort last. */
    private fun chapterNumberOf(path: String): Float =
        CHAPTER_NUMBER.find(path.substringAfterLast('/'))?.value?.toFloatOrNull() ?: Float.MAX_VALUE

    /**
     * Fills in a title or cover the parser never set.
     *
     * kotatsu's `getDetails(manga)` takes the entry the user tapped in a list and returns
     * `manga.copy(...)`, so a parser only overwrites the fields its detail page adds. Many
     * families — zeistmanga, Madara and others — therefore never touch `title` or
     * `coverUrl`, because in the app those always arrived from the catalogue entry.
     *
     * Nyora's REST surface is addressed by url alone (`/manga/details?id=&url=`), so the
     * seed handed to the parser has no title to inherit and those sources came back with
     * an empty one — which reads exactly like a broken parser and made details unusable
     * for ~20 zeistmanga sources, while their tags, state and chapters parsed perfectly.
     *
     * Reading the page's own OpenGraph metadata fixes every such family at once. It costs
     * one request and only on the path where something is actually missing.
     */
    private suspend fun Manga.withMetadataFrom(url: String): Manga {
        if (title.isNotBlank() && coverUrl.isNotBlank()) return this
        val pageUrl = publicUrlFor(url).ifBlank { return this }
        val document = runCatching { fetchDocument(pageUrl) }.getOrNull() ?: return this
        return copy(
            title = title.ifBlank { document.metaTitle() },
            coverUrl = coverUrl.ifBlank {
                document.selectFirst("meta[property=og:image]")?.attr("content").orEmpty()
            },
        )
    }

    /**
     * The page url for a manga, or "" when the source's url is an opaque id.
     *
     * `/manga/details?url=` carries whatever the catalogue put in `Manga.url`, which is a
     * path for most sources but for some (the Webtoons family, ~10 sources) is a bare title
     * number like `8909`. Handing that to `toAbsoluteUrl` would happily produce
     * `https://webtoons.com/8909` — a well-formed url for a page that does not exist.
     *
     * Passing it on as `publicUrl` was worse still: `WebtoonsParser.getDetails` reads
     * `manga.publicUrl.ifBlank { <builds the real list url> }`, so a non-blank but bogus
     * value defeated the parser's own fallback and every title failed on
     * `Expected URL scheme 'http' or 'https' but no scheme was found for 8909`.
     *
     * Claim a public url only when the source url is genuinely one; otherwise leave it
     * blank and let the parser do what it already knows how to do.
     */
    private fun publicUrlFor(url: String): String = when {
        url.startsWith("http://") || url.startsWith("https://") -> url
        url.startsWith("/") -> url.toAbsoluteUrl(parser.domain)
        else -> ""
    }

    private suspend fun fetchDocument(absolute: String): Document = withContext(Dispatchers.IO) {
        // Deliberately NOT `getHeaders()`. A parser's request headers are tuned for the
        // requests it makes itself, and several families set an image-only Accept there
        // (MangaBox sends `image/webp,image/apng,image/*`). Sending that with a page
        // request still returns 200 but not the document the site serves a browser, so the
        // OpenGraph tags were missing and the backfill silently did nothing. The shared
        // client already applies browser defaults, which is what kotatsu's own webClient
        // relies on for page fetches.
        val request = Request.Builder()
            .url(absolute)
            .get()
            .build()
        context.httpClient.newCall(request).execute().use { response ->
            Jsoup.parse(response.body?.string().orEmpty(), absolute)
        }
    }

    override suspend fun getPageList(chapter: MangaChapter): List<MangaPage> {
        val libChapter = LibMangaChapter(
            id = chapter.id.toLongOrNull() ?: chapter.url.hashCode().toLong(),
            title = chapter.title.ifBlank { null },
            number = chapter.number,
            volume = chapter.volume,
            url = chapter.url,
            scanlator = chapter.scanlator,
            uploadDate = chapter.uploadDate,
            branch = chapter.branch,
            source = parserSource,
        )
        val pages = parser.getPages(libChapter)
        return coroutineScope {
            val gate = Semaphore(PAGE_RESOLVE_CONCURRENCY)
            pages.map { page ->
                async(Dispatchers.IO) { gate.withPermit { MangaPage(url = resolvePageUrl(page)) } }
            }.awaitAll()
        }
    }

    /**
     * The direct image URL for a page.
     *
     * kotatsu splits this in two: `MangaPage.url` is whatever identifies the page, and
     * `getPageUrl(page)` turns it into an image. For most sources they are the same thing
     * and the default implementation just absolutizes the url. But a family of sources —
     * MangaTown, HentaiFox and others — put the *viewer page* in `MangaPage.url` and
     * override `getPageUrl` to fetch it and pull the `<img>` out.
     *
     * We only called `getPageUrl` when the url was blank, so for those sources the reader
     * was handed `…/manga/tales_of_demons_and_gods/c001/` as an image and got a page of
     * HTML back. Resolve whenever the url does not already look like an image; for every
     * other source that call is the default no-op and costs nothing.
     *
     * The resolving sources need one request per page, so they run concurrently — a
     * 164-page chapter resolved serially would take minutes.
     */
    private suspend fun resolvePageUrl(page: LibMangaPage): String {
        val direct = page.url.takeIf { it.isNotBlank() && it.looksLikeImageUrl() }
        val resolved = direct ?: runCatching { parser.getPageUrl(page) }.getOrDefault(page.url)
        // Some parsers (e.g. MangaEclipse and other Madara sites) return a relative image
        // path like /wp-content/uploads/… — absolutize it so pages actually load.
        return resolved.toAbsoluteUrl(parser.domain)
    }

    private fun String.looksLikeImageUrl(): Boolean {
        val path = substringBefore('?').substringBefore('#').lowercase()
        return IMAGE_SUFFIXES.any { path.endsWith(it) }
    }

    /** og:title first, then the page heading, then <title> minus the site's own suffix. */
    private fun Document.metaTitle(): String {
        selectFirst("meta[property=og:title]")?.attr("content")?.trim()?.takeIf { it.isNotEmpty() }
            ?.let { return it }
        selectFirst("h1")?.text()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return title().substringBefore(" - ").substringBefore(" | ").trim()
    }

    private fun offsetFor(page: Int): Int = (page - 1).coerceAtLeast(0) * PAGE_STEP

    private fun pickOrder(preferred: SortOrder): SortOrder {
        val available = parser.availableSortOrders
        return if (preferred in available) preferred else available.firstOrNull() ?: preferred
    }

    private fun toPage(list: List<LibManga>): MangaSearchPage =
        MangaSearchPage(entries = list.map { it.toNyora() }, hasNextPage = list.isNotEmpty())

    /**
     * Cross-platform stable manga id — byte-identical to nyora-web's `nyoraId(sourceName, url)`
     * and to kotatsu's own `generateUid`: seed 1125899906842597, rolling `31*h + charCode` over
     * (`source.name` + `url`), 64-bit signed wraparound, decimal string. This value becomes the
     * `manga_id` sync foreign key on favourites/history/bookmarks, so it MUST match the web
     * exactly (which recomputes it uniformly for browse AND details) or a user's library won't
     * merge across web ↔ desktop. We recompute it here rather than trusting `LibManga.id`,
     * because the details path seeds `id = url.hashCode()` (a different, non-matching hash) and
     * some parsers pass a non-url string to `generateUid`.
     */
    private fun nyoraId(mangaUrl: String): Long {
        return legacyMangaId(parserSource.name, mangaUrl)
    }

    private fun LibManga.toNyora(): Manga = Manga(
        id = nyoraId(url).toString(),
        title = title,
        altTitles = altTitles.toList(),
        url = url,
        publicUrl = publicUrl,
        rating = rating,
        isNsfw = contentRating == org.koitharu.kotatsu.parsers.model.ContentRating.ADULT,
        contentRating = contentRating?.let { ContentRating.valueOf(it.name) },
        coverUrl = coverUrl.orEmpty(),
        largeCoverUrl = largeCoverUrl,
        state = state?.let { MangaState.valueOf(it.name) },
        authors = authors.toList(),
        source = MangaSourceRef.Parser(parserSource.name),
        description = description.orEmpty(),
        tags = tags.map { MangaTag(key = it.key, title = it.title) },
    )

    private fun LibMangaChapter.toNyora(): MangaChapter = MangaChapter(
        id = id.toString(),
        title = title.orEmpty(),
        number = number,
        volume = volume,
        url = url,
        scanlator = scanlator,
        uploadDate = uploadDate,
        branch = branch,
    )

    private companion object {
        const val PAGE_STEP = 20
        const val RATING_UNKNOWN = -1f
        // Sources that defer the image behind a viewer page need one request per page.
        const val PAGE_RESOLVE_CONCURRENCY = 8
        val IMAGE_SUFFIXES = listOf(".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".jfif")
        // Below this a "chapter list" is more likely to be navigation chrome: Manganato's
        // title page links only "Start Reading" and "Latest Chapter" under the manga path
        // and keeps the real list behind AJAX, and reporting those two as THE chapter list
        // is worse than reporting none.
        const val MIN_RECOVERED_CHAPTERS = 3
        val CHAPTER_NUMBER = Regex("""\d+(?:\.\d+)?$""")
    }
}
