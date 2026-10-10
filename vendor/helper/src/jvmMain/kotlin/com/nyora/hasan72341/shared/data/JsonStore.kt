package com.nyora.hasan72341.shared.data

import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.model.Library
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText

class JsonStore(
    private val file: Path = defaultStorePath(),
) {
    init { HelperProfile.confine(file) }

    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        encodeDefaults = true
    }

    fun load(): Library {
        HelperProfile.confine(file)
        if (!file.exists()) return Library()
        return json.decodeFromString(Library.serializer(), file.readText())
    }

    fun save(library: Library) {
        HelperProfile.confine(file)
        file.parent.createDirectories()
        file.writeText(json.encodeToString(Library.serializer(), library))
    }

    companion object {
        fun defaultStorePath(): Path {
            HelperProfile.isolatedPath("library.json")?.let { return it }
            val home = Path.of(System.getProperty("user.home"))
            val base = home.resolve("Library").resolve("Application Support").resolve("Nyora")
            Files.createDirectories(base)
            return base.resolve("library.json")
        }
    }
}
