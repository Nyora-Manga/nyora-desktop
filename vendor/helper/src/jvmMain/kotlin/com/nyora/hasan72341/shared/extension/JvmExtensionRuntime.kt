package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import java.util.concurrent.ConcurrentHashMap

class JvmExtensionRuntime @JvmOverloads constructor(
    private val networkConfig: HelperNetworkConfig = HelperNetworkConfig(),
    private val dataDrivenFactory: (MangaSource, DataDrivenSource) -> MangaExtensionService =
        { source, entry -> DataDrivenExtensionService(source, entry, networkConfig) },
) : MangaExtensionRuntime {

    private val nativeFactory: (MangaSource) -> MangaExtensionService =
        { source ->
            // MangaFire relaunched on a new JSON API (/api/titles); the bundled
            // kotatsu-parsers-redo MangaFire (old /filter HTML + vrf + scrambling)
            // now returns 0 results, so serve it from a native app-layer service.
            // Every MANGAFIRE_* language source (parser:MANGAFIRE_EN/ES/…) routes here.
            // MangaNelo.com and Mangakakalot.tv are the same deployment as the two above and
            // were falling through to the bundled Mangabox parser, which the rewritten site no
            // longer matches (empty browse, zero chapters).
            when {
                source.id.startsWith("parser:MANGAFIRE") -> MangaFireExtensionService(source, networkConfig)
                // Toonily.me → toondex.io: rebuilt on the MangaBuddy JSON API (api.toondex.io);
                // the kotatsu Madtheme parser no longer matches. Serve natively.
                source.id == "parser:TOONILY_ME" -> ToonDexExtensionService(source, networkConfig)
                // Manganato and Mangakakalot run the same rewritten stack: the catalogue moved
                // to /manga-list, chapters left the page for a /api/manga/<slug>/chapters JSON
                // endpoint, and images need a site Referer. The bundled Mangabox parser matches
                // none of that, so both are served natively.
                source.id in NatoExtensionService.SOURCE_IDS -> NatoExtensionService(source, networkConfig)
                // MANGA Plus dropped the API's JSON mode, so the bundled parser's every
                // request 403s. Served natively over the protobuf API the site's own client
                // uses; one instance per language source (MANGAPLUSPARSER_EN/_ES/…).
                source.id.startsWith("parser:MANGAPLUSPARSER") ->
                    MangaPlusExtensionService(source, networkConfig)
                else -> KotatsuParserExtensionService(source, networkConfig = networkConfig)
            }
        }

    private val delegate = CommonMangaExtensionRuntime(
        // Native kotatsu-parsers-redo engine. Both the canonical "Parser" engine and any
        // legacy "JavaScript"-tagged rows (from before the native migration) route here —
        // seedBuiltInSources re-stamps them to Parser on launch.
        jsFactory = nativeFactory,
        parserFactory = nativeFactory,
    )

    // Cache parser-backed services per source. Each one instantiates a native parser
    // (and its OkHttp/loader context), so rebuilding it on every REST request
    // (browse/details/pages are separate calls) would be wasteful. Caching also lets
    // any per-parser state (resolved/overridden domain) persist across calls.
    private val parserServiceCache = ConcurrentHashMap<String, MangaExtensionService>()
    private val dataDrivenServiceCache = ConcurrentHashMap<String, MangaExtensionService>()
    private val dataDrivenCacheLock = Any()
    @Volatile
    private var dataDrivenCatalogueRevision = -1L

    override fun create(source: MangaSource): MangaExtensionService =
        when (source.engine) {
            SourceEngine.JavaScript -> createDataDriven(source)
            SourceEngine.Parser -> parserServiceCache.getOrPut(source.id) { delegate.create(source) }
            else -> delegate.create(source)
        }

    private fun createDataDriven(source: MangaSource): MangaExtensionService {
        return DataDrivenCatalog.withSnapshot { catalogue ->
            synchronized(dataDrivenCacheLock) {
                if (dataDrivenCatalogueRevision != catalogue.revision) {
                    dataDrivenServiceCache.clear()
                    dataDrivenCatalogueRevision = catalogue.revision
                }
                dataDrivenServiceCache.getOrPut(source.id) {
                    val entry = catalogue.entries.firstOrNull { it.source.id == source.id }
                    if (entry == null) {
                        UnsupportedExtensionService(
                            source,
                            "The bundled data-driven catalogue does not contain this source.",
                        )
                    } else {
                        val currentSource = entry.source
                        when {
                            entry.engineKey == "mangafire" ->
                                MangaFireExtensionService(currentSource, networkConfig)
                            currentSource.id in setOf("data:toonily_me", "data:beehentai") ->
                                ToonDexExtensionService(currentSource, networkConfig)
                            currentSource.id in NatoExtensionService.DATA_DRIVEN_SOURCE_IDS ->
                                NatoExtensionService(currentSource, networkConfig)
                            else -> dataDrivenFactory(currentSource, entry)
                        }
                    }
                }
            }
        }
    }
}
