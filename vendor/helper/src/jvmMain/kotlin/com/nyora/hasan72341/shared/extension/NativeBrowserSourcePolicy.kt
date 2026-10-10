package com.nyora.hasan72341.shared.extension

import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.net.DesktopSourceRelay
import java.util.Locale

/** Exact challenge-only exceptions documented in docs/source-recovery-audit-2026-09-17.json.
 * The original health metadata stays intact for hosted/default clients. This is eligibility
 * for a native verification attempt, not evidence that a live reader has succeeded.
 */
internal object NativeBrowserSourcePolicy {
    private val CHALLENGE_ONLY_DOMAINS = mapOf(
        "klikmanga" to "klikmanga.com",
        "epsilonscan" to "beta.epsilonscan.to",
    )

    fun configured(isolated: Boolean = HelperProfile.isolated, environment: Map<String, String> = System.getenv()): Boolean =
        DesktopSourceRelay.configurationFromEnvironment(isolated, environment) != null

    fun permitsBrokenSource(
        rowId: String, engineKey: String, domain: String, brokenReason: String?,
        nativeBrowserConfigured: Boolean, canonicalDead: Boolean, retired: Boolean, engineSupported: Boolean,
        needsCustomLogic: Boolean,
    ): Boolean = nativeBrowserConfigured && !canonicalDead && !retired && engineSupported &&
        !needsCustomLogic && engineKey == "madara" && brokenReason.isNullOrBlank() &&
        CHALLENGE_ONLY_DOMAINS[rowId.lowercase(Locale.ROOT)] == domain
}
