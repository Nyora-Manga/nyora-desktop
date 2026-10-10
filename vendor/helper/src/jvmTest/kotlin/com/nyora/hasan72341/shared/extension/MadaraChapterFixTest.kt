package com.nyora.hasan72341.shared.extension

import okhttp3.FormBody
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MadaraChapterFixTest {

    @Test
    fun readsTheChaptersHolderId() {
        val html = """
            <div class="c-page"></div>
            <div id="manga-chapters-holder" data-id="47353"><i class="fas fa-spinner"></i></div>
        """.trimIndent()

        assertEquals("47353", extractMangaId(html))
    }

    @Test
    fun readsTheChaptersHolderIdRegardlessOfAttributeOrderOrQuoting() {
        val html = """<div data-id='1534' class="x" id='manga-chapters-holder'></div>"""

        assertEquals("1534", extractMangaId(html))
    }

    @Test
    fun returnsNoIdWhenTheHolderIsAbsent() {
        assertNull(extractMangaId("<html><body><h1>Way To Heaven</h1></body></html>"))
        assertNull(extractMangaId("""<div id="manga-chapters-holder"></div>"""))
    }

    @Test
    fun readsTheMangaIdOffTheChapterForm() {
        val form = FormBody.Builder()
            .addEncoded("action", "manga_get_chapters")
            .addEncoded("manga", "47353")
            .build()

        assertEquals("47353", mangaIdOf(form))
    }

    @Test
    fun ignoresFormsThatAreNotChapterRequests() {
        assertNull(mangaIdOf(null))
        assertNull(
            mangaIdOf(
                FormBody.Builder()
                    .addEncoded("action", "madara_load_more")
                    .addEncoded("manga", "47353")
                    .build(),
            ),
        )
        assertNull(mangaIdOf(FormBody.Builder().addEncoded("action", "manga_get_chapters").build()))
    }
}
