package com.nyora.hasan72341.shared

/**
 * Hand-maintained catalogue gates.
 *
 * Deliberately NOT in [SourcePatches]: that file is generated from
 * nyora-data-driven/patches.json and carries a "DO NOT EDIT" header, so anything
 * added there is silently dropped the next time the generator runs. These two sets
 * are curated by hand, so they live here instead.
 */
object SourceGates {

    /**
     * Sources upstream marks `isBroken` that we have since fixed (own parser override,
     * domain patch, request signing, …) and therefore still want in the catalogue.
     *
     * Empty means "trust upstream's isBroken flag", which is what the catalogue did
     * before this gate existed.
     */
    val REVIVED_SOURCES: Set<String> = emptySet()

    /**
     * Sources known to sit behind a Cloudflare challenge, seeded by hand.
     *
     * A challenge can only be cleared by something with a browser, which a web client
     * talking to the hosted helper does not have — so these are hidden from it. This is
     * only a seed: [com.nyora.hasan72341.shared.net.CloudflareInterceptor.isChallenged]
     * learns the rest at runtime, and an empty seed simply means nothing is hidden until
     * a challenge is actually observed.
     *
     * Note MangaFire does NOT belong here. Its 403s are a datacenter-IP block that the
     * residential proxy already clears, not a challenge.
     */
    val CLOUDFLARE_SOURCES: Set<String> = emptySet()
}
