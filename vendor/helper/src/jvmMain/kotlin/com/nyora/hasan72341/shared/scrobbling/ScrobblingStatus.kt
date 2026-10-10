package com.nyora.hasan72341.shared.scrobbling

/**
 * Reading status for a tracked entry. Mirrors Android's
 * `ScrobblingStatus` enum; [canonical] is the platform-wide string used in the
 * `nyora_tracking` sync table (see NYORA_TRACKING_SCHEMA.md).
 */
enum class ScrobblingStatus(val canonical: String) {

	PLANNED("planning"),
	READING("reading"),
	RE_READING("rereading"),
	COMPLETED("completed"),
	ON_HOLD("paused"),
	DROPPED("dropped");

	companion object {
		fun fromCanonical(value: String?): ScrobblingStatus? =
			entries.firstOrNull { it.canonical.equals(value, ignoreCase = true) }
	}
}
