package com.nyora.hasan72341.shared.scrobbling

import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * In-process registry that bridges an OAuth `nyora://<slug>-auth?code=...&state=...`
 * deep-link callback (delivered by the OS URL-scheme handler and routed here by
 * the desktop app's single-instance dispatcher, see [DesktopUrlScheme]) back to
 * the suspended [ScrobblerOAuth.login] call waiting on it.
 *
 * This replaces the loopback HTTP server: instead of the provider redirecting to
 * `http://127.0.0.1:<port>/callback` (which the providers do NOT have registered),
 * it redirects to the custom `nyora://` scheme every provider already has on file
 * — the exact redirect the mobile / mac apps use.
 */
object DesktopOAuthCallbacks {

    private val pending = ConcurrentHashMap<String, CompletableFuture<String>>()

    /** Register a waiter keyed by the CSRF [state]; the future resolves with the auth code. */
    fun register(state: String): CompletableFuture<String> =
        CompletableFuture<String>().also { pending[state] = it }

    /** Drop a waiter (on timeout / cancellation) so it can't leak. */
    fun cancel(state: String) {
        pending.remove(state)
    }

    /**
     * Route a captured callback [rawUrl] to its waiter. Matches on `state`, falling
     * back to the sole pending waiter when the provider omitted it. The code is read
     * from either the query (`?code=`) or the fragment (`#access_token=`/`#code=`).
     *
     * @return true if a waiter was resolved (or failed), false if none matched.
     */
    fun complete(rawUrl: String): Boolean {
        val params = parse(rawUrl)
        val state = params["state"]
        val future = when {
            state != null -> pending.remove(state)
            pending.size == 1 -> pending.keys.firstOrNull()?.let { pending.remove(it) }
            else -> null
        } ?: return false

        val error = params["error"]
        val code = params["code"] ?: params["access_token"]
        return when {
            error != null -> {
                future.completeExceptionally(IllegalStateException("OAuth error: $error"))
                true
            }
            code != null -> future.complete(code) || true
            else -> {
                future.completeExceptionally(IllegalStateException("OAuth callback carried no code"))
                true
            }
        }
    }

    private fun parse(rawUrl: String): Map<String, String> {
        val uri = runCatching { URI(rawUrl) }.getOrNull() ?: return emptyMap()
        val out = HashMap<String, String>()
        listOfNotNull(uri.rawQuery, uri.rawFragment).forEach { part ->
            for (pair in part.split('&')) {
                val i = pair.indexOf('=')
                if (i > 0) out[dec(pair.substring(0, i))] = dec(pair.substring(i + 1))
            }
        }
        return out
    }

    private fun dec(s: String): String =
        runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
}
