package com.nyora.hasan72341.shared.net

import com.nyora.hasan72341.shared.reader.PageImageLoader
import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Dns
import okhttp3.OkHttpClient
import okio.Buffer
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue

class HelperNetworkSecurityTest {

    @Test
    fun atsumoeCachedImageLinksUseTheCurrentCdnWithoutChangingPathsOrOtherSources() {
        val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 0)
        val requested = mutableListOf<String>()
        val config = HelperNetworkConfig()
        config.sharedHttpClient(blockPrivateHosts = true, factory = { _, _ ->
            OkHttpClient.Builder().addInterceptor { chain ->
                requested += chain.request().url.toString()
                okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(200).message("OK").header("Content-Type", "image/jpeg")
                    .body(okhttp3.ResponseBody.create(null, jpeg)).build()
            }.build()
        })
        val inputs = listOf(
            "https://atsu.moe/static/pages/series/chapter/page%20one.avif?token=a%2Fb",
            "https://atsu.moe/static/posters/cover.jpg",
            "https://cdn.atsu.moe/static/pages/series/chapter/page.avif",
            "https://other.example/static/pages/page.avif",
            "https://atsu.moe.example/static/pages/page.avif",
            "https://atsu.moe/api/read/chapter?id=chapter",
        )
        val loader = PageImageLoader(config)
        inputs.forEach { assertContentEquals(jpeg, loader.loadBytes(it, allowLocalFiles = false, blockPrivateHosts = true)) }
        assertEquals(listOf(
            "https://cdn.atsu.moe/static/pages/series/chapter/page%20one.avif?token=a%2Fb",
            "https://cdn.atsu.moe/static/posters/cover.jpg",
        ) + inputs.drop(2), requested)
    }

    @Test
    fun networkConfigReusesOneClientUntilItsNormalizedSettingsChange() {
        val config = HelperNetworkConfig()
        var builds = 0
        val factory: (HelperNetworkSettings, Boolean) -> OkHttpClient = { _, _ ->
            builds += 1
            OkHttpClient()
        }

        val first = config.sharedHttpClient(factory = factory)
        val second = config.sharedHttpClient(factory = factory)

        assertSame(first, second)
        assertEquals(1, builds)

        config.update(HelperNetworkSettings(sslBypass = true))
        val afterSettingsChange = config.sharedHttpClient(factory = factory)

        assertNotSame(first, afterSettingsChange)
        assertEquals(2, builds)
        assertSame(afterSettingsChange, config.sharedHttpClient(factory = factory))
        assertEquals(2, builds)
    }

    @Test
    fun pageImageLoaderReusesItsConnectionUntilNetworkSettingsChange() {
        MockWebServer().use { server ->
            server.start()
            val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 0)
            repeat(3) {
                server.enqueue(
                    MockResponse.Builder()
                        .addHeader("Content-Type", "image/jpeg")
                        .body(Buffer().write(jpeg))
                        .build(),
                )
            }
            val config = HelperNetworkConfig()
            val loader = PageImageLoader(config)

            loader.loadBytes(server.url("/one.jpg").toString())
            loader.loadBytes(server.url("/two.jpg").toString())
            config.update(HelperNetworkSettings(disableConnectivityCheck = true))
            loader.loadBytes(server.url("/three.jpg").toString())

            assertEquals(0, server.takeRequest().exchangeIndex)
            assertEquals(1, server.takeRequest().exchangeIndex)
            assertEquals(0, server.takeRequest().exchangeIndex)
        }
    }

    @Test
    fun privateAddressFilteringWrapsACustomResolver() {
        val rebindingResolver = Dns { listOf(InetAddress.getByName("127.0.0.1")) }

        assertFailsWith<UnknownHostException> {
            SsrfGuard.filteringDns(rebindingResolver).lookup("apparently-public.example")
        }
    }

    @Test
    fun imageFetchRejectsAChunkedBodyLargerThanTheProxyLimit() {
        MockWebServer().use { server ->
            server.start()
            val oversized = Buffer().write(ByteArray(32 * 1024 * 1024 + 1))
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Content-Type", "image/jpeg")
                    .chunkedBody(oversized, 8192)
                    .build(),
            )

            val error = assertFailsWith<IOException> {
                fetchBytes(server.url("/oversized.jpg").toString(), HelperNetworkSettings())
            }

            assertTrue(error.message.orEmpty().contains("large", ignoreCase = true))
        }
    }

    @Test
    fun imageFetchRejectsPartialContentInsteadOfCachingItAsACompleteImage() {
        MockWebServer().use { server ->
            server.start()
            val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 0)
            server.enqueue(MockResponse.Builder().code(206)
                .addHeader("Content-Type", "image/jpeg")
                .addHeader("Content-Range", "bytes 0-5/100")
                .body(Buffer().write(jpeg)).build())
            assertFailsWith<IOException> {
                fetchBytes(server.url("/partial.jpg").toString(), HelperNetworkSettings())
            }
        }
    }

    @Test
    fun imageFetchRejectsANonImageResponse() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Content-Type", "application/octet-stream")
                    .body("<html>not an image</html>")
                    .build(),
            )

            val error = assertFailsWith<IOException> {
                fetchBytes(server.url("/cover.jpg").toString(), HelperNetworkSettings())
            }

            assertTrue(error.message.orEmpty().contains("image", ignoreCase = true))
        }
    }

    @Test
    fun imageFetchAcceptsRecognizedImageBytesWithGenericOrMissingMimeType() {
        MockWebServer().use { server ->
            server.start()
            val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 0, 0)
            val png = byteArrayOf(
                0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            )
            server.enqueue(
                MockResponse.Builder()
                    .addHeader("Content-Type", "application/octet-stream")
                    .body(Buffer().write(jpeg))
                    .build(),
            )
            server.enqueue(MockResponse.Builder().body(Buffer().write(png)).build())

            assertContentEquals(jpeg, fetchBytes(server.url("/cover.bin").toString(), HelperNetworkSettings()))
            assertContentEquals(png, fetchBytes(server.url("/cover").toString(), HelperNetworkSettings()))
        }
    }
}
