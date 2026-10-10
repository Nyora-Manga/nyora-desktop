package com.nyora.hasan72341.shared.sync

import kotlin.test.Test
import kotlin.test.assertEquals

class NyoraSyncSourceIdentityTest {
    @Test
    fun mixedCaseDataSourcesWriteLowercaseCanonicalWireIds() {
        assertEquals("data:mangafire_en", canonicalWireSourceId("data:MANGAFIRE_EN"))
        assertEquals("data:mangafire_en", canonicalWireSourceId("DD_MANGAFIRE_EN"))
    }


    @Test
    fun sourcePreferenceAliasesCollapseToTheCurrentDataRowRegardlessOfOrder() {
        val native = CanonicalSourcePreferenceCandidate(
            localSourceId = "MANGANELO_COM",
            isPinned = false,
            isEnabled = false,
        )
        val data = CanonicalSourcePreferenceCandidate(
            localSourceId = "data:manganelo",
            isPinned = true,
            isEnabled = true,
        )

        val forward = canonicalSourcePreferences(listOf(native, data))
        val reversed = canonicalSourcePreferences(listOf(data, native))

        assertEquals(forward, reversed)
        assertEquals(1, forward.size)
        assertEquals("data:manganelo", forward.single().wireSourceId)
        assertEquals("data:manganelo", forward.single().localSourceId)
        assertEquals(true, forward.single().isPinned)
        assertEquals(true, forward.single().isEnabled)
    }

    @Test
    fun pulledSourcePreferenceAliasesUseUpdatedAtLwwRegardlessOfBackendOrder() {
        val newerLegacy = PulledSourcePreferenceCandidate(
            remoteSourceId = "MANGANELO_COM",
            isPinned = false,
            isEnabled = false,
            updatedAt = 200,
        )
        val olderCanonical = PulledSourcePreferenceCandidate(
            remoteSourceId = "data:manganelo",
            isPinned = true,
            isEnabled = true,
            updatedAt = 100,
        )

        val forward = newestCanonicalSourcePreferences(listOf(olderCanonical, newerLegacy))
        val reversed = newestCanonicalSourcePreferences(listOf(newerLegacy, olderCanonical))

        assertEquals(forward, reversed)
        assertEquals(newerLegacy, forward.single())
        assertEquals("data:manganelo", forward.single().wireSourceId)

        val canonicalTie = olderCanonical.copy(updatedAt = 200)
        assertEquals(
            canonicalTie,
            newestCanonicalSourcePreferences(listOf(newerLegacy, canonicalTie)).single(),
        )
        assertEquals(
            canonicalTie,
            newestCanonicalSourcePreferences(listOf(canonicalTie, newerLegacy)).single(),
        )
    }

    @Test
    fun androidPrivateAndNestedSourceRefsUseCanonicalDataWireIds() {
        assertEquals("data:manganelo", canonicalWireSourceId("DD_manganelo"))
        assertEquals("data:manganelo", canonicalWireSourceId("JS_data:manganelo"))
        assertEquals(
            "data:asurascans",
            canonicalWireSourceId("{\"name\":\"{\\\"name\\\":\\\"DD_asurascans\\\"}\"}"),
        )
        assertEquals("data:asurascans", canonicalWireSourceId("DD_ASURASCANS_US"))
        assertEquals("data:asurascans", canonicalWireSourceId("data:ASURASCANS_US"))
        assertEquals("data:asurascans", canonicalWireSourceId("ASURASCANS_US"))
        assertEquals("data:asurascans", canonicalWireSourceId("JS_ASURASCANS_US"))
        assertEquals("data:mangasusuku", canonicalWireSourceId("DD_komikindo-info"))
        assertEquals("data:mangasusuku", canonicalWireSourceId("data:komikindo-info"))
    }

    @Test
    fun retiredParserAliasesResolveToCurrentDataSources() {
        assertEquals("data:manganelo", canonicalWireSourceId("MANGANELO_COM"))
        assertEquals("data:webtoons", canonicalWireSourceId("parser:WEBTOONS"))
        assertEquals("data:webtoons", canonicalWireSourceId("WEBTOONS_EN"))
    }

    @Test
    fun wireIdsReturnToTheCorrectDesktopNamespace() {
        assertEquals("data:manganelo", localSourceIdFromWire("DD_manganelo"))
        assertEquals("data:manganelo", localSourceIdFromWire("data:manganelo"))
        assertEquals("parser:UNKNOWN_LEGACY", localSourceIdFromWire("UNKNOWN_LEGACY"))
    }

    @Test
    fun mangaSourceRefsUseTheSameCanonicalWireNamespace() {
        assertEquals(
            "{\"name\":\"data:manganelo\"}",
            canonicalWireSourceRef(com.nyora.hasan72341.shared.model.MangaSourceRef.Parser("MANGANELO_COM")),
        )
        assertEquals(
            "{\"name\":\"data:asurascans\"}",
            canonicalWireSourceRef(com.nyora.hasan72341.shared.model.MangaSourceRef.Script("JS_ASURASCANS_US")),
        )
        assertEquals(
            "{\"name\":\"data:mangasusuku\"}",
            canonicalWireSourceRef(com.nyora.hasan72341.shared.model.MangaSourceRef.Script("data:komikindo-info")),
        )
    }

    @Test
    fun aliasWinnerUsesTheNewestEffectiveUpdateOrTombstoneDeterministically() {
        val canonical = CanonicalAliasCandidate(
            remoteId = "canonical",
            canonicalId = "canonical",
            updatedAt = 300,
            deletedAt = 0,
        )
        val newerAliasTombstone = CanonicalAliasCandidate(
            remoteId = "legacy",
            canonicalId = "canonical",
            updatedAt = 100,
            deletedAt = 400,
        )

        assertEquals(newerAliasTombstone, newestCanonicalAlias(listOf(canonical, newerAliasTombstone)))
        assertEquals(newerAliasTombstone, newestCanonicalAlias(listOf(newerAliasTombstone, canonical)))
        assertEquals(
            canonical.copy(updatedAt = 400),
            newestCanonicalAlias(
                listOf(
                    canonical.copy(updatedAt = 400),
                    newerAliasTombstone.copy(updatedAt = 400, deletedAt = 0),
                ),
            ),
        )
    }
}
