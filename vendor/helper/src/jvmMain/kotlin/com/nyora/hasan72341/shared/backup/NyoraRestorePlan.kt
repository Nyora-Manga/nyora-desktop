package com.nyora.hasan72341.shared.backup

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

@Serializable
enum class NyoraRestoreMode {
    @SerialName("merge")
    Merge,

    @SerialName("replace")
    Replace,
    ;

    companion object {
        fun parse(value: String?): NyoraRestoreMode? = when (value?.lowercase()) {
            null, "", "merge" -> Merge
            "replace" -> Replace
            else -> null
        }
    }
}

@Serializable
data class NyoraRestoreSectionPlan(
    val additions: Int = 0,
    val updates: Int = 0,
    val deletions: Int = 0,
    val unchanged: Int = 0,
)

@Serializable
data class NyoraRestorePlan(
    val mode: NyoraRestoreMode,
    val archiveId: String,
    val createdAt: String,
    val platform: String,
    val sections: Map<String, NyoraRestoreSectionPlan>,
    val unresolvedSources: List<String>,
    val omissions: Map<String, Int>,
    val warnings: List<String> = emptyList(),
    /** Transaction target retained in-process; REST plan responses expose only the summary. */
    @Transient
    val preview: NyoraBackupSnapshot = NyoraBackupSnapshot(
        archiveId = "00000000-0000-0000-0000-000000000000",
        createdAt = "1970-01-01T00:00:00.000Z",
        appVersion = "preview",
        platform = "preview",
    ),
)

@Serializable
data class NyoraRestoreResult(
    val ok: Boolean = true,
    val plan: NyoraRestorePlan,
    val applied: Map<String, Int>,
)
