package com.nyora.hasan72341.shared.extension

import app.nyora.data.engine.AntiBotKind
import app.nyora.data.engine.EngineContext
import app.nyora.data.engine.HtmlDocument
import app.nyora.data.engine.HttpRequest
import app.nyora.data.engine.HttpResponse
import app.nyora.data.engine.SourcePrefs
import kotlin.test.Test
import kotlin.test.assertEquals

class RotatingSourceImageResolverTest {
    private val hash = "0".repeat(61) + "abc"
    private val stale = "https://a1.cdn.example.net/1000000000/3243/$hash.avif"

    @Test fun staleImageUsesCurrentRoutingAndReusesTheEngineCache() = withCatalogue {
        install()
        val context = RoutingContext("2000000000")
        var creations = 0
        val resolver = RotatingSourceImageResolver { creations++; context }
        val expected = "https://a2.cdn.example.net/2000000000/3243/$hash.avif"
        assertEquals(expected, resolver.resolve(stale))
        assertEquals(expected, resolver.resolve(stale))
        assertEquals(1, creations)
        assertEquals(1, context.requests.size)
        assertEquals("https://ltn.cdn.example.net/gg.js", context.requests.single().url)
        assertEquals("https://source.example/", context.requests.single().headers["Referer"])
    }

    @Test fun unrelatedMalformedAndWrongHostUrlsNeverCreateANetworkContext() = withCatalogue {
        install()
        var creations = 0
        val resolver = RotatingSourceImageResolver { creations++; RoutingContext("2000000000") }
        val urls = listOf(
            "https://example.com/image.jpg", "not a URL", stale.replace("a1.", "a3."),
            stale.replace("cdn.example.net", "cdn.example.net.unrelated.example"),
            stale.replace("https://", "http://"), stale.replace("/3243/", "/1/"),
            stale.replace(".avif", ".jpg"), "$stale?token=1", "$stale#fragment",
            stale.replace("https://", "https://user@"), stale.replace("/1000000000/", "/prefix/"),
            stale.replace("a1.cdn.example.net", "a1.cdn.example.net:8443"),
        )
        for (url in urls) assertEquals(url, resolver.resolve(url))
        assertEquals(0, creations)
    }

    @Test fun catalogueReplacementInvalidatesTheCachedEngineAndEffectiveDomain() = withCatalogue {
        install()
        val contexts = mutableListOf<RoutingContext>()
        val resolver = RotatingSourceImageResolver { entry ->
            RoutingContext(if (entry.definition.domain == "source.example") "2000000000" else "3000000000").also(contexts::add)
        }
        resolver.resolve(stale)
        install(domain = "replacement.example")
        assertEquals("https://a2.cdn.example.net/3000000000/3243/$hash.avif", resolver.resolve(stale))
        assertEquals(2, contexts.size)
        assertEquals(1, contexts.last().requests.size)
        install(cdn = "replacement-cdn.example")
        assertEquals(stale, resolver.resolve(stale))
        assertEquals(2, contexts.size)
    }

    @Test fun similarlyConfiguredOtherSourcesCannotClaimHitomiImageUrls() = withCatalogue {
        install(id = "different-source")
        var creations = 0
        val resolver = RotatingSourceImageResolver { creations++; RoutingContext("2000000000") }
        assertEquals(stale, resolver.resolve(stale))
        assertEquals(0, creations)
    }

    @Test fun staleThumbnailsRefreshTheirHostAndPreserveTheExactSizeRoute() = withCatalogue {
        install()
        val context = RoutingContext("2000000000")
        val resolver = RotatingSourceImageResolver { context }
        for (directory in listOf("webpbigtn", "webpsmallsmalltn")) {
            val url = "https://atn.cdn.example.net/$directory/c/ab/$hash.webp"
            assertEquals(url.replace("https://atn.", "https://btn."), resolver.resolve(url))
        }
        val malformed = "https://atn.cdn.example.net/webpbigtn/c/ff/$hash.webp"
        assertEquals(malformed, resolver.resolve(malformed))
        assertEquals(1, context.requests.size)
    }

    private fun install(id: String = "hitomi", domain: String = "source.example", cdn: String = "cdn.example.net") {
        DataDrivenCatalog.replace("""{"sources":[{"id":"$id","engine":"hitomi","domain":"$domain","config":{"cdnDomain":"$cdn"}}]}""")
    }
    private fun withCatalogue(block: () -> Unit) {
        val original = DataDrivenCatalog.snapshot()
        try { block() } finally { DataDrivenCatalog.restore(original) }
    }
    private class RoutingContext(private val prefix: String) : EngineContext {
        val requests = mutableListOf<HttpRequest>()
        override suspend fun http(request: HttpRequest): HttpResponse {
            requests += request
            return HttpResponse(request.url, 200,
                "var gg = { m: function(g) { var o = 0; switch(g) { case 3243: o = 1; break; } return o; }, b: '$prefix/' };",
                emptyMap())
        }
        override val prefs: SourcePrefs = object : SourcePrefs {
            override fun getString(key: String): String? = null
            override fun putString(key: String, value: String?) = Unit
        }
        override fun parseHtml(html: String, baseUrl: String): HtmlDocument = error("Routing does not parse HTML")
        override suspend fun solveAntiBot(kind: AntiBotKind, url: String): Map<String, String> = error("Routing does not authenticate")
    }
}
