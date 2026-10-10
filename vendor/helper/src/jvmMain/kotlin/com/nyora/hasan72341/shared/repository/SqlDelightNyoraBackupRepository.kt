package com.nyora.hasan72341.shared.repository

import com.nyora.hasan72341.shared.HelperProfile
import app.cash.sqldelight.db.QueryResult
import com.nyora.hasan72341.shared.backup.NyoraBackupBookmark
import com.nyora.hasan72341.shared.backup.NyoraBackupCategory
import com.nyora.hasan72341.shared.backup.NyoraBackupChapter
import com.nyora.hasan72341.shared.backup.NyoraBackupHistory
import com.nyora.hasan72341.shared.backup.NyoraBackupIdentity
import com.nyora.hasan72341.shared.backup.NyoraBackupLibrary
import com.nyora.hasan72341.shared.backup.NyoraBackupManga
import com.nyora.hasan72341.shared.backup.NyoraBackupPreference
import com.nyora.hasan72341.shared.backup.NyoraBackupSnapshot
import com.nyora.hasan72341.shared.backup.NyoraBackupSource
import com.nyora.hasan72341.shared.backup.NyoraBackupTracking
import com.nyora.hasan72341.shared.model.Manga
import com.nyora.hasan72341.shared.model.MangaChapter
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.MangaTag
import com.nyora.hasan72341.shared.model.SourceEngine
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** SQLDelight projection for the Nyora-owned portable backup contract. */
class SqlDelightNyoraBackupRepository(
    private val repository: SqlDelightLibraryRepository,
    private val observationClock: () -> Instant = Instant::now,
) : NyoraBackupRepository {
    private val json = Json { encodeDefaults = true; explicitNulls = false }

    init {
        ensureIdentityTables()
        cleanupRetiredMihonState()
    }

    override fun readBackupSnapshot(): NyoraBackupSnapshot = projectBackupSnapshot(observationTimestamp())

    override fun reconcileBackupSnapshot(): NyoraBackupSnapshot = repository.withBackupRestoreOperation {
        repository.database.transactionWithResult {
            val observedAt = observationTimestamp()
            val snapshot = projectBackupSnapshot(observedAt)
            persistLedger(snapshot)
            persistMaterializedSnapshot(
                readDatabaseSnapshot(snapshot.sources.mapTo(HashSet(), NyoraBackupSource::id)),
                observedAt,
            )
            snapshot
        }
    }

    private fun projectBackupSnapshot(observedAt: String): NyoraBackupSnapshot {
        val durable = readLedger()
        val database = readDatabaseSnapshot(durable?.sources?.mapTo(HashSet(), NyoraBackupSource::id).orEmpty())
        val materialized = readMaterializedSnapshot()
        val sources = overlayLiveRows<NyoraBackupSource>(
            durable?.sources.orEmpty(), database.sources, materialized.sources,
            NyoraBackupSource::id, NyoraBackupSource::updatedAt, NyoraBackupSource::deletedAt,
            { saved, live, clock ->
                live.copy(preferences = saved?.preferences.orEmpty(), updatedAt = clock)
            },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val categories = overlayLiveRows<NyoraBackupCategory>(
            durable?.categories.orEmpty(), database.categories, materialized.categories,
            NyoraBackupCategory::id, NyoraBackupCategory::updatedAt, NyoraBackupCategory::deletedAt,
            { _, live, clock -> live.copy(updatedAt = clock) },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val preferences = overlayLiveRows<NyoraBackupPreference>(
            durable?.preferences.orEmpty(), database.preferences, materialized.preferences,
            NyoraBackupPreference::id, NyoraBackupPreference::updatedAt, NyoraBackupPreference::deletedAt,
            { _, live, clock -> live.copy(updatedAt = clock) },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val manga = overlayLiveRows<NyoraBackupManga>(
            durable?.manga.orEmpty(), database.manga, materialized.manga,
            NyoraBackupManga::id, NyoraBackupManga::updatedAt, NyoraBackupManga::deletedAt,
            { _, live, clock -> live.copy(updatedAt = clock) },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val chapters = overlayLiveRows<NyoraBackupChapter>(
            durable?.chapters.orEmpty(), database.chapters, materialized.chapters,
            NyoraBackupChapter::id, NyoraBackupChapter::updatedAt, NyoraBackupChapter::deletedAt,
            { _, live, clock -> live.copy(updatedAt = clock) },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val library = overlayLiveRows<NyoraBackupLibrary>(
            durable?.library.orEmpty(), database.library, materialized.library,
            NyoraBackupLibrary::id, NyoraBackupLibrary::updatedAt, NyoraBackupLibrary::deletedAt,
            { saved, live, clock -> live.copy(updatePolicy = saved?.updatePolicy, updatedAt = clock) },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val history = overlayLiveRows<NyoraBackupHistory>(
            durable?.history.orEmpty(), database.history, materialized.history,
            NyoraBackupHistory::id, NyoraBackupHistory::updatedAt, NyoraBackupHistory::deletedAt,
            { saved, live, clock ->
                live.copy(readDurationSeconds = saved?.readDurationSeconds, updatedAt = clock)
            },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val bookmarks = overlayLiveRows<NyoraBackupBookmark>(
            durable?.bookmarks.orEmpty(), database.bookmarks, materialized.bookmarks,
            NyoraBackupBookmark::id, NyoraBackupBookmark::updatedAt, NyoraBackupBookmark::deletedAt,
            { _, live, clock -> live.copy(updatedAt = clock) },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        val trackingBaseline = alignLegacyTrackingBaseline(materialized.tracking, durable?.tracking.orEmpty())
        val trackingBaselineById = trackingBaseline.associateBy(NyoraBackupTracking::id)
        val tracking = overlayLiveRows<NyoraBackupTracking>(
            durable?.tracking.orEmpty(), database.tracking, trackingBaseline,
            NyoraBackupTracking::id, NyoraBackupTracking::updatedAt, NyoraBackupTracking::deletedAt,
            { saved, live, clock ->
                val before = trackingBaselineById[live.id]
                // Native non-null numeric defaults must not overwrite untouched portable nulls.
                live.copy(
                    progress = if (saved != null && before?.progress == live.progress) saved.progress else live.progress,
                    score = if (saved != null && before?.score == live.score) saved.score else live.score,
                    updatedAt = clock,
                )
            },
            { row, clock -> row.copy(updatedAt = clock) },
            { row, clock -> row.copy(deletedAt = tombstoneClock(row.updatedAt, row.deletedAt, clock)) },
            observedAt,
        )
        return (durable ?: database).copy(
            sources = sources,
            categories = categories,
            preferences = preferences,
            manga = manga,
            chapters = chapters,
            library = library,
            history = history,
            bookmarks = bookmarks,
            tracking = tracking,
        )
    }

    private fun readDatabaseSnapshot(retainedSourceIds: Set<String> = emptySet()): NyoraBackupSnapshot {
        val library = repository.load()
        val sources = library.sources
            .asSequence()
            .filter { it.isRuntimeAvailableForBackup() }
            .sortedBy { it.id }
            .map { source ->
                NyoraBackupSource(
                    id = source.id,
                    catalogueRevision = source.version,
                    installed = source.isInstalled,
                    pinned = source.isPinned,
                    updatedAt = iso(source.installedAt),
                )
            }
            .toList()
        val portableSourceIds = sources.mapTo(HashSet()) { it.id }.apply { addAll(retainedSourceIds) }
        val mangaClock = repository.database.mangaQueries.selectAll().executeAsList().associate { it.id to it.updated_at }
        val localToPortableManga = linkedMapOf<String, String>()
        val portableManga = mutableListOf<NyoraBackupManga>()
        val portableChapters = mutableListOf<NyoraBackupChapter>()
        val localChapterToPortable = mutableMapOf<Pair<String, String>, String>()
        for (manga in library.mangas.sortedBy { it.id }) {
            val encodedSourceId = when (val source = manga.source) {
                is MangaSourceRef.Script -> source.name
                is MangaSourceRef.Parser -> source.name
                else -> null
            }
            val sourceId = encodedSourceId?.takeIf { it in portableSourceIds }
                ?: continue
            val contentKey = manga.url.takeIf(String::isNotBlank) ?: continue
            val portableId = NyoraBackupIdentity.mangaId(sourceId, contentKey)
            localToPortableManga[manga.id] = portableId
            portableManga += NyoraBackupManga(
                id = portableId,
                sourceId = sourceId,
                contentKey = contentKey,
                title = manga.title,
                updatedAt = iso(mangaClock[manga.id] ?: 0L),
                description = manga.description.takeIf(String::isNotBlank),
                author = manga.authors.firstOrNull(),
                artist = manga.authors.drop(1).firstOrNull(),
                genres = manga.tags.map { it.title },
                coverUrl = manga.coverUrl.takeIf(String::isNotBlank),
            )
            for (chapter in manga.chapters) {
                val chapterKey = chapter.url.takeIf(String::isNotBlank) ?: chapter.id.takeIf(String::isNotBlank) ?: continue
                val chapterId = NyoraBackupIdentity.chapterId(portableId, chapterKey)
                localChapterToPortable[manga.id to chapter.id] = chapterId
                portableChapters += NyoraBackupChapter(
                    id = chapterId,
                    mangaId = portableId,
                    chapterKey = chapterKey,
                    name = chapter.title,
                    updatedAt = iso(chapter.uploadDate),
                    number = chapter.number.toDouble(),
                    uploadedAt = chapter.uploadDate.takeIf { it > 0 }?.let(::iso),
                )
            }
        }

        val categoriesByLocal = repository.categoriesForSync().associate { row ->
            row.id to NyoraBackupCategory(
                id = portableIdentity("nyora_backup_category_identity", row.id),
                title = row.title,
                sortOrder = row.sortKey.toInt(),
                updatedAt = iso(row.deletedAt ?: 0L),
                deletedAt = row.deletedAt?.let(::iso),
            )
        }
        val categoryLinks = repository.database.favouriteCategoryQueries.selectAllMangaCategories()
            .executeAsList()
            .groupBy({ it.manga_id }, { it.category_id })
        val favourites = repository.allFavouritesIncludingDeleted().mapNotNull { row ->
            val portableMangaId = localToPortableManga[row.manga_id] ?: return@mapNotNull null
            NyoraBackupLibrary(
                mangaId = portableMangaId,
                addedAt = iso(row.added_at),
                categoryIds = categoryLinks[row.manga_id].orEmpty().mapNotNull { categoriesByLocal[it]?.id }.sorted(),
                updatedAt = iso(row.updated_at),
                deletedAt = row.deleted_at?.let(::iso),
            )
        }
        val history = repository.allHistoryIncludingDeleted().mapNotNull { row ->
            val portableMangaId = localToPortableManga[row.manga_id] ?: return@mapNotNull null
            val portableChapterId = row.chapter_id.takeIf(String::isNotBlank)?.let {
                localChapterToPortable[row.manga_id to it]
            }
            NyoraBackupHistory(
                mangaId = portableMangaId,
                chapterId = portableChapterId,
                page = row.page.toInt(),
                percent = row.percent,
                updatedAt = iso(row.updated_at),
                deletedAt = row.deleted_at?.let(::iso),
            )
        }
        val bookmarks = repository.allBookmarksIncludingDeleted().mapNotNull { row ->
            val portableMangaId = localToPortableManga[row.manga_id] ?: return@mapNotNull null
            val portableChapterId = row.chapter_id.takeIf(String::isNotBlank)?.let {
                localChapterToPortable[row.manga_id to it]
            }
            NyoraBackupBookmark(
                id = portableIdentity("nyora_backup_bookmark_identity", row.id),
                mangaId = portableMangaId,
                chapterId = portableChapterId,
                page = row.page.toInt(),
                note = row.note.takeIf(String::isNotBlank),
                updatedAt = iso(row.updated_at),
                deletedAt = row.deleted_at?.let(::iso),
            )
        }
        val preferences = repository.database.mangaPrefsQueries.selectAll().executeAsList().mapNotNull { row ->
            val portableMangaId = localToPortableManga[row.manga_id] ?: return@mapNotNull null
            val key = "reader/$portableMangaId"
            NyoraBackupPreference(
                key = key,
                value = buildJsonObject {
                    put("readerMode", row.reader_mode)
                    put("brightness", row.brightness)
                    put("contrast", row.contrast)
                    put("saturation", row.saturation)
                    put("hue", row.hue)
                    put("palette", row.palette)
                },
                updatedAt = iso(row.updated_at),
            )
        }
        val retainedTracking = readRows("tracking", NyoraBackupTracking.serializer())
            .groupBy { it.service to it.mangaId }
        val tracking = repository.allTracking().mapNotNull { row ->
            val portableMangaId = localToPortableManga[row.mangaId] ?: return@mapNotNull null
            val service = row.trackerId.lowercase().replace(Regex("[^a-z0-9-]"), "-")
                .takeIf { it.matches(Regex("[a-z][a-z0-9-]*")) } ?: return@mapNotNull null
            NyoraBackupTracking(
                id = trackingPortableIdentity(row.trackerId, row.mangaId)
                    ?: retainedTracking[service to portableMangaId]?.singleOrNull()?.id
                    ?: "$service:$portableMangaId",
                mangaId = portableMangaId,
                service = service,
                status = row.status.lowercase().takeIf { it.matches(Regex("[a-z][a-z0-9-]*")) } ?: "planning",
                progress = row.lastReadChapter.toDouble(),
                score = row.score.toDouble(),
                updatedAt = normalizedIso(row.updatedAt),
                deletedAt = row.deletedAt.takeIf(String::isNotBlank)?.let(::normalizedIso),
            )
        }
        return NyoraBackupSnapshot(
            archiveId = ZERO_UUID,
            createdAt = EPOCH,
            appVersion = "repository",
            platform = "jvm",
            sources = sources,
            categories = categoriesByLocal.values.sortedBy { it.id },
            preferences = preferences.sortedBy { it.id },
            manga = portableManga.sortedBy { it.id },
            chapters = portableChapters.sortedBy { it.id },
            library = favourites.sortedBy { it.id },
            history = history.sortedBy { it.id },
            bookmarks = bookmarks.sortedBy { it.id },
            tracking = tracking.sortedBy { it.id },
        )
    }

    override fun availableBackupSourceIds(): Set<String> = repository.load().sources
        .asSequence()
        .filter { it.isRuntimeAvailableForBackup() }
        .map(MangaSource::id)
        .toSet()

    override fun replaceBackupSnapshot(snapshot: NyoraBackupSnapshot) {
        val existingSources = repository.load().sources.associateBy { it.id }
        repository.clearDatabase()
        repository.driver.execute(null, "DELETE FROM nyora_backup_tracking_identity", 0)
        val retainedSourceIds = snapshot.sources
            .asSequence()
            .filter { it.deletedAt == null }
            .mapTo(HashSet(), NyoraBackupSource::id)
        existingSources.values
            .asSequence()
            .filter { it.id.startsWith("data:") && (it.id !in retainedSourceIds || !it.isRuntimeAvailableForBackup()) }
            .forEach { repository.deleteSource(it.id) }
        for (source in snapshot.sources) {
            val current = existingSources[source.id]?.takeIf { it.isRuntimeAvailableForBackup() }
            if (source.deletedAt == null && current != null) {
                repository.upsertSource(
                    current.copy(
                    version = source.catalogueRevision,
                    isInstalled = source.installed,
                    isPinned = source.pinned,
                    engine = SourceEngine.JavaScript,
                    ),
                )
            }
        }
        val chaptersByManga = snapshot.chapters.filter { it.deletedAt == null }.groupBy { it.mangaId }
        for (manga in snapshot.manga.filter { it.deletedAt == null }) {
            repository.upsertManga(
                Manga(
                    id = manga.id,
                    title = manga.title,
                    url = manga.contentKey,
                    coverUrl = manga.coverUrl.orEmpty(),
                    authors = listOfNotNull(manga.author, manga.artist).distinct(),
                    tags = manga.genres.map { MangaTag(it, it) },
                    source = MangaSourceRef.Script(manga.sourceId),
                    description = manga.description.orEmpty(),
                    chapters = chaptersByManga[manga.id].orEmpty().map { chapter ->
                        MangaChapter(
                            id = chapter.id,
                            title = chapter.name,
                            number = chapter.number?.toFloat() ?: 0f,
                            url = chapter.chapterKey,
                            uploadDate = chapter.uploadedAt?.let(::millis) ?: 0L,
                        )
                    },
                ),
            )
        }
        val localCategories = mutableMapOf<String, Long>()
        for (category in snapshot.categories.filter { it.deletedAt == null }.sortedBy { it.sortOrder }) {
            val localId = repository.createCategory(category.title)
            savePortableIdentity("nyora_backup_category_identity", localId, category.id)
            localCategories[category.id] = localId
        }
        for (entry in snapshot.library.filter { it.deletedAt == null }) {
            if (!repository.isFavourited(entry.mangaId)) repository.toggleFavourite(entry.mangaId)
            entry.categoryIds.mapNotNull(localCategories::get).forEach { repository.addToCategory(entry.mangaId, it) }
        }
        val chapterNames = snapshot.chapters.associate { it.id to it.name }
        val mangaSources = snapshot.manga.associate { it.id to it.sourceId }
        for (checkpoint in snapshot.history.filter { it.deletedAt == null }) {
            repository.upsertHistoryFromSync(
                mangaId = checkpoint.mangaId,
                sourceId = mangaSources[checkpoint.mangaId].orEmpty(),
                chapterId = checkpoint.chapterId.orEmpty(),
                chapterTitle = checkpoint.chapterId?.let(chapterNames::get).orEmpty(),
                page = checkpoint.page ?: 0,
                scroll = 0.0,
                percent = checkpoint.percent?.toFloat() ?: 0f,
                chaptersCount = 0,
                updatedAt = checkpoint.updatedAt,
            )
        }
        for (bookmark in snapshot.bookmarks.filter { it.deletedAt == null }) {
            repository.addBookmark(
                bookmark.mangaId,
                bookmark.chapterId.orEmpty(),
                bookmark.chapterId?.let(chapterNames::get).orEmpty(),
                bookmark.page ?: 0,
                bookmark.note.orEmpty(),
            )
            repository.allBookmarksIncludingDeleted()
                .firstOrNull {
                    it.manga_id == bookmark.mangaId && it.chapter_id == bookmark.chapterId.orEmpty() &&
                        it.page == (bookmark.page ?: 0).toLong()
                }
                ?.let { savePortableIdentity("nyora_backup_bookmark_identity", it.id, bookmark.id) }
        }
        for (preference in snapshot.preferences.filter { it.deletedAt == null && it.key.startsWith("reader/") }) {
            val mangaId = preference.key.removePrefix("reader/")
            val value = runCatching { preference.value.jsonObject }.getOrNull() ?: continue
            repository.saveMangaPrefs(
                MangaPrefsRow(
                    mangaId = mangaId,
                    readerMode = value["readerMode"]?.jsonPrimitive?.content.orEmpty(),
                    brightness = value["brightness"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                    contrast = value["contrast"]?.jsonPrimitive?.doubleOrNull ?: 1.0,
                    saturation = value["saturation"]?.jsonPrimitive?.doubleOrNull ?: 1.0,
                    hue = value["hue"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                    palette = value["palette"]?.jsonPrimitive?.content.orEmpty(),
                ),
            )
        }
        for (tracking in snapshot.tracking) {
            repository.saveTracking(
                TrackingRow(
                    trackerId = tracking.service,
                    remoteId = "",
                    sourceId = mangaSources[tracking.mangaId].orEmpty(),
                    mangaId = tracking.mangaId,
                    title = snapshot.manga.firstOrNull { it.id == tracking.mangaId }?.title.orEmpty(),
                    status = tracking.status,
                    score = tracking.score?.toFloat() ?: 0f,
                    lastReadChapter = tracking.progress?.toFloat() ?: 0f,
                    lastReadVolume = 0,
                    totalChapters = 0,
                    totalVolumes = 0,
                    chapterOffset = 0,
                    startedAt = "",
                    finishedAt = "",
                    comment = "",
                    updatedAt = tracking.updatedAt,
                    deletedAt = tracking.deletedAt.orEmpty(),
                ),
            )
            saveTrackingPortableIdentity(tracking.service, tracking.mangaId, tracking.id)
        }
        persistLedger(snapshot)
        persistMaterializedSnapshot(
            readDatabaseSnapshot(snapshot.sources.mapTo(HashSet(), NyoraBackupSource::id)),
            observationTimestamp(),
        )
    }

    override fun <T> inBackupTransaction(block: () -> T): T =
        repository.withBackupRestoreOperation {
            repository.database.transactionWithResult { block() }
        }

    override fun setBackupSyncPaused(paused: Boolean) {
        repository.backupSyncPaused = paused
    }

    override fun reconcileBackupRestore() {
        repository.reconcileBackupRestore()
    }

    private fun ensureIdentityTables() {
        for (table in listOf("nyora_backup_category_identity", "nyora_backup_bookmark_identity")) {
            repository.driver.execute(
                null,
                "CREATE TABLE IF NOT EXISTS $table (local_id INTEGER PRIMARY KEY, portable_id TEXT NOT NULL UNIQUE)",
                0,
            )
        }
        repository.driver.execute(
            null,
            """
            CREATE TABLE IF NOT EXISTS nyora_backup_tracking_identity (
                tracker_id TEXT NOT NULL,
                manga_id TEXT NOT NULL,
                portable_id TEXT NOT NULL UNIQUE,
                PRIMARY KEY (tracker_id, manga_id)
            )
            """.trimIndent(),
            0,
        )
        repository.driver.execute(
            null,
            """
            CREATE TABLE IF NOT EXISTS nyora_backup_archive (
                singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
                schema_version INTEGER NOT NULL,
                archive_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                app_version TEXT NOT NULL,
                platform TEXT NOT NULL,
                mode TEXT NOT NULL,
                omissions_json TEXT NOT NULL
            )
            """.trimIndent(),
            0,
        )
        repository.driver.execute(
            null,
            """
            CREATE TABLE IF NOT EXISTS nyora_backup_row (
                section TEXT NOT NULL,
                row_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (section, row_id)
            )
            """.trimIndent(),
            0,
        )
        repository.driver.execute(
            null,
            """
            CREATE TABLE IF NOT EXISTS nyora_backup_materialized (
                section TEXT NOT NULL,
                row_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (section, row_id)
            )
            """.trimIndent(),
            0,
        )
        repository.driver.execute(
            null,
            "CREATE TABLE IF NOT EXISTS nyora_backup_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            0,
        )
    }

    /** Older materialization used a generated ID even when the imported row had an opaque ID. */
    private fun alignLegacyTrackingBaseline(
        baseline: List<NyoraBackupTracking>,
        retained: List<NyoraBackupTracking>,
    ): List<NyoraBackupTracking> {
        val byKey = retained.groupBy { it.service to it.mangaId }
        return baseline.map { row ->
            if (row.id != "${row.service}:${row.mangaId}") row
            else byKey[row.service to row.mangaId]?.singleOrNull()?.let { row.copy(id = it.id) } ?: row
        }
    }

    private fun trackingPortableIdentity(trackerId: String, mangaId: String): String? =
        repository.driver.executeQuery(
            identifier = null,
            sql = "SELECT portable_id FROM nyora_backup_tracking_identity WHERE tracker_id = ? AND manga_id = ?",
            mapper = { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null) },
            parameters = 2,
            binders = { bindString(0, trackerId); bindString(1, mangaId) },
        ).value

    private fun saveTrackingPortableIdentity(trackerId: String, mangaId: String, portableId: String) {
        repository.driver.execute(
            null,
            "INSERT OR REPLACE INTO nyora_backup_tracking_identity(tracker_id, manga_id, portable_id) VALUES (?, ?, ?)",
            3,
        ) {
            bindString(0, trackerId)
            bindString(1, mangaId)
            bindString(2, portableId)
        }
    }

    private fun <T> overlayLiveRows(
        durable: List<T>,
        database: List<T>,
        materialized: List<T>,
        id: (T) -> String,
        updatedAt: (T) -> String,
        deletedAt: (T) -> String?,
        mergeObservedLive: (T?, T, String) -> T,
        observeNew: (T, String) -> T,
        asTombstone: (T, String) -> T,
        observedAt: String,
    ): List<T> {
        val saved = durable.associateBy(id)
        val live = database.associateBy(id)
        val baseline = materialized.associateBy(id)
        return (saved.keys + live.keys + baseline.keys).sorted().map { key ->
            val previous = saved[key]
            val current = live[key]
            val materializedRow = baseline[key]
            when {
                previous == null -> observeNew(
                    requireNotNull(current),
                    observedLiveClock(updatedAt(current), deletedAt(current), observedAt),
                )
                current == materializedRow -> previous
                current == null && materializedRow != null -> asTombstone(previous, observedAt)
                current == null -> previous
                materializedRow != null -> mergeObservedLive(
                    previous,
                    current,
                    // A structural edit without a native clock change is dated when observed.
                    // The baseline clock may be a wall-clock artifact of materialization.
                    if (effectiveClock(updatedAt(current), deletedAt(current)) ==
                        effectiveClock(updatedAt(materializedRow), deletedAt(materializedRow))) {
                        observedAt
                    } else {
                        observedLiveClock(updatedAt(current), deletedAt(current), observedAt)
                    },
                )
                effectiveClock(updatedAt(current), deletedAt(current)) >
                    effectiveClock(updatedAt(previous), deletedAt(previous)) -> mergeObservedLive(
                    previous,
                    current,
                    observedLiveClock(updatedAt(current), deletedAt(current), observedAt),
                )
                else -> previous
            }
        }
    }

    private fun effectiveClock(updatedAt: String, deletedAt: String?): String = sequenceOf(updatedAt, deletedAt)
        .filterNotNull()
        .mapNotNull(::validTimestamp)
        .maxOrNull()
        ?: EPOCH

    private fun observedLiveClock(updatedAt: String, deletedAt: String?, observedAt: String): String =
        maxOf(effectiveClock(updatedAt, deletedAt), observedAt)

    private fun validTimestamp(value: String): String? = runCatching {
        TIMESTAMP.format(Instant.parse(value))
    }.getOrNull()

    private fun tombstoneClock(updatedAt: String, deletedAt: String?, materializedAt: String): String =
        maxOf(effectiveClock(updatedAt, deletedAt), materializedAt)

    private fun persistLedger(snapshot: NyoraBackupSnapshot) {
        repository.driver.execute(null, "DELETE FROM nyora_backup_row", 0)
        repository.driver.execute(
            null,
            """
            INSERT OR REPLACE INTO nyora_backup_archive(
                singleton, schema_version, archive_id, created_at, app_version, platform, mode, omissions_json
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            7,
        ) {
            bindLong(0, snapshot.schemaVersion.toLong())
            bindString(1, snapshot.archiveId)
            bindString(2, snapshot.createdAt)
            bindString(3, snapshot.appVersion)
            bindString(4, snapshot.platform)
            bindString(5, snapshot.mode)
            bindString(6, json.encodeToString(MapSerializer(String.serializer(), Int.serializer()), snapshot.omissions))
        }
        writeRows("sources", snapshot.sources, NyoraBackupSource::id, NyoraBackupSource.serializer())
        writeRows("categories", snapshot.categories, NyoraBackupCategory::id, NyoraBackupCategory.serializer())
        writeRows("preferences", snapshot.preferences, NyoraBackupPreference::id, NyoraBackupPreference.serializer())
        writeRows("manga", snapshot.manga, NyoraBackupManga::id, NyoraBackupManga.serializer())
        writeRows("chapters", snapshot.chapters, NyoraBackupChapter::id, NyoraBackupChapter.serializer())
        writeRows("library", snapshot.library, NyoraBackupLibrary::id, NyoraBackupLibrary.serializer())
        writeRows("history", snapshot.history, NyoraBackupHistory::id, NyoraBackupHistory.serializer())
        writeRows("bookmarks", snapshot.bookmarks, NyoraBackupBookmark::id, NyoraBackupBookmark.serializer())
        writeRows("tracking", snapshot.tracking, NyoraBackupTracking::id, NyoraBackupTracking.serializer())
    }

    private fun persistMaterializedSnapshot(snapshot: NyoraBackupSnapshot, materializedAt: String) {
        repository.driver.execute(null, "DELETE FROM nyora_backup_materialized", 0)
        writeRows("sources", snapshot.sources, NyoraBackupSource::id, NyoraBackupSource.serializer(), "nyora_backup_materialized")
        writeRows("categories", snapshot.categories, NyoraBackupCategory::id, NyoraBackupCategory.serializer(), "nyora_backup_materialized")
        writeRows("preferences", snapshot.preferences, NyoraBackupPreference::id, NyoraBackupPreference.serializer(), "nyora_backup_materialized")
        writeRows("manga", snapshot.manga, NyoraBackupManga::id, NyoraBackupManga.serializer(), "nyora_backup_materialized")
        writeRows("chapters", snapshot.chapters, NyoraBackupChapter::id, NyoraBackupChapter.serializer(), "nyora_backup_materialized")
        writeRows("library", snapshot.library, NyoraBackupLibrary::id, NyoraBackupLibrary.serializer(), "nyora_backup_materialized")
        writeRows("history", snapshot.history, NyoraBackupHistory::id, NyoraBackupHistory.serializer(), "nyora_backup_materialized")
        writeRows("bookmarks", snapshot.bookmarks, NyoraBackupBookmark::id, NyoraBackupBookmark.serializer(), "nyora_backup_materialized")
        writeRows("tracking", snapshot.tracking, NyoraBackupTracking::id, NyoraBackupTracking.serializer(), "nyora_backup_materialized")
        repository.driver.execute(
            null,
            "INSERT OR REPLACE INTO nyora_backup_metadata(key, value) VALUES (?, ?)",
            2,
        ) {
            bindString(0, MATERIALIZED_AT)
            bindString(1, materializedAt)
        }
    }

    private fun <T> writeRows(
        section: String,
        rows: List<T>,
        id: (T) -> String,
        serializer: KSerializer<T>,
        table: String = "nyora_backup_row",
    ) {
        for (row in rows) {
            repository.driver.execute(
                null,
                "INSERT INTO $table(section, row_id, payload) VALUES (?, ?, ?)",
                3,
            ) {
                bindString(0, section)
                bindString(1, id(row))
                bindString(2, json.encodeToString(serializer, row))
            }
        }
    }

    private fun readLedger(): NyoraBackupSnapshot? {
        val header = repository.driver.executeQuery(
            identifier = null,
            sql = "SELECT schema_version, archive_id, created_at, app_version, platform, mode, omissions_json FROM nyora_backup_archive WHERE singleton = 1",
            mapper = { cursor ->
                QueryResult.Value(
                    if (cursor.next().value) {
                        LedgerHeader(
                            schemaVersion = cursor.getLong(0)?.toInt() ?: 0,
                            archiveId = cursor.getString(1).orEmpty(),
                            createdAt = cursor.getString(2).orEmpty(),
                            appVersion = cursor.getString(3).orEmpty(),
                            platform = cursor.getString(4).orEmpty(),
                            mode = cursor.getString(5).orEmpty(),
                            omissions = cursor.getString(6) ?: "{}",
                        )
                    } else {
                        null
                    },
                )
            },
            parameters = 0,
        ).value ?: return null
        return NyoraBackupSnapshot(
            schemaVersion = header.schemaVersion,
            archiveId = header.archiveId,
            createdAt = header.createdAt,
            appVersion = header.appVersion,
            platform = header.platform,
            mode = header.mode,
            sources = readRows("sources", NyoraBackupSource.serializer()),
            categories = readRows("categories", NyoraBackupCategory.serializer()),
            preferences = readRows("preferences", NyoraBackupPreference.serializer()),
            manga = readRows("manga", NyoraBackupManga.serializer()),
            chapters = readRows("chapters", NyoraBackupChapter.serializer()),
            library = readRows("library", NyoraBackupLibrary.serializer()),
            history = readRows("history", NyoraBackupHistory.serializer()),
            bookmarks = readRows("bookmarks", NyoraBackupBookmark.serializer()),
            tracking = readRows("tracking", NyoraBackupTracking.serializer()),
            omissions = json.decodeFromString(
                MapSerializer(String.serializer(), Int.serializer()),
                header.omissions,
            ),
        )
    }

    private fun <T> readRows(section: String, serializer: KSerializer<T>): List<T> =
        readRows("nyora_backup_row", section, serializer)

    private fun <T> readRows(table: String, section: String, serializer: KSerializer<T>): List<T> =
        repository.driver.executeQuery(
            identifier = null,
            sql = "SELECT payload FROM $table WHERE section = ? ORDER BY row_id",
            mapper = { cursor ->
                QueryResult.Value(buildList {
                    while (cursor.next().value) {
                        cursor.getString(0)?.let { add(json.decodeFromString(serializer, it)) }
                    }
                })
            },
            parameters = 1,
            binders = { bindString(0, section) },
        ).value

    private fun readMaterializedSnapshot(): NyoraBackupSnapshot = NyoraBackupSnapshot(
        archiveId = ZERO_UUID,
        createdAt = EPOCH,
        appVersion = "materialized",
        platform = "jvm",
        sources = readRows("nyora_backup_materialized", "sources", NyoraBackupSource.serializer()),
        categories = readRows("nyora_backup_materialized", "categories", NyoraBackupCategory.serializer()),
        preferences = readRows("nyora_backup_materialized", "preferences", NyoraBackupPreference.serializer()),
        manga = readRows("nyora_backup_materialized", "manga", NyoraBackupManga.serializer()),
        chapters = readRows("nyora_backup_materialized", "chapters", NyoraBackupChapter.serializer()),
        library = readRows("nyora_backup_materialized", "library", NyoraBackupLibrary.serializer()),
        history = readRows("nyora_backup_materialized", "history", NyoraBackupHistory.serializer()),
        bookmarks = readRows("nyora_backup_materialized", "bookmarks", NyoraBackupBookmark.serializer()),
        tracking = readRows("nyora_backup_materialized", "tracking", NyoraBackupTracking.serializer()),
    )

    private data class LedgerHeader(
        val schemaVersion: Int,
        val archiveId: String,
        val createdAt: String,
        val appVersion: String,
        val platform: String,
        val mode: String,
        val omissions: String,
    )

    private fun cleanupRetiredMihonState() {
        if (queryMetadata(CLEANUP_MARKER) != null) return
        repository.database.transaction {
            val retiredManga = "SELECT id FROM manga WHERE source_ref LIKE '%MIHON_%' OR source_ref LIKE '%mihon:%'"
            for (table in listOf(
                "manga_favourite_category", "manga_favourite", "manga_history", "bookmark",
                "manga_prefs", "manga_update", "tracking",
            )) {
                repository.driver.execute(
                    null,
                    "DELETE FROM $table WHERE manga_id IN ($retiredManga)",
                    0,
                )
            }
            repository.driver.execute(
                null,
                "DELETE FROM manga WHERE source_ref LIKE '%MIHON_%' OR source_ref LIKE '%mihon:%'",
                0,
            )
            repository.driver.execute(
                null,
                "DELETE FROM manga_source WHERE engine = 'Mihon' OR id LIKE 'mihon:%' OR id LIKE 'MIHON_%'",
                0,
            )
            repository.driver.execute(
                null,
                "DELETE FROM favourite_category WHERE title = 'Missing Source' AND id NOT IN (SELECT category_id FROM manga_favourite_category)",
                0,
            )
        }
        repository.dbPath.parent?.resolve("mihon-resolve-queue.json")?.let { Files.deleteIfExists(HelperProfile.confine(it)) }
        repository.driver.execute(
            null,
            "INSERT OR REPLACE INTO nyora_backup_metadata(key, value) VALUES (?, ?)",
            2,
        ) {
            bindString(0, CLEANUP_MARKER)
            bindString(1, "complete")
        }
    }

    private fun portableIdentity(table: String, localId: Long): String {
        val current = queryString("SELECT portable_id FROM $table WHERE local_id = ?", localId)
        if (current != null) return current
        return UUID.nameUUIDFromBytes("$table:$localId".toByteArray(StandardCharsets.UTF_8)).toString()
    }

    private fun savePortableIdentity(table: String, localId: Long, portableId: String) {
        repository.driver.execute(
            null,
            "INSERT OR REPLACE INTO $table(local_id, portable_id) VALUES (?, ?)",
            2,
        ) {
            bindLong(0, localId)
            bindString(1, portableId)
        }
    }

    private fun queryString(sql: String, localId: Long): String? = repository.driver.executeQuery(
        identifier = null,
        sql = sql,
        mapper = { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null) },
        parameters = 1,
        binders = { bindLong(0, localId) },
    ).value

    private fun queryMetadata(key: String): String? = repository.driver.executeQuery(
        identifier = null,
        sql = "SELECT value FROM nyora_backup_metadata WHERE key = ?",
        mapper = { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null) },
        parameters = 1,
        binders = { bindString(0, key) },
    ).value

    private fun MangaSource.isRuntimeAvailableForBackup(): Boolean =
        id.startsWith("data:") &&
            (baseUrl.isNotBlank() || packageName.isNotBlank() || sourceCodeUrl.isNotBlank() || localPath.isNotBlank())

    private fun iso(value: Long): String = TIMESTAMP.format(Instant.ofEpochMilli(value.coerceAtLeast(0L)))
    private fun observationTimestamp(): String = TIMESTAMP.format(observationClock())
    private fun normalizedIso(value: String): String = runCatching { TIMESTAMP.format(Instant.parse(value)) }.getOrDefault(EPOCH)
    private fun millis(value: String): Long = runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(0L)

    private companion object {
        const val ZERO_UUID = "00000000-0000-0000-0000-000000000000"
        const val EPOCH = "1970-01-01T00:00:00.000Z"
        const val CLEANUP_MARKER = "retired-mihon-cleanup-v1"
        const val MATERIALIZED_AT = "portable-materialized-at"
        val TIMESTAMP = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    }
}
