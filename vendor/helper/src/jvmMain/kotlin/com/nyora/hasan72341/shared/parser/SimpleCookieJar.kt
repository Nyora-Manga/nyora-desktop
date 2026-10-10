package com.nyora.hasan72341.shared.parser

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import java.util.concurrent.ConcurrentHashMap

/**
 * Minimal session-only cookie jar (cleared each helper restart).
 * Persistence will be added later when source preferences land.
 */
class SimpleCookieJar : CookieJar {
    private val store = ConcurrentHashMap<String, MutableList<Cookie>>()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        val host = url.host
        val bucket = store.getOrPut(host) { mutableListOf() }
        synchronized(bucket) {
            cookies.forEach { c ->
                bucket.removeAll { it.name == c.name }
                if (c.expiresAt > System.currentTimeMillis()) {
                    bucket.add(c)
                }
            }
        }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val bucket = store[url.host] ?: return emptyList()
        synchronized(bucket) {
            val now = System.currentTimeMillis()
            bucket.removeAll { it.expiresAt <= now }
            return bucket.filter { it.matches(url) }.toList()
        }
    }

    /**
     * Inject cookies from a raw `Cookie:` header string (e.g. a Cloudflare
     * `cf_clearance` solved by the app's WebView and POSTed to the helper).
     */
    fun put(url: HttpUrl, cookieHeader: String) {
        val cookies = cookieHeader.split(";")
            .mapNotNull { Cookie.parse(url, it.trim()) }
        if (cookies.isNotEmpty()) saveFromResponse(url, cookies)
    }
}
