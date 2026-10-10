package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.SourceEngine

/** Source reference stamped on results produced by a native service that fronts multiple engines. */
internal fun MangaSource.nativeResultSourceRef(): MangaSourceRef = when {
    id.startsWith("data:") -> MangaSourceRef.Script(id)
    id.startsWith("parser:") -> MangaSourceRef.Parser(id.removePrefix("parser:"))
    engine == SourceEngine.JavaScript -> MangaSourceRef.Script(id)
    else -> MangaSourceRef.Parser(name)
}
