package com.nyora.hasan72341.shared.backup

import com.nyora.hasan72341.shared.repository.NyoraBackupRepository
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

class NyoraBackupExporter(
    private val repository: NyoraBackupRepository,
    private val appVersion: String,
    private val platform: String,
    private val now: () -> Instant = Instant::now,
    private val newArchiveId: () -> UUID = UUID::randomUUID,
) {
    fun snapshot(): NyoraBackupSnapshot = repository.reconcileBackupSnapshot().copy(
        schemaVersion = NyoraBackupSnapshot.SCHEMA_VERSION,
        archiveId = newArchiveId().toString().lowercase(),
        createdAt = TIMESTAMP.format(now()),
        appVersion = appVersion,
        platform = platform,
        mode = NyoraBackupSnapshot.MODE_PORTABLE_DATA,
    )

    fun export(): ByteArray = NyoraBackupCodec.encode(snapshot())

    private companion object {
        val TIMESTAMP = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    }
}
