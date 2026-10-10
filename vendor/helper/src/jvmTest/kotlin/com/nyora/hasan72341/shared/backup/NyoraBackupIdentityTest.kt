package com.nyora.hasan72341.shared.backup

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class NyoraBackupIdentityTest {

    @Test
    fun `derives portable manga ids from literal canonical vectors`() {
        assertEquals(
            "c5ef7bb1a3fd99addd09ee105f6de9bc2a1e77285a27d2d906597a06ec76bf3a",
            NyoraBackupIdentity.mangaId("data:mangadex", "/manga/berserk"),
        )
        assertEquals(
            "b6d7f2efedd81cfcf60e21085d7dad6765d7f7d9ffdc6a7f9032e702d896274f",
            NyoraBackupIdentity.mangaId("data:mangadex", "abc-123"),
        )
    }

    @Test
    fun `derives portable chapter ids from literal canonical vectors`() {
        assertEquals(
            "776119ba1151ae2adc67bb076566ccda8cfd7ccce4679da45a50a4faf25960d8",
            NyoraBackupIdentity.chapterId(
                "3d62425a9e52ec5af145d5bd63dc316e7c83d2025b1036401a880f81a5a4a22d",
                "/chapter/1",
            ),
        )
        assertEquals(
            "2e38ef397818b36bd42cb545fe5c4a709a7c367b84a47c4dd461eaea59205628",
            NyoraBackupIdentity.chapterId(
                "c248b3455c0b2cb592187e6c9ed0fed19c20f00401445db9bcd552b799d69571",
                "chapter-42",
            ),
        )
    }

    @Test
    fun `rejects nonportable remote source identities`() {
        listOf("local", "unknown", "parser:MANGADEX", "MIHON_1", "mihon:123", "42", "data:").forEach {
            assertFailsWith<IllegalArgumentException> {
                NyoraBackupIdentity.requireRemoteSourceId(it)
            }
        }
    }
}
