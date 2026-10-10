package com.nyora.hasan72341.shared.extension

import app.nyora.core.model.*
import app.nyora.data.engine.*
import app.nyora.data.runtime.DefaultEngineContext
import kotlinx.coroutines.runBlocking
import kotlin.test.*

class AdvancedBrowseTest {
    private class Context(val json: Boolean = false) : EngineContext {
        val requests = mutableListOf<HttpRequest>()
        private val parser = DefaultEngineContext()
        override val prefs = object : SourcePrefs {
            override fun getString(key: String): String? = null
            override fun putString(key: String, value: String?) {}
        }
        override fun parseHtml(html: String, baseUrl: String): HtmlDocument = parser.parseHtml(html, baseUrl)
        override suspend fun solveAntiBot(kind: AntiBotKind, url: String) = emptyMap<String, String>()
        override suspend fun http(request: HttpRequest): HttpResponse {
            requests += request
            return HttpResponse(request.url, 200, if (json) "{\"data\":[]}" else "<html><body></body></html>", emptyMap())
        }
    }
    private fun source(config: EngineConfig = EngineConfig.Madara()) = SourceDef("test", "Test", "en", engine=EngineId.MADARA, domain="example.com", config=config)

    @Test fun madaraSendsSortAndGenreOnEveryPage() = runBlocking {
        val ctx=Context(); val engine=MadaraEngine(source(),ctx)
        val filter=MangaListFilter(sortOrder=SortOrder.ALPHABETICAL_DESC,tags=setOf(MangaTag("Adventure","123")))
        engine.search(0,null,filter);engine.search(1,null,filter)
        assertEquals(2,ctx.requests.size)
        for(request in ctx.requests) {
            assertEquals("post_title",request.form?.get("vars[orderby]"))
            assertEquals("desc",request.form?.get("vars[order]"))
            assertEquals("123",request.form?.get("vars[tax_query][0][terms][0]"))
        }
        assertNotEquals(ctx.requests[0].form?.get("page"),ctx.requests[1].form?.get("page"))
    }
    @Test fun mangaReaderUsesConfiguredChoicesAndRealSort() = runBlocking {
        val ctx=Context(); val engine=MangaReaderEngine(source(EngineConfig.MangaReader(availableStates=listOf("FINISHED"),availableContentTypes=emptyList())),ctx)
        assertEquals(listOf("FINISHED"),engine.advancedFilterOptions["State"])
        assertFalse("Type" in engine.advancedFilterOptions)
        assertTrue(engine.multiValueFilters.isEmpty())
        assertFalse("Locale" in engine.advancedFilterOptions)
        engine.search(1,null,MangaListFilter(sortOrder=SortOrder.ALPHABETICAL_DESC,states=setOf(MangaState.FINISHED)))
        assertTrue(ctx.requests.single().url.contains("order=titlereverse"),ctx.requests.single().url)
        assertTrue(ctx.requests.single().url.contains("page=2"))
    }
    @Test fun mangaDexSendsSortTagsLanguageAndStatusTogether() = runBlocking {
        val ctx=Context(true);val engine=MangaDexEngine(source(),ctx)
        assertEquals(setOf("State","Rating"),engine.multiValueFilters)
        engine.search(1,"hero",MangaListFilter(sortOrder=SortOrder.ALPHABETICAL_DESC,tags=setOf(MangaTag("Adventure","uuid-123")),states=setOf(MangaState.FINISHED,MangaState.ONGOING),locale=java.util.Locale.forLanguageTag("pt-BR")))
        val url=ctx.requests.single().url
        for (part in listOf("order[title]=desc","includedTags[]=uuid-123","availableTranslatedLanguage[]=pt-br","status[]=completed","status[]=ongoing","title=hero")) assertTrue(url.contains(part),url)
    }
    @Test fun weebCentralSendsOrderAndExcludedTag() = runBlocking {
        val ctx=Context();val engine=WeebCentralEngine(source(),ctx)
        engine.search(1,null,MangaListFilter(sortOrder=SortOrder.ALPHABETICAL_DESC,tagsExclude=setOf(MangaTag("Drama","Drama"))))
        val url=ctx.requests.single().url
        for(part in listOf("sort=Alphabet","order=Descending","excluded_tag=Drama","offset=32")) assertTrue(url.contains(part),url)
    }
}
