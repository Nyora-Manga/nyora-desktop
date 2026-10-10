package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ToonTopServiceTest {
    @Test
    fun chapterPagesComeFromThePublicReaderDocumentWithoutAHomepageBuildId() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val html = """<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialChapter":{"images":["https://images.example/1.jpg","https://images.example/2.jpg"]}}}}</script>"""
            repeat(2) { server.enqueue(MockResponse.Builder().body(html).build()) }
            val service = service(server)
            val pages = service.getPageList(MangaChapter(id = "chapter-1", title = "Chapter 1", url = "book/chapter-1"))
            assertEquals(listOf("https://images.example/1.jpg", "https://images.example/2.jpg"), pages.map { it.url })
            assertEquals("/book/chapter-1", server.takeRequest().url.encodedPath)
            assertEquals(1, server.requestCount)
            assertEquals(service.getHeaders(), pages.first().headers)
        }
    }

    @Test
    fun rebrandedSourceKeepsItsOwnReferenceAndAdultFlagInResults() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("""{"data":{"items":[{"id":"book-1","url":"/book","name":"Test Book"}],"pagination":{"has_next":false}}}""").build())
            val manga = service(server).getPopular(1).entries.single()
            assertEquals(MangaSourceRef.Script("data:beehentai"), manga.source)
            assertTrue(manga.isNsfw)
        }
    }

    private fun service(server: MockWebServer): ToonDexExtensionService {
        val url = server.url("/").toString().trimEnd('/')
        return ToonDexExtensionService(
            MangaSource(id = "data:beehentai", name = "ToonTop", lang = "en", baseUrl = url, isNsfw = true),
            HelperNetworkConfig(), { OkHttpClient() }, url, url,
        )
    }
}
