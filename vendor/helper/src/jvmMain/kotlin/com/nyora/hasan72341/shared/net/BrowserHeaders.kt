package com.nyora.hasan72341.shared.net

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Full modern-Chrome header set (client hints + fetch metadata + Accept) derived
 * to match [userAgent]. Server-side requests that send only a User-Agent look
 * bot-like and get 403'd by header/anti-bot checks; a browser-consistent set
 * (and hints that match the cf_clearance UA) avoids that.
 */
fun browserHeaders(userAgent: String, isXhr: Boolean): Map<String, String> {
    val major = Regex("""Chrome/(\d+)""").find(userAgent)?.groupValues?.getOrNull(1) ?: "131"
    val platform = when {
        userAgent.contains("Windows") -> "\"Windows\""
        userAgent.contains("Android") -> "\"Android\""
        userAgent.contains("Mac OS X") || userAgent.contains("Macintosh") -> "\"macOS\""
        userAgent.contains("Linux") -> "\"Linux\""
        else -> "\"Windows\""
    }
    val secChUa = "\"Chromium\";v=\"$major\", \"Google Chrome\";v=\"$major\", \"Not_A Brand\";v=\"24\""

    val headers = linkedMapOf(
        "Accept-Language" to "en-US,en;q=0.9",
        "sec-ch-ua" to secChUa,
        "sec-ch-ua-mobile" to "?0",
        "sec-ch-ua-platform" to platform,
    )
    if (isXhr) {
        headers["Accept"] = "application/json, text/plain, */*"
        headers["Sec-Fetch-Dest"] = "empty"
        headers["Sec-Fetch-Mode"] = "cors"
        headers["Sec-Fetch-Site"] = "same-origin"
    } else {
        headers["Accept"] =
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
        headers["Sec-Fetch-Dest"] = "document"
        headers["Sec-Fetch-Mode"] = "navigate"
        headers["Sec-Fetch-Site"] = "none"
        headers["Sec-Fetch-User"] = "?1"
        headers["Upgrade-Insecure-Requests"] = "1"
    }
    return headers
}

/**
 * Adds a browser-consistent header set to every outbound request, WITHOUT
 * overriding anything a parser already set (its Referer / X-Requested-With /
 * custom Accept win). Hints are derived from the request's final User-Agent, so
 * they stay consistent even after [CloudflareInterceptor] swaps the UA to the
 * FlareSolverr-solved one (this interceptor is ordered AFTER it).
 */
object BrowserHeadersInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val userAgent = original.header("User-Agent") ?: NYORA_BROWSER_UA
        val isXhr = original.header("X-Requested-With")?.equals("XMLHttpRequest", ignoreCase = true) == true

        val builder = original.newBuilder()
        if (original.header("User-Agent") == null) {
            builder.header("User-Agent", userAgent)
        }
        for ((name, value) in browserHeaders(userAgent, isXhr)) {
            if (original.header(name) == null) {
                builder.header(name, value)
            }
        }
        return chain.proceed(builder.build())
    }
}
