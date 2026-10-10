package com.nyora.hasan72341.shared.scrobbling

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * A one-shot loopback HTTP server used to capture an OAuth authorization
 * `code` on desktop (mac / linux / windows). It binds to `127.0.0.1` on the
 * requested [requestedPort] (0 = ephemeral), serves a single [path] callback
 * that the tracker service redirects the browser to after consent, extracts
 * the `code` (or `error`) query parameter, shows the user a "you can close
 * this window" page, and completes.
 *
 * The [redirectUri] this server listens on is what [ScrobblerOAuth.login]
 * passes to the service as the OAuth `redirect_uri`. Because it is a real
 * `http://127.0.0.1:<port>/callback` URL (not a custom `nyora://` scheme), it
 * works in an ordinary desktop browser without an OS URL-scheme handler.
 *
 * NOTE: each service's OAuth application must whitelist this loopback pattern
 * (many — e.g. Google-style — allow any `http://127.0.0.1:<port>` for
 * "installed app" clients, but AniList / MAL / Shikimori generally require the
 * exact redirect URI to be pre-registered). See [ScrobblerOAuth].
 */
class OAuthLoopbackServer(
	requestedPort: Int = 0,
	private val path: String = "/callback",
	/** Optional CSRF `state` value to require on the callback. */
	private val expectedState: String? = null,
) {

	private val server: HttpServer =
		HttpServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), requestedPort), 0)

	private val result = CompletableFuture<String>()

	/** The actual bound port (resolved even when an ephemeral port was requested). */
	val port: Int get() = server.address.port

	/** The full loopback redirect URI the service should send the browser back to. */
	val redirectUri: String get() = "http://127.0.0.1:$port$path"

	init {
		server.createContext(path) { exchange ->
			try {
				val params = parseQuery(exchange.requestURI.rawQuery)
				val html: String
				val error = params["error"]
				val code = params["code"]
				val token = params["access_token"]   // implicit grant (e.g. AniList)
				val state = params["state"]
				when {
					error != null -> {
						result.completeExceptionally(IllegalStateException("OAuth error: $error"))
						html = page("Authorization failed", "You can close this window and try again.")
					}
					code == null && token == null -> {
						// No query params yet. An implicit-grant service (AniList) returns
						// the token in the URL *fragment*, which the browser never sends to
						// the server. Serve a tiny page that reflects location.hash back as a
						// query so this same endpoint receives `access_token`. Auth-code
						// services always arrive with `code`, so they skip this branch.
						html = fragmentBouncePage(path)
					}
					code != null -> {
						if (expectedState != null && state != expectedState) {
							result.completeExceptionally(IllegalStateException("OAuth state mismatch"))
							html = page("Authorization failed", "Security check failed. Please try again.")
						} else {
							result.complete(code)
							html = page("Signed in", "You can close this window and return to Nyora.")
						}
					}
					else -> {
						// Implicit access token (from the fragment bounce above).
						if (expectedState != null && state != null && state != expectedState) {
							result.completeExceptionally(IllegalStateException("OAuth state mismatch"))
							html = page("Authorization failed", "Security check failed. Please try again.")
						} else {
							result.complete(token!!)
							html = page("Signed in", "You can close this window and return to Nyora.")
						}
					}
				}
				val bytes = html.toByteArray(Charsets.UTF_8)
				exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
				exchange.sendResponseHeaders(200, bytes.size.toLong())
				exchange.responseBody.use { it.write(bytes) }
			} catch (t: Throwable) {
				result.completeExceptionally(t)
				runCatching { exchange.sendResponseHeaders(500, -1) }
			} finally {
				exchange.close()
			}
		}
		server.executor = null
		server.start()
	}

	/** Suspend until the browser hits the callback, or [timeoutMillis] elapses. */
	suspend fun awaitCode(timeoutMillis: Long = 300_000L): String = withContext(Dispatchers.IO) {
		try {
			result.get(timeoutMillis, TimeUnit.MILLISECONDS)
		} catch (e: TimeoutException) {
			throw IllegalStateException("Timed out waiting for OAuth callback", e)
		}
	}

	fun stop() {
		runCatching { server.stop(0) }
	}

	private fun parseQuery(raw: String?): Map<String, String> {
		if (raw.isNullOrEmpty()) return emptyMap()
		val out = LinkedHashMap<String, String>()
		for (pair in raw.split('&')) {
			if (pair.isEmpty()) continue
			val i = pair.indexOf('=')
			val key = if (i < 0) pair else pair.substring(0, i)
			val value = if (i < 0) "" else pair.substring(i + 1)
			out[dec(key)] = dec(value)
		}
		return out
	}

	private fun dec(s: String): String = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)

	private fun fragmentBouncePage(path: String): String =
		"<!doctype html><html><head><meta charset=\"utf-8\"><title>Signing in\u2026</title></head>" +
			"<body><script>" +
			"var h=window.location.hash;" +
			"if(h&&h.length>1){window.location.replace(window.location.pathname+'?'+h.substring(1));}" +
			"else{document.body.textContent='No token returned. You can close this window.';}" +
			"</script>Signing\u2026</body></html>"

	private fun page(title: String, body: String): String =
		"<!doctype html><html><head><meta charset=\"utf-8\"><title>$title</title>" +
			"<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#111;color:#eee;" +
			"display:flex;height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}" +
			"div{max-width:26rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{opacity:.8}</style></head>" +
			"<body><div><h1>$title</h1><p>$body</p></div></body></html>"
}
