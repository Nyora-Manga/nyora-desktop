package com.nyora.hasan72341.shared.proxy

import com.nyora.hasan72341.shared.net.HelperNetworkSettings
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Protocol
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CatalogueHttpClientTest {

    @Test
    fun rejectsPrivateAndLoopbackInitialTargetsBeforeIssuingARequest() {
        val requests = AtomicInteger()
        val client = respondingClient { request ->
            requests.incrementAndGet()
            response(request, 200, body = "{}")
        }

        listOf("https://127.0.0.1/catalogue.json", "https://10.0.0.1/catalogue.json").forEach { target ->
            assertFailsWith<SecurityException>(target) {
                downloadCatalogue(URI(target), client)
            }
        }

        assertEquals(0, requests.get())
    }

    @Test
    fun rejectsPrivateAndLoopbackRedirectTargetsBeforeFollowingThem() {
        listOf("https://127.0.0.1/private.json", "https://10.0.0.1/private.json").forEach { target ->
            val requests = AtomicInteger()
            val client = respondingClient { request ->
                requests.incrementAndGet()
                response(request, 302, location = target)
            }

            assertFailsWith<SecurityException>(target) {
                downloadCatalogue(URI("https://8.8.8.8/catalogue.json"), client)
            }
            assertEquals(1, requests.get(), target)
        }
    }

    @Test
    fun followsAValidatedPublicHttpsRedirect() {
        val hosts = mutableListOf<String>()
        val client = respondingClient { request ->
            hosts += request.url.host
            if (request.url.host == "8.8.8.8") {
                response(request, 302, location = "https://1.1.1.1/catalogue.json")
            } else {
                response(request, 200, body = "{\"sources\":[]}")
            }
        }

        val body = downloadCatalogue(URI("https://8.8.8.8/start.json"), client)

        assertEquals("{\"sources\":[]}", body)
        assertEquals(listOf("8.8.8.8", "1.1.1.1"), hosts)
    }

    @Test
    fun configuredDohCannotOverrideCataloguePrivateAddressFiltering() {
        val client = buildCatalogueHttpClient(
            HelperNetworkSettings(dnsOverHttps = "cloudflare"),
        )

        assertFailsWith<UnknownHostException> {
            client.dns.lookup("127.0.0.1")
        }
    }

    @Test
    fun rejectsAnHttpsToHttpRedirectBeforeIssuingTheHttpRequest() {
        val requests = AtomicInteger()
        val client = respondingClient { request ->
            requests.incrementAndGet()
            response(request, 302, location = "http://1.1.1.1/downgraded-catalogue.json")
        }

        val error = assertFailsWith<IllegalArgumentException> {
            downloadCatalogue(URI("https://8.8.8.8/catalogue.json"), client)
        }

        assertTrue(error.message.orEmpty().contains("HTTPS"))
        assertEquals(1, requests.get())
    }

    private fun respondingClient(handler: (Request) -> Response): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor { chain -> handler(chain.request()) }
            .build()

    private fun response(
        request: Request,
        code: Int,
        location: String? = null,
        body: String = "",
    ): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(code)
        .message("test")
        .apply { if (location != null) header("Location", location) }
        .body(body.toResponseBody())
        .build()
}
