package com.nyora.hasan72341.shared.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

object MangaSourceRefCodec {
    private val json = Json { ignoreUnknownKeys = true }

    fun encode(source: MangaSourceRef): String {
        return buildJsonObject {
            put("name", source.name)
        }.toString()
    }

    fun decode(raw: String?): MangaSourceRef {
        val text = raw?.trim().orEmpty()
        if (text.isBlank()) return MangaSourceRef.Unknown

        val parsedName = runCatching {
            val obj = json.parseToJsonElement(text).let {
                it as? kotlinx.serialization.json.JsonObject
            }
            obj?.get("name")?.jsonPrimitive?.contentOrNull
                ?: obj?.get("type")?.jsonPrimitive?.contentOrNull
        }.getOrNull()

        return decodeName(parsedName ?: text)
    }

    fun decodeName(name: String): MangaSourceRef {
        val value = name.trim()
        return when {
            value.isBlank() -> MangaSourceRef.Unknown
            value == MangaSourceRef.Local.name || value.endsWith(".MangaSourceRef.Local") -> MangaSourceRef.Local
            value == MangaSourceRef.Unknown.name || value.endsWith(".MangaSourceRef.Unknown") -> MangaSourceRef.Unknown
            value.startsWith("MIHON_") || value.startsWith("mihon:") -> MangaSourceRef.Unknown
            value.startsWith("JS_") || value.startsWith("data:") -> MangaSourceRef.Script(value)
            else -> MangaSourceRef.Parser(value)
        }
    }
}
