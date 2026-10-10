package com.nyora.hasan72341.shared.data

import com.nyora.hasan72341.shared.model.MangaRepo
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.SourceEngine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object SourceCatalogParser {
    private val json = Json { ignoreUnknownKeys = true }

    fun parseIndex(repo: MangaRepo, body: String): List<MangaSource> {
        val root = json.parseToJsonElement(body).jsonArray
        return root.flatMap { element -> parseEntry(repo, element.jsonObject) }
            .filter { it.name.isNotBlank() && it.lang.isNotBlank() }
            .distinctBy { it.id }
            .sortedWith(compareBy<MangaSource> { it.lang }.thenBy { it.name.lowercase() })
    }

    private fun parseEntry(repo: MangaRepo, entry: JsonObject): List<MangaSource> {
        // Mihon-style index entries (objects with a "sources" array) require a
        // Dalvik-compatible runtime to execute their APKs. The desktop JVM
        // can't run them, so we deliberately skip these entirely rather than
        // surfacing dead sources the user can never open. Direct script-style
        // entries (no "sources" array) still flow through parseDirectEntry.
        if (entry["sources"] is JsonArray) return emptyList()
        return parseDirectEntry(entry)
    }

    private fun parseDirectEntry(entry: JsonObject): List<MangaSource> {
        val id = entry.string("id")
        val name = entry.string("name")
        val site = entry.string("site").ifBlank { entry.string("baseUrl") }
        val url = entry.string("url")
        if (id.isBlank() || name.isBlank()) return emptyList()
        return listOf(
            MangaSource(
                id = "script:${stableHash("$name:${entry.string("lang")}:$site")}",
                name = name,
                lang = convertLanguage(entry.string("lang")),
                baseUrl = site,
                sourceCodeUrl = url,
                iconUrl = entry.string("iconUrl"),
                version = entry.string("version").ifBlank { "0.0.1" },
                canUninstall = true,
                engine = SourceEngine.JavaScript,
                notes = "Script source. Manga parser runtime is JS-only on macOS.",
            ),
        )
    }

    private fun JsonObject.string(name: String): String =
        this[name]?.jsonPrimitive?.content.orEmpty()

    private fun JsonObject.int(name: String): Int =
        this[name]?.jsonPrimitive?.intOrNull ?: 0

    private fun JsonObject.long(name: String): Long =
        this[name]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L

    private fun JsonObject.boolean(name: String): Boolean =
        this[name]?.jsonPrimitive?.booleanOrNull ?: false

    private fun convertLanguage(value: String): String = when (value) {
        "English" -> "en"
        "Français" -> "fr"
        "Bahasa Indonesia" -> "id"
        "日本語" -> "ja"
        "Português" -> "pt"
        "Русский" -> "ru"
        "Español" -> "es"
        "ไทย" -> "th"
        "Türkçe" -> "tr"
        "Tiếng Việt" -> "vi"
        else -> value.ifBlank { "all" }
    }
}

internal fun stableHash(value: String): String {
    var h1 = 0x811c9dc5u.toInt()
    var h2 = 0x1000193u.toInt()
    for (i in value.indices) {
        val c = value[i].code
        h1 = (h1 xor c) * 0x01000193
        h2 = (h2 + c) * 0x01000193 xor (h2 ushr 13)
    }
    return (h1.toUInt().toString(16).padStart(8, '0') +
        h2.toUInt().toString(16).padStart(8, '0')).take(16)
}
