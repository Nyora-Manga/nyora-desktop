package com.nyora.hasan72341.shared.extension

import app.nyora.data.engine.EngineContext
import app.nyora.data.engine.HitomiEngine
import app.nyora.data.runtime.DefaultEngineContext
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.NYORA_BROWSER_UA
import kotlinx.coroutines.runBlocking

/** Re-resolves recognized rotating source URLs at image-load time, including already-open readers. */
class RotatingSourceImageResolver internal constructor(
    private val requireSourceContext: Boolean = false,
    private val contextFactory: (DataDrivenSource) -> EngineContext,
) {
    constructor(networkConfig: HelperNetworkConfig) : this(networkConfig.usesDesktopRelay, { entry ->
        DefaultEngineContext(
            userAgent = NYORA_BROWSER_UA,
            clientProvider = { networkConfig.sourceHttpClient(entry.source.id, blockPrivateHosts = true) },
            effectiveDomain = { entry.definition.domain },
        )
    })

    @Volatile private var cached: CachedEngine? = null

    /** Unrelated URLs pass through without creating a context or issuing a network request. */
    fun resolve(url: String, sourceId: String? = null): String {
        if (requireSourceContext && sourceId != "data:hitomi") return url
        val snapshot = DataDrivenCatalog.snapshot()
        val entry = snapshot.entries.firstOrNull { it.source.id == "data:hitomi" && it.engineKey == "hitomi" }
            ?: return url
        val cdnDomain = entry.definition.rawConfig["cdnDomain"] as? String ?: return url
        if (!HitomiEngine.matchesResolvedImageUrl(url, cdnDomain)) return url
        val engine = engine(snapshot.fingerprint, entry)
        // Neither the catalogue monitor nor our engine-cache monitor is held during network I/O.
        // HitomiEngine owns the short-lived routing cache and serializes its refresh with a mutex.
        return runBlocking { engine.refreshResolvedImageUrl(url) }
    }

    private fun engine(fingerprint: String, entry: DataDrivenSource): HitomiEngine {
        cached?.takeIf { it.fingerprint == fingerprint }?.let { return it.engine }
        return synchronized(this) {
            cached?.takeIf { it.fingerprint == fingerprint }?.engine
                ?: HitomiEngine(entry.definition, contextFactory(entry)).also { engine ->
                    cached = CachedEngine(fingerprint, engine)
                }
        }
    }

    private data class CachedEngine(val fingerprint: String, val engine: HitomiEngine)
}
