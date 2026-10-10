package app.nyora.data.engine

import app.nyora.core.model.ContentRating
import app.nyora.core.model.Manga
import kotlinx.coroutines.runBlocking
import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KomikLokalRecoveryTest {
    @Test
    fun currentListingCardsYieldMangaAndPathPaginationYieldsDifferentItems() = runBlocking {
        val context = RecordingEngineContext { request ->
            val html = when (URI(request.url).path) {
                "/komik-dewasa/" -> card("First", "first")
                "/komik-dewasa/page/2/" -> card("Second", "second")
                else -> "<div class=\"postbody\"><p>No matching catalogue</p></div>"
            }
            HttpResponse(request.url, 200, html, emptyMap())
        }
        val engine = MangaReaderEngine(productionSource("mangareader", "komiklokal"), context)

        val first = engine.getPopular(0)
        val second = engine.getPopular(1)

        assertEquals(listOf("First"), first.map { it.title })
        assertEquals(listOf("Second"), second.map { it.title })
        assertEquals("/komik/first/", first.single().url)
        assertEquals("https://komikmu.top/cover-first.jpg", first.single().coverUrl)
        assertEquals(listOf(
            "https://komikmu.top/komik-dewasa/?order=popular",
            "https://komikmu.top/komik-dewasa/page/2/?order=popular",
        ), context.requests.map { it.url })
    }

    @Test
    fun currentListingSelectorAlsoPreservesSearchCards() = runBlocking {
        val context = RecordingEngineContext { request ->
            HttpResponse(request.url, 200, """
                <div class="postbody"><div class="listupd"><div class="bs"><div class="bsx">
                  <a href="/komik/search-result/"><img class="ts-post-image" src="/cover.jpg"><div class="tt">Search Result</div></a>
                </div></div></div></div>
            """.trimIndent(), emptyMap())
        }
        val engine = MangaReaderEngine(productionSource("mangareader", "komiklokal"), context)

        assertEquals(listOf("Search Result"), engine.search(0, "result", app.nyora.core.model.MangaListFilter.EMPTY).map { it.title })
    }

    @Test
    fun currentAdultCatalogueResultsAreNotClassifiedAsSafe() = runBlocking {
        val context = RecordingEngineContext { request ->
            HttpResponse(request.url, 200, card("First", "first"), emptyMap())
        }
        val source = productionSource("mangareader", "komiklokal")
        val result = MangaReaderEngine(source, context).getPopular(0)

        assertEquals("komiklokal", source.id)
        assertEquals(listOf(ContentRating.ADULT), result.map { it.contentRating })
        assertTrue(result.single().isNsfw)
    }

    @Test
    fun currentChapterAttributesPreserveDecimalNumbers() = runBlocking {
        val context = RecordingEngineContext { request ->
            HttpResponse(request.url, 200, """
                <h1>Example</h1><div id="chapterlist"><ul class="clstyle">
                  <li data-num="42.5"><div class="chbox"><a href="/example-chapter-42-5/">
                    <span class="chapternum">Chapter 42.5</span><span class="chapterdate">04/10/2026</span>
                  </a></div></li>
                </ul></div>
            """.trimIndent(), emptyMap())
        }
        val details = MangaReaderEngine(productionSource("mangareader", "komiklokal"), context)
            .getDetails(Manga(id = "existing-id", url = "/komik/example/", title = "Example"))

        assertEquals("existing-id", details.id)
        assertEquals(42.5f, details.chapters!!.single().number)
        assertEquals("/example-chapter-42-5/", details.chapters!!.single().url)
    }

    @Test
    fun currentSlashDatesProduceUploadDates() = runBlocking {
        val context = RecordingEngineContext { request ->
            HttpResponse(request.url, 200, """
                <h1>Example</h1><div id="chapterlist"><ul><li data-num="1">
                  <a href="/example-chapter-1/"><span class="chapternum">Chapter 1</span><span class="chapterdate">04/10/2026</span></a>
                </li></ul></div>
            """.trimIndent(), emptyMap())
        }
        val details = MangaReaderEngine(productionSource("mangareader", "komiklokal"), context)
            .getDetails(Manga(id = "example", url = "/komik/example/", title = "Example"))

        assertTrue(details.chapters!!.single().uploadDate > 0L)
    }

    // Sanitized markup retains the live listing structure without real titles/images.
    private fun card(title: String, key: String) = """
        <div class="postbody"><div class="listupd cp stsven"><div class="utao styletwo stylegg"><div class="uta">
          <div class="imgu"><a class="series" href="/komik/$key/" title="$title"><img class="ts-post-image" src="/cover-$key.jpg"></a></div>
          <div class="luf"><a class="series" href="/komik/$key/"><h4>$title</h4></a>
            <ul><li><a href="/$key-chapter-1/">Chapter 1</a></li></ul></div>
        </div></div></div></div>
    """.trimIndent()
}
