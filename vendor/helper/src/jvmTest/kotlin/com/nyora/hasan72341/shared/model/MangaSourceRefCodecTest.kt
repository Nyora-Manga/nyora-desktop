package com.nyora.hasan72341.shared.model

import kotlin.test.Test
import kotlin.test.assertEquals

class MangaSourceRefCodecTest {

    @Test
    fun serializedDataDrivenSourceNameDecodesAsScript() {
        val decoded = MangaSourceRefCodec.decode("""{"name":"data:porncomic18"}""")

        assertEquals(MangaSourceRef.Script("data:porncomic18"), decoded)
    }
}
