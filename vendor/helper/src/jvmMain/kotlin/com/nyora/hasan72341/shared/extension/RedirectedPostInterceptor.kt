package com.nyora.hasan72341.shared.extension

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Replays a POST that a redirect silently turned into a bodyless GET.
 *
 * When a site moves host — `coffeemanga.io` -> `coffeemanga.ink`, `lekmanga.com` ->
 * `lekmanga.site`, or merely `tilkiscans.com` -> `www.tilkiscans.com` — its old host
 * answers every path with a 301. OkHttp follows it, but for a 301/302/303 it also
 * downgrades POST to GET and drops the request body, exactly as a browser does. The
 * new host therefore receives `GET /wp-admin/admin-ajax.php` with no action and no
 * vars, and WordPress answers 400.
 *
 * That 400 reads like the site rejecting the parser's payload, which is what makes it
 * such a confusing failure: requesting the *new* host directly with the very same
 * payload returns 200 and a full catalog. Nothing is wrong with the parser except the
 * domain baked into it.
 *
 * The fix is to notice the downgrade — the chain came back with a different url and a
 * different method than it went in with — and re-issue the original POST against the
 * host the redirect landed on. Replaying is safe precisely because the body was
 * dropped: the new host never saw the first attempt, so this is the only time it is
 * asked to do anything.
 *
 * This repairs every moved source at once, without a domain override per site, and it
 * keeps working when they move again. A [SourcePatches.DOMAIN_OVERRIDES] entry is
 * still the better answer for a site that moved permanently — it saves the extra
 * round trip — but this makes the difference between a source that works and a source
 * that returns 400.
 */
internal object RedirectedPostInterceptor : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)
        if (request.method != "POST" || request.body == null) return response

        val landed = response.request
        if (landed.method == "POST" || landed.url == request.url) return response

        // The body never reached the new host, so nothing has been submitted twice.
        response.close()
        return chain.proceed(request.newBuilder().url(landed.url).build())
    }
}
