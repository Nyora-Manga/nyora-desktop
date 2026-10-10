package app.nyora.data.engine

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class Manga18EngineTest {

    @Test
    fun ordinaryBrowseUsesTheConfiguredListPathAndRequestedPage() = runBlocking {
        val context = RecordingContext()
        val engine = Manga18Engine(source(), context)

        engine.getPopular(page = 1)

        assertEquals(
            "https://example.com/directory/2?order_by=views",
            context.lastRequest?.url,
        )
    }

    private fun source() = SourceDef(
        id = "test-manga18",
        name = "Test Manga18",
        lang = "en",
        engine = EngineId.MADARA,
        domain = "example.com",
        config = EngineConfig.Madara(),
        rawConfig = mapOf("listUrl" to "directory/"),
    )

    private class RecordingContext : EngineContext {
        var lastRequest: HttpRequest? = null

        override val prefs: SourcePrefs = object : SourcePrefs {
            override fun getString(key: String): String? = null
            override fun putString(key: String, value: String?) = Unit
        }

        override suspend fun http(request: HttpRequest): HttpResponse {
            lastRequest = request
            return HttpResponse(
                url = request.url,
                code = 200,
                body = "<html><body></body></html>",
                headers = emptyMap(),
            )
        }

        override fun parseHtml(html: String, baseUrl: String): HtmlDocument = object : HtmlDocument {}

        override suspend fun solveAntiBot(kind: AntiBotKind, url: String): Map<String, String> = emptyMap()
    }
}
