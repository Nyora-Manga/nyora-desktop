package com.nyora.hasan72341.shared.util

internal const val LONG_HASH_SEED = 1125899906842597L

fun generateNyoraId(sourceName: String, url: String): Long {
    var h = LONG_HASH_SEED
    for (i in 0 until sourceName.length) {
        h = 31 * h + sourceName[i].code
    }
    for (i in 0 until url.length) {
        h = 31 * h + url[i].code
    }
    return h
}
