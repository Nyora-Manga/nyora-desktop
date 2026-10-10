package com.nyora.hasan72341.shared.extension

import org.json.JSONObject
import kotlin.test.*

class NativeBrowserSourcePolicyTest {
    private val environment = mapOf(
        "NYORA_DESKTOP_RELAY_URL" to "http://127.0.0.1:23456/fetch",
        "NYORA_DESKTOP_RELAY_TOKEN" to "native-catalogue-test-only-credential-0123456789",
    )
    private fun fixture(vararg rows: JSONObject) = JSONObject().put("sources", rows.toList()).toString()
    private fun row(id: String = "KLIKMANGA", domain: String = "klikmanga.com") = JSONObject()
        .put("id", id).put("engine", "madara").put("domain", domain).put("broken", true)
        .put("needsCustomLogic", false)
    private fun ids(json: String, isolated: Boolean, env: Map<String, String> = environment) =
        DataDrivenCatalog.parseCatalog(json, isolated, env).map { it.source.id }.toSet()

    @Test fun auditedRowsAreNativeOnlyAndOriginalBrokenMetadataIsPreserved() {
        val klik = row(); val epsilon = row("EPSILONSCAN", "beta.epsilonscan.to")
        val input = fixture(klik, epsilon, row("unreviewed", "unknown.example"))
        assertEquals(emptySet(), ids(input, false))
        assertEquals(emptySet(), ids(input, true, emptyMap()))
        assertEquals(setOf("data:klikmanga", "data:epsilonscan"), ids(input, true))
        assertTrue(klik.getBoolean("broken")); assertTrue(epsilon.getBoolean("broken"))
    }

    @Test fun onlyCompleteValidatedPrivateRelayConfigurationEnablesExceptions() {
        assertFalse(NativeBrowserSourcePolicy.configured(false, environment))
        assertFalse(NativeBrowserSourcePolicy.configured(true, emptyMap()))
        assertTrue(NativeBrowserSourcePolicy.configured(true, environment))
        val invalidUrls = listOf("invalid", "http://127.0.0.1:23456/%invalid", "https://127.0.0.1:23456/fetch",
            "http://localhost:23456/fetch", "http://127.0.0.2:23456/fetch", "http://127.0.0.1:80/fetch",
            "http://127.0.0.1:23456/other", "http://user@127.0.0.1:23456/fetch",
            "http://127.0.0.1:23456/fetch?token=secret", "http://127.0.0.1:23456/fetch#fragment")
        for (url in invalidUrls) assertFailsWith<IllegalArgumentException> {
            ids(fixture(row()), true, environment + ("NYORA_DESKTOP_RELAY_URL" to url))
        }
        for (token in listOf("", "short", "x".repeat(257), "secret\n".repeat(8))) assertFailsWith<IllegalArgumentException> {
            ids(fixture(row()), true, environment + ("NYORA_DESKTOP_RELAY_TOKEN" to token))
        }
        for (key in environment.keys) assertFailsWith<IllegalArgumentException> {
            ids(fixture(row()), true, environment - key)
        }
        // Hosted helpers do not read even malformed desktop-only launch settings.
        assertEquals(emptySet(), ids(fixture(row()), false, mapOf("NYORA_DESKTOP_RELAY_URL" to "invalid")))
    }

    @Test fun changedEngineDomainReasonOrCustomRuntimeCannotUseHistoricalException() {
        for (engine in listOf("mangareader", "unbundled")) assertEquals(emptySet(), ids(fixture(row().put("engine", engine)), true))
        for (domain in listOf("other.example", "www.klikmanga.com", "klikmanga.com/path", "https://klikmanga.com"))
            assertEquals(emptySet(), ids(fixture(row(domain = domain)), true))
        assertEquals(emptySet(), ids(fixture(row().put("brokenReason", "missing reader engine")), true))
        assertEquals(emptySet(), ids(fixture(row().put("needsCustomLogic", true)), true))
        for (reason in listOf("", "  ")) assertEquals(setOf("data:klikmanga"), ids(fixture(row().put("brokenReason", reason)), true))
    }

    @Test fun canonicalHealthRetirementAndEngineSupportRemainAuthoritative() {
        fun permits(dead: Boolean = false, retired: Boolean = false, supported: Boolean = true, domain: String = "klikmanga.com") =
            NativeBrowserSourcePolicy.permitsBrokenSource("KLIKMANGA", "madara", domain, null,
                true, dead, retired, supported, false)
        assertTrue(permits())
        assertFalse(permits(dead = true)); assertFalse(permits(retired = true)); assertFalse(permits(supported = false))
        assertFalse(permits(domain = "future-patched.example"))
        assertEquals(emptySet(), ids(fixture(row("tumanhwas", "klikmanga.com")), true))
    }

    @Test fun actualBundledCatalogueAddsExactlyTwoKnownChallengeOnlySources() {
        val json = requireNotNull(javaClass.classLoader.getResourceAsStream("nyora/catalogue.json"))
            .bufferedReader().use { it.readText() }
        val standard = ids(json, false)
        val native = ids(json, true)
        assertEquals(setOf("data:klikmanga", "data:epsilonscan"), native - standard)
        assertEquals(emptySet(), standard - native)
        assertEquals(standard, ids(json, true, emptyMap()))
        val rows = JSONObject(json).getJSONArray("sources")
        for (index in 0 until rows.length()) {
            val entry = rows.getJSONObject(index)
            if (entry.getString("id").lowercase() in setOf("klikmanga", "epsilonscan")) assertTrue(entry.getBoolean("broken"))
        }
    }
}
