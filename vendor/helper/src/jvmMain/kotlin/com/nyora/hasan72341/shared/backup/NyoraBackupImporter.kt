package com.nyora.hasan72341.shared.backup

import com.nyora.hasan72341.shared.repository.NyoraBackupRepository

class NyoraBackupImporter(
    private val repository: NyoraBackupRepository,
) {
    fun plan(bytes: ByteArray, mode: NyoraRestoreMode = NyoraRestoreMode.Merge): NyoraRestorePlan =
        plan(NyoraBackupCodec.decode(bytes), mode)

    fun apply(bytes: ByteArray, mode: NyoraRestoreMode = NyoraRestoreMode.Merge): NyoraRestoreResult {
        val incoming = NyoraBackupCodec.decode(bytes)
        lateinit var plan: NyoraRestorePlan
        repository.setBackupSyncPaused(true)
        try {
            repository.inBackupTransaction {
                plan = plan(incoming, mode)
                repository.replaceBackupSnapshot(plan.preview)
            }
        } finally {
            repository.setBackupSyncPaused(false)
        }
        repository.reconcileBackupRestore()
        return NyoraRestoreResult(
            plan = plan,
            applied = plan.sections.mapValues { (_, count) -> count.additions + count.updates + count.deletions },
        )
    }

    private fun plan(incoming: NyoraBackupSnapshot, mode: NyoraRestoreMode): NyoraRestorePlan {
        val current = repository.readBackupSnapshot()
        val target = when (mode) {
            NyoraRestoreMode.Merge -> merge(current, incoming)
            NyoraRestoreMode.Replace -> incoming
        }
        // The merged projection must still satisfy every v1 identity/reference invariant.
        NyoraBackupCodec.encode(target)
        val sections = linkedMapOf(
            "sources" to counts(current.sources, target.sources, NyoraBackupSource::id, NyoraBackupSource::deletedAt),
            "categories" to counts(current.categories, target.categories, NyoraBackupCategory::id, NyoraBackupCategory::deletedAt),
            "preferences" to counts(current.preferences, target.preferences, NyoraBackupPreference::id, NyoraBackupPreference::deletedAt),
            "manga" to counts(current.manga, target.manga, NyoraBackupManga::id, NyoraBackupManga::deletedAt),
            "chapters" to counts(current.chapters, target.chapters, NyoraBackupChapter::id, NyoraBackupChapter::deletedAt),
            "library" to counts(current.library, target.library, NyoraBackupLibrary::id, NyoraBackupLibrary::deletedAt),
            "history" to counts(current.history, target.history, NyoraBackupHistory::id, NyoraBackupHistory::deletedAt),
            "bookmarks" to counts(current.bookmarks, target.bookmarks, NyoraBackupBookmark::id, NyoraBackupBookmark::deletedAt),
            "tracking" to counts(current.tracking, target.tracking, NyoraBackupTracking::id, NyoraBackupTracking::deletedAt),
        )
        val available = repository.availableBackupSourceIds()
        val unresolved = target.sources
            .asSequence()
            .filter { it.deletedAt == null && it.id !in available }
            .map { it.id }
            .sorted()
            .toList()
        return NyoraRestorePlan(
            mode = mode,
            archiveId = incoming.archiveId,
            createdAt = incoming.createdAt,
            platform = incoming.platform,
            sections = sections,
            unresolvedSources = unresolved,
            omissions = incoming.omissions,
            warnings = if (unresolved.isEmpty()) emptyList() else listOf(
                "Some sources are valid but unavailable in the current catalogue; their data will be retained.",
            ),
            preview = target,
        )
    }

    private fun merge(current: NyoraBackupSnapshot, incoming: NyoraBackupSnapshot): NyoraBackupSnapshot =
        incoming.copy(
            sources = mergeRows(current.sources, incoming.sources, NyoraBackupSource::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            categories = mergeRows(current.categories, incoming.categories, NyoraBackupCategory::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            preferences = mergeRows(current.preferences, incoming.preferences, NyoraBackupPreference::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            manga = mergeRows(current.manga, incoming.manga, NyoraBackupManga::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            chapters = mergeRows(current.chapters, incoming.chapters, NyoraBackupChapter::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            library = mergeRows(current.library, incoming.library, NyoraBackupLibrary::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            history = mergeRows(current.history, incoming.history, NyoraBackupHistory::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            bookmarks = mergeRows(current.bookmarks, incoming.bookmarks, NyoraBackupBookmark::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
            tracking = mergeRows(current.tracking, incoming.tracking, NyoraBackupTracking::id, { maxOf(it.updatedAt, it.deletedAt.orEmpty()) }, current.archiveId, incoming.archiveId),
        )

    private fun <T> mergeRows(
        current: List<T>,
        incoming: List<T>,
        id: (T) -> String,
        updatedAt: (T) -> String,
        currentArchiveId: String,
        incomingArchiveId: String,
    ): List<T> {
        val local = current.associateBy(id)
        val remote = incoming.associateBy(id)
        return (local.keys + remote.keys).sorted().map { key ->
            val left = local[key]
            val right = remote[key]
            when {
                left == null -> requireNotNull(right)
                right == null -> left
                updatedAt(right) > updatedAt(left) -> right
                updatedAt(right) < updatedAt(left) -> left
                incomingArchiveId > currentArchiveId -> right
                else -> left
            }
        }
    }

    private fun <T> counts(
        before: List<T>,
        after: List<T>,
        id: (T) -> String,
        deletedAt: (T) -> String?,
    ): NyoraRestoreSectionPlan {
        val old = before.associateBy(id)
        val new = after.associateBy(id)
        var additions = 0
        var updates = 0
        var deletions = 0
        var unchanged = 0
        for (key in old.keys + new.keys) {
            val left = old[key]
            val right = new[key]
            when {
                right == null -> deletions++
                left == null && deletedAt(right) != null -> deletions++
                left == null -> additions++
                left == right -> unchanged++
                deletedAt(right) != null && deletedAt(left) == null -> deletions++
                else -> updates++
            }
        }
        return NyoraRestoreSectionPlan(additions, updates, deletions, unchanged)
    }
}
