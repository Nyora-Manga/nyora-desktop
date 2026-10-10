package com.nyora.hasan72341.shared.reader

import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.net.RemoteUrlKind
import com.nyora.hasan72341.shared.net.fetchBytes
import com.nyora.hasan72341.shared.net.rewriteRemoteUrl
import com.nyora.hasan72341.shared.extension.RotatingSourceImageResolver
import java.nio.file.Files
import java.nio.file.Path

class PageImageLoader(
    private val networkConfig: HelperNetworkConfig = HelperNetworkConfig(),
) {
    private val rotatingImages = RotatingSourceImageResolver(networkConfig)
    // Atsumoe moved static images to its CDN. Old chapter caches still contain
    // the origin URL, whose redirects can now return 410 for valid images.
    private fun currentImageUrl(url: String): String {
        for (scheme in listOf("https", "http")) {
            val origin = "$scheme://atsu.moe"
            if (url.startsWith("$origin/static/pages/") || url.startsWith("$origin/static/posters/")) {
                return "https://cdn.atsu.moe" + url.removePrefix(origin)
            }
        }
        return url
    }

    /**
     * Returns raw bytes — the platform UI is responsible for decoding them.
     *
     * @param allowLocalFiles when false (the public `/image` proxy), a non-http URL is rejected
     *   instead of read from disk, closing the arbitrary-file-read hole.
     * @param blockPrivateHosts when true (the public `/image` proxy), refuse fetches that resolve
     *   to private/reserved addresses (SSRF protection).
     */
    fun loadBytes(
        url: String,
        headers: Map<String, String> = emptyMap(),
        allowLocalFiles: Boolean = true,
        blockPrivateHosts: Boolean = false,
        sourceId: String? = null,
    ): ByteArray {
        return if (url.startsWith("http://") || url.startsWith("https://")) {
            if (networkConfig.usesDesktopRelay) {
                val identity = sourceId ?: throw java.io.IOException("desktop_relay_source_required")
                return fetchBytes(
                    currentImageUrl(rotatingImages.resolve(url, identity)),
                    networkConfig.sourceHttpClient(identity, blockPrivateHosts),
                    headers,
                )
            }
            val settings = networkConfig.snapshot()
            fetchBytes(
                rewriteRemoteUrl(currentImageUrl(rotatingImages.resolve(url)), settings, RemoteUrlKind.Image),
                networkConfig.sharedHttpClient(blockPrivateHosts),
                headers,
            )
        } else {
            if (!allowLocalFiles) throw SecurityException("local file access is not permitted")
            Files.readAllBytes(HelperProfile.confine(Path.of(url)))
        }
    }
}
