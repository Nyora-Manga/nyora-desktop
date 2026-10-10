package app.nyora.data.engine

import app.nyora.core.model.MangaListFilter
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class CerberusSourceConfigTest {
    @Test
    fun otherWordpressSourcesKeepTheDefaultRootSearchRoute() = runBlocking {
        val context = RecordingEngineContext()
        MangaReaderEngine(testSource(id = "stock", engine = EngineId.MANGAREADER,
            config = EngineConfig.MangaReader()), context).search(1, "red fox", MangaListFilter.EMPTY)
        assertEquals("https://example.com/page/2/?s=red+fox", context.requests.single().url)
    }

    @Test
    fun currentWordpressCatalogueAndReaderKeepTheExistingSourceIdentity() = runBlocking {
        val context = RecordingEngineContext { request ->
            val html = when (request.url) {
                "https://legionscans.com/wp/manga" -> "<div></div>"
                "https://legionscans.com/wp/manga/?order=popular&page=1" -> """
                    <div class="postbody"><div class="listupd"><div class="bs"><div class="bsx">
                      <a href="/wp/manga/example/"><img class="ts-post-image" src="/cover.jpg"><div class="tt">Example</div></a>
                    </div></div></div></div>
                """
                "https://legionscans.com/wp/manga/example/" -> """
                    <h1 class="entry-title">Example</h1>
                    <div id="chapterlist"><ul><li data-num="1"><a href="/wp/2024/03/12/01/">
                      <span class="chapternum">Chapter 1</span>
                    </a></li></ul></div>
                """
                "https://legionscans.com/wp/2024/03/12/01/" -> """
                    <script>ts_reader.run({"sources":[{"images":["https://i1.wp.com/imagizer.imageshack.com/v2/xq70/922/example.png"]}]});</script>
                """
                else -> error("Unexpected source route: ${request.url}")
            }
            HttpResponse(request.url, 200, html, emptyMap())
        }
        val source = productionSource("heancmsalt", "LEGIONSCANS")
        assertEquals(EngineId.MANGAREADER, source.engine)
        val engine = MangaReaderEngine(source, context)
        val manga = engine.getPopular(0).single()
        val chapter = engine.getDetails(manga).chapters!!.single()
        assertEquals("LEGIONSCANS:/wp/manga/example/", manga.id)
        assertEquals("/wp/2024/03/12/01/", chapter.url)
        assertEquals("https://i1.wp.com/imagizer.imageshack.com/v2/xq70/922/example.png", engine.getPageList(chapter).single().url)
    }

    @Test
    fun searchStaysUnderTheSitesWordpressInstallation() = runBlocking {
        val context = RecordingEngineContext()
        MangaReaderEngine(productionSource("heancmsalt", "LEGIONSCANS"), context)
            .search(1, "red fox", MangaListFilter.EMPTY)
        assertEquals("https://legionscans.com/wp/page/2/?s=red+fox", context.requests.single().url)
    }
}
