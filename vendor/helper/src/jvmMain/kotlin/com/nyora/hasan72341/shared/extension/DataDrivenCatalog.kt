package com.nyora.hasan72341.shared.extension

import app.nyora.data.engine.ContentType
import app.nyora.data.engine.EngineConfig
import app.nyora.data.engine.EngineId
import app.nyora.data.engine.EngineRegistry
import app.nyora.data.engine.FilterCapabilities
import app.nyora.data.engine.SourceDef
import app.nyora.data.engine.StaticTag
import app.nyora.core.model.SortOrder
import com.nyora.hasan72341.shared.SourcePatches
import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.SourceContentType
import com.nyora.hasan72341.shared.model.SourceEngine
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

data class DataDrivenSource(
    val source: MangaSource,
    val definition: SourceDef,
    val engineKey: String,
) {
    val antiBot: String?
        get() = definition.rawConfig["antiBot"] as? String
    val cfWall: String?
        get() = definition.rawConfig["cfWall"] as? String
    val needsCustomLogic: Boolean
        get() = definition.rawConfig["needsCustomLogic"] as? Boolean ?: false
    val isSolverlessCompatible: Boolean
        get() = !cfWall.equals("B", ignoreCase = true)
    /** Explicit source formats; an empty list means unknown, not a guessed adult format. */
    val supportedFormats: List<String>
        get() {
            val known = setOf("MANGA", "MANHWA", "MANHUA", "COMICS", "NOVEL", "ONE_SHOT", "DOUJINSHI", "IMAGE_SET")
            val declared = (definition.rawConfig["availableContentTypes"] as? List<*>)
                .orEmpty().filterIsInstance<String>().map { it.uppercase(Locale.ROOT) }
                .filter { it in known }.distinct()
            if (declared.isNotEmpty()) return declared
            return listOf(definition.contentType.name).filter { it in known }
        }
}

/** Reads and refreshes the data-driven catalogue. */
object DataDrivenCatalog {
    private val NATIVE_BACKED_ENGINES = setOf("mangafire")

    internal data class Snapshot(
        val entries: List<DataDrivenSource>,
        val revision: Long,
        /** Stable across restarts for byte-identical catalogue content. */
        val fingerprint: String,
    )

    @Volatile
    private var state = loadBundled()

    fun load(): List<DataDrivenSource> = synchronized(this) { state.entries }

    /** Public/thin clients have no trusted browser solver, so Wall-B rows stay local-only. */
    fun loadForSolverlessClient(): List<DataDrivenSource> = synchronized(this) {
        state.entries.filter(DataDrivenSource::isSolverlessCompatible)
    }

    fun find(id: String): DataDrivenSource? = synchronized(this) {
        state.entries.firstOrNull { it.source.id == id }
    }

    internal fun snapshot(): Snapshot = synchronized(this) { state }

    internal fun <T> withSnapshot(block: (Snapshot) -> T): T =
        synchronized(this) { block(state) }

    /** Keep provisional catalogue state private until its repository and disk writes succeed. */
    internal fun <T> withExclusiveApply(block: () -> T): T =
        synchronized(this) { block() }

    /** Validate an epoch and perform its persistence/cache write under the replace monitor. */
    internal fun commitIfRevision(revision: Long, commit: () -> Unit): Boolean =
        synchronized(this) {
            if (state.revision != revision) return@synchronized false
            commit()
            true
        }

    internal fun restore(snapshot: Snapshot) {
        synchronized(this) {
            state = Snapshot(snapshot.entries, state.revision + 1, snapshot.fingerprint)
        }
    }

    /**
     * Validates [remoteJson] using the same parser as the bundled catalogue, then atomically
     * swaps in its supported entries. The existing catalogue remains available on any failure.
     */
    fun replace(remoteJson: String): List<DataDrivenSource> {
        val parsed = parseCatalog(remoteJson)
        require(parsed.isNotEmpty()) { "DataDriven catalogue contains no supported sources" }
        synchronized(this) {
            state = Snapshot(parsed, state.revision + 1, effectiveCatalogueFingerprint(parsed))
        }
        return parsed
    }

    private fun loadBundled(): Snapshot {
        val resource = requireNotNull(DataDrivenCatalog::class.java.classLoader
            .getResourceAsStream("nyora/catalogue.json")) {
            "Bundled data-driven catalogue is missing"
        }
        resource.bufferedReader().use { reader ->
            val json = reader.readText()
            val entries = parseCatalog(json)
            return Snapshot(entries, revision = 0, fingerprint = effectiveCatalogueFingerprint(entries))
        }
    }

    internal fun parseCatalog(json: String, isolated: Boolean = HelperProfile.isolated, environment: Map<String, String> = System.getenv()): List<DataDrivenSource> {
        val nativeBrowserConfigured = NativeBrowserSourcePolicy.configured(isolated, environment)
        return try {
            val rows = JSONObject(json).optJSONArray("sources")
                ?: throw IllegalArgumentException("DataDriven catalogue must contain a sources array")
            buildList {
                val sourceIds = HashSet<String>()
                for (index in 0 until rows.length()) {
                    val row = rows.getJSONObject(index)
                    val engineKey = row.optString("engine")
                    val rowId = row.getString("id")
                    require(rowId.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]*"))) {
                        "Invalid data-driven source id"
                    }
                    require(sourceIds.add(rowId.lowercase(Locale.ROOT))) {
                        "Duplicate data-driven source id"
                    }
                    val domainOverride = SourcePatches.DOMAIN_OVERRIDES.dataDrivenPatchValue(rowId)
                    val titleOverride = SourcePatches.TITLE_OVERRIDES.dataDrivenPatchValue(rowId)
                    // Canonical health patches always win. Only the audited challenge-only
                    // native exceptions below may bypass an otherwise broken catalogue row.
                    // Patch aliases never rewrite the stable catalogue/source id.
                    val canonicalDead = SourcePatches.DEAD_SOURCES.hasDataDrivenPatch(rowId)
                    // A retired identity must not re-enter the active catalogue when an
                    // upstream health flag changes. Keep its existing migration target
                    // authoritative without rewriting manga or chapter identifiers.
                    val isRetired = canonicalDataSourceId(rowId) != rowId.lowercase(Locale.ROOT)
                    val engineSupported = EngineRegistry.supports(engineKey) || engineKey in NATIVE_BACKED_ENGINES
                    val challengeOnly = NativeBrowserSourcePolicy.permitsBrokenSource(
                        rowId, engineKey, domainOverride ?: row.optString("domain"),
                        if (row.isNull("brokenReason")) null else row.optString("brokenReason"),
                        nativeBrowserConfigured, canonicalDead, isRetired, engineSupported,
                        row.optBoolean("needsCustomLogic", false),
                    )
                    val isDead = canonicalDead || (row.optBoolean("broken", false) && !challengeOnly)
                    if (!isDead && !isRetired && engineSupported) {
                        add(
                            row.toDataDrivenSource(
                                engineKey = engineKey,
                                domainOverride = domainOverride,
                                titleOverride = titleOverride,
                            ),
                        )
                    }
                }
            }
        } catch (error: IllegalArgumentException) {
            throw error
        } catch (error: Exception) {
            throw IllegalArgumentException("Invalid DataDriven catalogue", error)
        }
    }
}

/** Hash the normalized, patched definitions that actually drive requests and cache contents. */
internal fun effectiveCatalogueFingerprint(entries: List<DataDrivenSource>): String {
    fun field(value: Any?): String {
        val text = when (value) {
            null -> "null"
            is Map<*, *> -> value.entries
                .sortedBy { it.key.toString() }
                .joinToString(prefix = "{", postfix = "}") { (key, item) ->
                    field(key.toString()) + field(item)
                }
            is Iterable<*> -> value.joinToString(prefix = "[", postfix = "]") { field(it) }
            is Array<*> -> value.joinToString(prefix = "[", postfix = "]") { field(it) }
            else -> value.toString()
        }
        return "${text.length}:$text"
    }

    val normalized = entries.sortedBy { it.source.id }.joinToString(separator = "\u001e") { entry ->
        listOf(
            entry.engineKey,
            entry.source.id,
            entry.source.name,
            entry.source.lang,
            entry.source.baseUrl,
            entry.source.engine.name,
            entry.source.contentType.name,
            entry.source.isNsfw,
            entry.definition.id,
            entry.definition.name,
            entry.definition.lang,
            entry.definition.nsfw,
            entry.definition.contentType.name,
            entry.definition.engine.key,
            entry.definition.domain,
            entry.definition.config,
            entry.definition.rawConfig,
        ).joinToString(separator = "") { field(it) }
    }
    return MessageDigest.getInstance("SHA-256")
        .digest(normalized.toByteArray(StandardCharsets.UTF_8))
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}

private fun JSONObject.toDataDrivenSource(
    engineKey: String,
    domainOverride: String?,
    titleOverride: String?,
): DataDrivenSource {
    val runtimeMetadata = buildMap<String, Any?> {
        listOf("antiBot", "cfWall", "needsCustomLogic").forEach { key ->
            if (this@toDataDrivenSource.has(key)) {
                put(key, unwrap(this@toDataDrivenSource.get(key)))
            }
        }
    }
    val rawConfig = (optJSONObject("config") ?: JSONObject()).toRawMap() +
        (optJSONObject("configComplex") ?: JSONObject()).toRawMap() +
        runtimeMetadata
    val domain = domainOverride ?: getString("domain")
    val definition = SourceDef(
        id = getString("id"),
        name = titleOverride ?: optString("name", getString("id")),
        lang = optString("lang", "en"),
        nsfw = optBoolean("nsfw", false),
        contentType = parseDataContentType(optString("contentType", "MANGA")),
        engine = if (engineKey == EngineId.MANGAREADER.key) EngineId.MANGAREADER else EngineId.MADARA,
        domain = domain,
        config = typedConfig(engineKey, optJSONObject("config") ?: JSONObject(), this, domain),
        rawConfig = rawConfig,
    )
    return DataDrivenSource(
        source = MangaSource(
            id = "data:${definition.id.lowercase(Locale.ROOT)}",
            name = definition.name,
            lang = definition.lang,
            baseUrl = "https://${definition.domain}",
            isInstalled = true,
            isNsfw = definition.nsfw,
            engine = SourceEngine.JavaScript,
            contentType = parseSharedContentType(optString("contentType", "MANGA")),
            canUninstall = false,
        ),
        definition = definition,
        engineKey = engineKey,
    )
}

private fun typedConfig(
    engineKey: String,
    config: JSONObject,
    row: JSONObject,
    domain: String,
): EngineConfig = when (engineKey) {
    EngineId.MANGAREADER.key -> mangaReaderConfig(config, domain)
    else -> madaraConfig(config, row)
}

private fun madaraConfig(config: JSONObject, row: JSONObject): EngineConfig.Madara {
    val base = EngineConfig.Madara()
    val selectors = config.optJSONObject("selectors")
    val images = config.optJSONObject("images")
    return base.copy(
        pageSize = config.optInt("pageSize", row.optInt("pageSize", base.pageSize)),
        locale = config.optString("locale", null) ?: base.locale,
        datePattern = config.optString("datePattern", base.datePattern),
        tagPrefix = config.optString("tagPrefix", base.tagPrefix),
        listUrl = config.optString("listUrl", base.listUrl),
        withoutAjax = config.optBoolean("withoutAjax", base.withoutAjax),
        postReq = config.optBoolean("postReq", base.postReq),
        postDataReq = config.optString("postDataReq", base.postDataReq),
        stylePage = config.optString("stylePage", base.stylePage),
        authorSearchSupported = config.optBoolean("authorSearchSupported", base.authorSearchSupported),
        sortOrders = config.optEnumList<SortOrder>("sortOrders") ?: base.sortOrders,
        capabilities = config.optCapabilities(base.capabilities),
        selectors = base.selectors.copy(
            chapter = selectors.stringOrNull("chapter") ?: config.stringOrNull("selectChapter"),
            page = selectors.stringOrNull("page") ?: config.stringOrNull("selectPage"),
            bodyPage = selectors.stringOrNull("bodyPage") ?: config.stringOrNull("selectBodyPage"),
            desc = selectors.stringOrNull("desc") ?: config.stringOrNull("selectDesc"),
            genre = selectors.stringOrNull("genre") ?: config.stringOrNull("selectGenre"),
            date = selectors.stringOrNull("date") ?: config.stringOrNull("selectDate"),
            state = selectors.stringOrNull("state") ?: config.stringOrNull("selectState"),
            alt = selectors.stringOrNull("alt") ?: config.stringOrNull("selectAlt"),
            testAsync = selectors.stringOrNull("testAsync") ?: config.stringOrNull("selectTestAsync"),
        ),
        images = base.images.copy(
            stripStyleParam = images?.optBoolean("stripStyleParam", base.images.stripStyleParam)
                ?: base.images.stripStyleParam,
            imgAttrCandidates = images?.optStringList("imgAttrCandidates")
                ?: base.images.imgAttrCandidates,
            pageImgSelector = images.stringOrNull("pageImgSelector"),
        ),
        staticTags = config.optJSONArray("staticTags")?.let { tags ->
            buildList {
                for (index in 0 until tags.length()) {
                    val tag = tags.optJSONObject(index) ?: continue
                    val key = tag.stringOrNull("key") ?: continue
                    add(StaticTag(key = key, title = tag.stringOrNull("title") ?: key))
                }
            }
        } ?: base.staticTags,
        extraStatusMap = config.optStringMap("extraStatusMap") ?: base.extraStatusMap,
        forwardCloudflareCookies = config.optBoolean("forwardCloudflareCookies", base.forwardCloudflareCookies),
    )
}

private fun mangaReaderConfig(config: JSONObject, domain: String): EngineConfig.MangaReader {
    val base = EngineConfig.MangaReader()
    val selectors = config.optJSONObject("selectors")?.let {
        EngineConfig.MangaReader.Selectors(
            mangaList = it.optString("mangaList", null) ?: base.selectors.mangaList,
            mangaListImg = it.optString("mangaListImg", null) ?: base.selectors.mangaListImg,
            mangaListTitle = it.optString("mangaListTitle", null) ?: base.selectors.mangaListTitle,
            chapter = it.optString("chapter", null) ?: base.selectors.chapter,
            description = it.optString("description", null) ?: base.selectors.description,
            page = it.optString("page", null) ?: base.selectors.page,
            script = it.optString("script", null) ?: base.selectors.script,
            testScript = it.optString("testScript", null) ?: base.selectors.testScript,
        )
    } ?: base.selectors
    return base.copy(
        domains = (listOf(domain) + config.optStringList("domains").orEmpty()).distinct(),
        pageSize = config.optInt("pageSize", base.pageSize),
        searchPageSize = config.optInt("searchPageSize", base.searchPageSize),
        listUrl = config.optString("listUrl", base.listUrl),
        datePattern = config.optString("datePattern", base.datePattern),
        locale = config.optString("locale", null) ?: base.locale,
        userAgent = config.optString("userAgent", null) ?: base.userAgent,
        defaultSortOrder = config.optEnum<SortOrder>("defaultSortOrder") ?: base.defaultSortOrder,
        sortOrders = config.optEnumList<SortOrder>("sortOrders") ?: base.sortOrders,
        capabilities = config.optCapabilities(base.capabilities),
        availableStates = config.optStringList("availableStates") ?: base.availableStates,
        availableContentTypes = config.optStringList("availableContentTypes") ?: base.availableContentTypes,
        selectors = selectors,
        encodedSrc = config.optBoolean("encodedSrc", base.encodedSrc),
        netshield = config.optBoolean("netshield", base.netshield),
        cloudflare = config.optBoolean("cloudflare", base.cloudflare),
        statusOverrides = config.optStringMap("statusOverrides") ?: base.statusOverrides,
        relativeDateWords = config.optStringMap("relativeDateWords") ?: base.relativeDateWords,
    )
}

private fun parseDataContentType(value: String): ContentType =
    runCatching { ContentType.valueOf(value.uppercase()) }.getOrDefault(ContentType.MANGA)

private fun parseSharedContentType(value: String): SourceContentType = when (value.uppercase()) {
    "ONE_SHOT" -> SourceContentType.OneShot
    "DOUJINSHI" -> SourceContentType.Doujinshi
    "IMAGE_SET" -> SourceContentType.ImageSet
    else -> runCatching {
        SourceContentType.valueOf(value.lowercase().replaceFirstChar(Char::uppercase))
    }.getOrDefault(SourceContentType.Manga)
}

private fun JSONObject.toRawMap(): Map<String, Any?> = buildMap {
    this@toRawMap.keys().forEach { key -> put(key, unwrap(this@toRawMap.get(key))) }
}

private fun JSONArray.toRawList(): List<Any?> = List(length()) { index -> unwrap(get(index)) }

private fun unwrap(value: Any?): Any? = when (value) {
    is JSONObject -> value.toRawMap()
    is JSONArray -> value.toRawList()
    JSONObject.NULL -> null
    else -> value
}

private fun String.removePrefix(prefix: String, ignoreCase: Boolean): String =
    if (startsWith(prefix, ignoreCase = ignoreCase)) substring(prefix.length) else this

private fun String.normalizedDataDrivenPatchId(): String =
    removePrefix("DD_", ignoreCase = true)

private fun <T> Map<String, T>.dataDrivenPatchValue(rowId: String): T? {
    val normalizedRowId = rowId.normalizedDataDrivenPatchId()
    val dataSpecificKey = "DD_$normalizedRowId"
    return entries.firstOrNull { (key, _) -> key.equals(dataSpecificKey, ignoreCase = true) }?.value
        ?: entries.firstOrNull { (key, _) ->
            key.normalizedDataDrivenPatchId().equals(normalizedRowId, ignoreCase = true)
        }?.value
}

private fun Set<String>.hasDataDrivenPatch(rowId: String): Boolean {
    val normalizedRowId = rowId.normalizedDataDrivenPatchId()
    return any { patchId ->
        patchId.normalizedDataDrivenPatchId().equals(normalizedRowId, ignoreCase = true)
    }
}

private fun JSONObject?.stringOrNull(name: String): String? =
    this?.optString(name, null)?.takeIf { it.isNotBlank() }

private fun JSONObject.optStringList(name: String): List<String>? =
    optJSONArray(name)?.let { array ->
        buildList {
            for (index in 0 until array.length()) {
                array.optString(index, null)?.takeIf { it.isNotBlank() }?.let(::add)
            }
        }
    }

private fun JSONObject.optStringMap(name: String): Map<String, String>? =
    optJSONObject(name)?.let { value ->
        buildMap {
            value.keys().forEach { key ->
                value.optString(key, null)?.let { put(key, it) }
            }
        }
    }

private inline fun <reified T : Enum<T>> JSONObject.optEnum(name: String): T? =
    stringOrNull(name)?.let { value ->
        enumValues<T>().firstOrNull { it.name.equals(value, ignoreCase = true) }
    }

private inline fun <reified T : Enum<T>> JSONObject.optEnumList(name: String): List<T>? =
    optStringList(name)?.mapNotNull { value ->
        enumValues<T>().firstOrNull { it.name.equals(value, ignoreCase = true) }
    }

private fun JSONObject.optCapabilities(base: FilterCapabilities): FilterCapabilities {
    val value = optJSONObject("capabilities") ?: return base
    return base.copy(
        multipleTags = value.optBoolean("multipleTags", base.multipleTags),
        tagsExclusion = value.optBoolean("tagsExclusion", base.tagsExclusion),
        search = value.optBoolean("search", base.search),
        searchWithFilters = value.optBoolean("searchWithFilters", base.searchWithFilters),
        year = value.optBoolean("year", base.year),
        authorSearch = value.optBoolean("authorSearch", base.authorSearch),
    )
}
