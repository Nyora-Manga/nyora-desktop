package com.nyora.hasan72341.shared.net

import java.util.Base64
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.Request
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class WebViewRelayDiagnosticTest {

    @Test
    fun relayDiagnosticContainsOnlyHostStatusAndLength() {
        assertEquals(
            "[cf] RELAY resp host=adult.example status=200 len=1234\n",
            webViewRelayDiagnostic(host = "adult.example", status = 200, length = 1234),
        )
    }

    @Test
    fun expiredRelayResponseIsRejectedAndHostCanBeDisabled() {
        val host = "expired.example"
        WebViewRelay.enableForHost(host)
        assertTrue(WebViewRelay.isRelayHost(host))

        assertFalse(webViewRelayResponseIsUsable(403))
        assertFalse(webViewRelayResponseIsUsable(503))
        assertTrue(webViewRelayResponseIsUsable(200))
        WebViewRelay.disableForHost(host)

        assertFalse(WebViewRelay.isRelayHost(host))
    }

    @Test
    fun reconstructedRelayResponsePreservesAChallengeMarkerOnHttp200() {
        val request = Request.Builder().url("https://protected.example/manga").build()
        val relayPayload = buildJsonObject {
            put("status", 200)
            put("bodyBase64", Base64.getEncoder().encodeToString("challenge".toByteArray()))
            putJsonObject("headers") {
                put("content-type", "text/html")
                put("cf-mitigated", "challenge")
            }
        }

        val response = assertNotNull(reconstructWebViewRelayResponse(request, relayPayload))

        assertEquals("challenge", response.header("cf-mitigated"))
        assertFalse(webViewRelayResponseIsUsable(response.code, response.header("cf-mitigated")))
    }
}
