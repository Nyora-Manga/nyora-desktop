package com.nyora.hasan72341.shared.data

import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.RemoteUrlKind
import com.nyora.hasan72341.shared.net.fetchText
import com.nyora.hasan72341.shared.net.rewriteRemoteUrl
import com.nyora.hasan72341.shared.model.MangaRepo
import com.nyora.hasan72341.shared.model.MangaSource

class SourceCatalogClient(
    private val networkConfig: HelperNetworkConfig = HelperNetworkConfig(),
) {
    fun fetch(repo: MangaRepo): List<MangaSource> {
        val settings = networkConfig.snapshot()
        val body = fetchText(rewriteRemoteUrl(repo.indexUrl, settings, RemoteUrlKind.General), settings)
        return SourceCatalogParser.parseIndex(repo, body)
    }
}
