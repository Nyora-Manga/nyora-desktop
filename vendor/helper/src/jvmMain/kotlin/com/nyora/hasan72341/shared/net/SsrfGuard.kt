package com.nyora.hasan72341.shared.net

import okhttp3.Dns
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException

/**
 * SSRF / LFI protection for the public image proxy.
 *
 * The helper binds to loopback with a reverse proxy (Caddy) in front, so it cannot distinguish
 * a hostile public request from a trusted local one — every proxied URL must be validated on its
 * own merits. Without this, `/image?u=` was an unauthenticated arbitrary-file read (non-http URLs
 * hit a local-file fallback) and an SSRF (http URLs could reach `127.0.0.1`, `169.254.169.254`,
 * and any internal host).
 */
object SsrfGuard {

    /**
     * Rejects anything that isn't a public http(s) URL: non-http schemes (which is what enabled
     * the local-file read) and hosts that resolve to a private/reserved/loopback/link-local
     * address (which enabled reaching internal services).
     */
    fun assertPublicHttpUrl(rawUrl: String) {
        val uri = runCatching { URI(rawUrl) }.getOrNull() ?: throw SecurityException("blocked url")
        when (uri.scheme?.lowercase()) {
            "http", "https" -> Unit
            else -> throw SecurityException("blocked scheme")
        }
        val host = uri.host?.trim('[', ']')?.takeIf { it.isNotBlank() } ?: throw SecurityException("blocked host")
        val addresses = runCatching { InetAddress.getAllByName(host) }.getOrNull()
        if (addresses.isNullOrEmpty() || addresses.any { it.isForbidden() }) {
            throw SecurityException("blocked target")
        }
    }

    /**
     * OkHttp DNS that resolves normally then drops forbidden addresses, so redirects and
     * DNS-rebinding to an internal host are refused at connection time (not just up front).
     */
    val safeDns: Dns = filteringDns(Dns.SYSTEM)

    /** Wrap the selected resolver (system, custom, or DoH) without losing SSRF filtering. */
    fun filteringDns(delegate: Dns): Dns = Dns { hostname ->
        literalAddress(hostname)?.let { literal ->
            if (literal.isForbidden()) throw UnknownHostException("blocked host: $hostname")
        }
        delegate.lookup(hostname)
            .filterNot { it.isForbidden() }
            .ifEmpty { throw UnknownHostException("blocked host: $hostname") }
    }

    private fun literalAddress(hostname: String): InetAddress? {
        val looksLikeLiteral = ':' in hostname || hostname.all { it.isDigit() || it == '.' }
        if (!looksLikeLiteral) return null
        return runCatching { InetAddress.getByName(hostname) }.getOrNull()
    }

    private fun InetAddress.isForbidden(): Boolean =
        isAnyLocalAddress || isLoopbackAddress || isLinkLocalAddress ||
            isSiteLocalAddress || isMulticastAddress || isCarrierGradeNat() || isUniqueLocalV6()

    /** 100.64.0.0/10 (carrier-grade NAT) — not covered by [InetAddress.isSiteLocalAddress]. */
    private fun InetAddress.isCarrierGradeNat(): Boolean {
        if (this !is Inet4Address) return false
        val b = address
        return (b[0].toInt() and 0xff) == 100 && (b[1].toInt() and 0xff) in 64..127
    }

    /** fc00::/7 unique-local IPv6. */
    private fun InetAddress.isUniqueLocalV6(): Boolean {
        val b = address
        return b.size == 16 && (b[0].toInt() and 0xfe) == 0xfc
    }
}
