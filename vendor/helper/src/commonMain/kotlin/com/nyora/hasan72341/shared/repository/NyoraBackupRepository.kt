package com.nyora.hasan72341.shared.repository

import com.nyora.hasan72341.shared.backup.NyoraBackupSnapshot

/** Persistence boundary used by the portable backup adapter. */
interface NyoraBackupRepository {
    /** Returns a validated, canonical projection of all portable local data. */
    fun readBackupSnapshot(): NyoraBackupSnapshot

    /**
     * Observes and durably records portable changes before export. Planning must continue to use
     * [readBackupSnapshot], which is deliberately read-only.
     */
    fun reconcileBackupSnapshot(): NyoraBackupSnapshot = readBackupSnapshot()

    /** Catalogue source ids that this installation can currently open. */
    fun availableBackupSourceIds(): Set<String>

    /** Replaces the complete portable projection. Called only inside [inBackupTransaction]. */
    fun replaceBackupSnapshot(snapshot: NyoraBackupSnapshot)

    /** Runs [block] in one atomic database transaction or equivalent checkpoint transaction. */
    fun <T> inBackupTransaction(block: () -> T): T

    /** Suppresses outbound sync observers while a restore transaction is active. */
    fun setBackupSyncPaused(paused: Boolean)

    /** Reloads local state and schedules exactly one post-commit cloud reconciliation. */
    fun reconcileBackupRestore()
}
