package app.nyora.data.runtime

import app.nyora.data.engine.HttpRequest
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertContentEquals
import kotlin.test.assertFailsWith

class DefaultEngineContextTest {

    @Test
    fun binaryRangeResponsesPreserveNonUtf8BytesAndHeaders() {
        MockWebServer().use { server ->
            server.start()
            val bytes = byteArrayOf(0, 0xff.toByte(), 0xc3.toByte(), 0x28, 0x80.toByte())
            server.enqueue(MockResponse.Builder().code(206)
                .addHeader("Content-Type", "application/octet-stream")
                .addHeader("Content-Range", "bytes 10-14/100")
                .body(okio.Buffer().write(bytes)).build())
            val context = DefaultEngineContext(client = OkHttpClient())
            val response = runBlocking { context.http(HttpRequest(
                url = server.url("/index.nozomi").toString(),
                headers = mapOf("Range" to "bytes=10-14"), binaryResponse = true,
            )) }
            assertEquals(206, response.code)
            assertContentEquals(bytes, response.bodyBytes)
            assertEquals("", response.body)
            assertEquals("bytes 10-14/100", response.headers.entries.first { it.key.equals("Content-Range", true) }.value)
            assertEquals("bytes=10-14", server.takeRequest().headers["Range"])
        }
    }

    @Test
    fun binaryResponsesRejectOversizedChunkedBodies() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder()
                .chunkedBody(okio.Buffer().write(ByteArray(16 * 1024 * 1024 + 1)), 8192).build())
            val context = DefaultEngineContext(client = OkHttpClient())
            assertFailsWith<java.io.IOException> {
                runBlocking { context.http(HttpRequest(url = server.url("/index").toString(), binaryResponse = true)) }
            }
        }
    }

    @Test
    fun outboundRequestsUseTheInjectedHttpClient() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("from server").build())
            val sharedClient = OkHttpClient.Builder()
                .addInterceptor(Interceptor { chain ->
                    chain.proceed(
                        chain.request().newBuilder()
                            .header("X-Nyora-Network", "shared")
                            .build(),
                    )
                })
                .build()
            val context = DefaultEngineContext(client = sharedClient)

            val response = runBlocking {
                context.http(HttpRequest(url = server.url("/chapter").toString()))
            }

            assertEquals("from server", response.body)
            assertEquals("shared", server.takeRequest().headers["X-Nyora-Network"])
        }
    }

    @Test
    fun outboundRequestsResolveTheClientProviderForEachCall() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("first").build())
            server.enqueue(MockResponse.Builder().body("second").build())
            val clients = ArrayDeque(
                listOf(
                    clientAddingHeader("X-Nyora-Revision", "one"),
                    clientAddingHeader("X-Nyora-Revision", "two"),
                ),
            )
            val context = DefaultEngineContext(clientProvider = { clients.removeFirst() })

            runBlocking {
                context.http(HttpRequest(url = server.url("/first").toString()))
                context.http(HttpRequest(url = server.url("/second").toString()))
            }

            assertEquals("one", server.takeRequest().headers["X-Nyora-Revision"])
            assertEquals("two", server.takeRequest().headers["X-Nyora-Revision"])
        }
    }

    @Test
    fun outboundRequestsDefaultRefererToTheEffectiveSourceDomain() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("ok").build())
            val context = DefaultEngineContext(
                client = OkHttpClient(),
                effectiveDomain = { "reader.example" },
            )

            runBlocking {
                context.http(HttpRequest(url = server.url("/chapter").toString()))
            }

            assertEquals("https://reader.example/", server.takeRequest().headers["Referer"])
        }
    }

    @Test
    fun explicitRefererWinsOverTheEffectiveSourceDomainDefault() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("ok").build())
            val context = DefaultEngineContext(
                client = OkHttpClient(),
                effectiveDomain = { "reader.example" },
            )

            runBlocking {
                context.http(
                    HttpRequest(
                        url = server.url("/chapter").toString(),
                        headers = mapOf("referer" to "https://chapter.example/read/"),
                    ),
                )
            }

            val recorded = server.takeRequest()
            assertEquals("https://chapter.example/read/", recorded.headers["Referer"])
            assertEquals(1, recorded.headers.values("Referer").size)
        }
    }

    @Test
    fun multipartEncodingHintBuildsMultipartBodyWithoutLeakingTheMarker() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().body("ok").build())
            val context = DefaultEngineContext(client = OkHttpClient())

            runBlocking {
                context.http(
                    HttpRequest(
                        url = server.url("/advanced-search").toString(),
                        method = "POST",
                        headers = mapOf("x-nyora-encoding" to "multipart"),
                        form = linkedMapOf("query" to "solo leveling", "genre" to "[\"action\"]"),
                    ),
                )
            }

            val recorded = server.takeRequest()
            assertNull(recorded.headers["X-Nyora-Encoding"])
            assertTrue(recorded.headers["Content-Type"].orEmpty().startsWith("multipart/form-data; boundary="))
            val body = recorded.body?.utf8().orEmpty()
            assertTrue(body.contains("name=\"query\"\r\n\r\nsolo leveling"))
            assertTrue(body.contains("name=\"genre\"\r\n\r\n[\"action\"]"))
        }
    }

    private fun clientAddingHeader(name: String, value: String): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                chain.proceed(chain.request().newBuilder().header(name, value).build())
            })
            .build()
}
