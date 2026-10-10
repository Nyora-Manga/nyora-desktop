package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.SourceGates
import com.nyora.hasan72341.shared.SourcePatches
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.SourceContentType
import com.nyora.hasan72341.shared.model.SourceEngine
import org.koitharu.kotatsu.parsers.model.ContentType
import org.koitharu.kotatsu.parsers.model.MangaParserSource

/**
 * The desktop source catalog, derived directly from the native kotatsu-parsers-redo
 * [MangaParserSource] enum (minus entries flagged broken). Every source is
 * [SourceEngine.Parser] with id `parser:<ENUM_NAME>` and ships not-installed so the
 * user opts in. Single source of truth for both the REST `/sources/catalog` and the
 * launch-time seeding in HelperMain.
 */
internal fun nativeParserCatalog(): List<MangaSource> =
    MangaParserSource.entries
        .filterNot { it.isBroken && it.name !in SourceGates.REVIVED_SOURCES }
        .map { src ->
            MangaSource(
                id = "parser:${src.name}",
                name = SourcePatches.TITLE_OVERRIDES[src.name] ?: src.title,
                lang = src.locale.ifBlank { "all" },
                baseUrl = "",
                isInstalled = false,
                isNsfw = src.contentType == ContentType.HENTAI,
                engine = SourceEngine.Parser,
                contentType = mapParserContentType(src.contentType),
                notes = "Native Kotatsu parser.",
                localPath = "",
                canUninstall = false,
                installedAt = 0L,
            )
        }

internal fun mapParserContentType(type: ContentType): SourceContentType = when (type) {
    ContentType.MANGA -> SourceContentType.Manga
    ContentType.MANHWA -> SourceContentType.Manhwa
    ContentType.MANHUA -> SourceContentType.Manhua
    ContentType.HENTAI -> SourceContentType.Hentai
    ContentType.COMICS -> SourceContentType.Comics
    ContentType.NOVEL -> SourceContentType.Novel
    ContentType.ONE_SHOT -> SourceContentType.OneShot
    ContentType.DOUJINSHI -> SourceContentType.Doujinshi
    ContentType.IMAGE_SET -> SourceContentType.ImageSet
    ContentType.ARTIST_CG -> SourceContentType.ArtistCg
    ContentType.GAME_CG -> SourceContentType.GameCg
    ContentType.OTHER -> SourceContentType.Other
}
