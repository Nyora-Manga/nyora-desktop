package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.MangaSourceRefCodec

/**
 * Stable manga identity used by the legacy Kotatsu bridge and cross-platform sync.
 *
 * Kotlin [Long] arithmetic intentionally supplies the required signed 64-bit wraparound.
 */
internal fun legacyMangaId(sourceName: String, mangaUrl: String): Long {
    var hash = 1125899906842597L
    for (char in sourceName + canonicalLegacyMangaUrl(sourceName, mangaUrl)) {
        hash = 31 * hash + char.code
    }
    return hash
}

internal fun canonicalLegacyMangaUrl(sourceName: String, mangaUrl: String): String {
    val legacyName = legacyParserSourceName(sourceName)
    if (legacyName == "ASURASCANS_US") {
        return mangaUrl.replaceFirst(
            Regex("^https?://(?:www\\.)?asurascans\\.com(?=/|$)", RegexOption.IGNORE_CASE),
            "",
        )
    }
    if (legacyName != "WEBTOONS_EN") return mangaUrl
    val titleNo = Regex("(?:[?&]title_no=)([^&#]+)", RegexOption.IGNORE_CASE)
        .find(mangaUrl)
        ?.groupValues
        ?.get(1)
    return titleNo ?: mangaUrl
}

/**
 * Parser identity historically used to derive manga ids for a data/native route.
 *
 * Most catalogue ids differ from their retired parser enum only by case. The MangaNato
 * family has one intentional rename (`manganelo` -> `MANGANELO_COM`), so keep that bridge
 * explicit rather than deriving ids from a platform-specific `data:`/`DD_` wrapper.
 */
internal fun legacyParserSourceName(sourceIdentity: String): String {
    val bare = sourceIdentity
        .removePrefix("JS_")
        .removePrefix("DD_")
        .removePrefix("data:")
        .removePrefix("parser:")
        .removePrefix("script:")
    return when (bare.lowercase()) {
        "manganato" -> "MANGANATO"
        "manganelo" -> "MANGANELO_COM"
        "mangakakalot" -> "MANGAKAKALOT"
        "mangakakalottv" -> "MANGAKAKALOTTV"
        // Catalogue ids were made delimiter-consistent after these parser enums shipped.
        // The historical spellings are part of the persisted manga-id contract.
        "mangafire_es_la" -> "MANGAFIRE_ESLA"
        "mangafire_pt_br" -> "MANGAFIRE_PTBR"
        "maid-id" -> "MAID_ID"
        "shiro-doujin" -> "SHIRO_DOUJIN"
        // The broken KomikIndo.info row moved to the live same-domain MangaSusuku definition.
        // Keep the retired parser enum as its manga-hash and history lookup identity.
        "komikindo-info", "mangasusuku" -> "KOMIKINDO_INFO"
        "mangabat" -> "HMANGABAT"
        "asurascans" -> "ASURASCANS_US"
        "webtoons" -> "WEBTOONS_EN"
        else -> bare.uppercase()
    }
}

/** Current catalogue id for a retired data row whose site has a verified live successor. */
internal fun canonicalDataSourceId(sourceId: String): String = when (sourceId.lowercase()) {
    "asurascans_us" -> "asurascans"
    "komikindo-info" -> "mangasusuku"
    else -> sourceId.lowercase(java.util.Locale.ROOT)
}

/** Resolve a retired parser/data wrapper to the live source id exposed by this catalogue. */
internal fun currentDataSourceIdForLegacyParser(value: String): String? {
    var parserName = value.trim()
    repeat(4) {
        val unwrapped = parserName
            .removePrefix("parser:")
            .removePrefix("script:")
            .removePrefix("JS_")
            .removePrefix("DD_")
            .removePrefix("data:")
        if (unwrapped == parserName) return@repeat
        parserName = unwrapped
    }
    if (parserName.isBlank()) return null
    val canonicalLegacyName = legacyParserSourceName(parserName)
    return DataDrivenCatalog.load()
        .firstOrNull { entry ->
            legacyParserSourceName(entry.definition.id) == canonicalLegacyName
        }
        ?.source
        ?.id
}

/**
 * Return the source ref a current client can open while leaving the manga id untouched.
 *
 * This is deliberately separate from [mangaIdRemapSourceName]: a generic `JS_*` row already has
 * a stable legacy id, but its retired source name still needs a live `data:*` route in API/sync
 * responses. Persisted parser rows are rewritten by the SQL migration using the same resolver.
 */
internal fun canonicalOpenableMangaSourceRef(sourceRef: MangaSourceRef): MangaSourceRef {
    val normalized = normalizedMangaSourceRef(MangaSourceRefCodec.encode(sourceRef))
    val sourceIdentity = when (normalized) {
        is MangaSourceRef.Parser -> normalized.name
        is MangaSourceRef.Script -> normalized.name
        MangaSourceRef.Local,
        MangaSourceRef.Unknown -> return normalized
    }
    val currentId = currentDataSourceIdForLegacyParser(sourceIdentity) ?: return normalized
    return MangaSourceRef.Script(currentId)
}

/** Unwrap old cross-client source_ref shapes, including Android's short-lived double JSON. */
internal fun normalizedMangaSourceRef(encodedRef: String): MangaSourceRef {
    var decoded = MangaSourceRefCodec.decode(encodedRef)
    repeat(4) {
        val nested = decoded.name.trim().substringAfterLast(".MangaSourceRef.")
        if (!nested.startsWith("{")) return@repeat
        val next = MangaSourceRefCodec.decode(nested)
        if (next == decoded) return@repeat
        decoded = next
    }
    val name = decoded.name.trim().substringAfterLast(".MangaSourceRef.")
    return when {
        name.startsWith("DD_") -> MangaSourceRef.Script(
            "data:${canonicalDataSourceId(name.removePrefix("DD_"))}",
        )
        name.startsWith("JS_data:") -> MangaSourceRef.Script(
            "data:${canonicalDataSourceId(name.removePrefix("JS_data:"))}",
        )
        name.startsWith("data:") -> MangaSourceRef.Script(
            "data:${canonicalDataSourceId(name.removePrefix("data:"))}",
        )
        else -> decoded
    }
}

internal fun legacyMangaSourceName(sourceRef: MangaSourceRef): String? = when (sourceRef) {
    is MangaSourceRef.Parser -> legacyParserSourceName(sourceRef.name)
    is MangaSourceRef.Script -> sourceRef.name
        .takeIf { it.startsWith("data:") }
        ?.let(::legacyParserSourceName)
    MangaSourceRef.Local,
    MangaSourceRef.Unknown -> null
}

/**
 * Source identities whose manga ids genuinely need rewriting/canonicalising.
 *
 * Generic JS parser rows already use the legacy hash (and may store an absolute URL alongside an
 * id derived from the relative URL), so only the native routes that historically emitted raw ids
 * are admitted here.
 */
internal fun mangaIdRemapSourceName(sourceRef: MangaSourceRef): String? {
    legacyMangaSourceName(sourceRef)?.let { return it }
    val scriptName = (sourceRef as? MangaSourceRef.Script)?.name ?: return null
    if (!scriptName.startsWith("JS_")) return null
    val parserName = scriptName.removePrefix("JS_")
    return legacyParserSourceName(parserName).takeIf {
        it.startsWith("MANGAFIRE_") || it == "TOONILY_ME"
    }
}
