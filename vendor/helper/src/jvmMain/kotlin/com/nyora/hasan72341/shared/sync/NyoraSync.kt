package com.nyora.hasan72341.shared.sync

import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.model.MangaSourceRef
import com.nyora.hasan72341.shared.model.MangaSourceRefCodec
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.extension.canonicalLegacyMangaUrl
import com.nyora.hasan72341.shared.extension.canonicalDataSourceId
import com.nyora.hasan72341.shared.extension.DataDrivenCatalog
import com.nyora.hasan72341.shared.extension.legacyMangaId
import com.nyora.hasan72341.shared.extension.legacyParserSourceName
import com.nyora.hasan72341.shared.extension.mangaIdRemapSourceName
import com.nyora.hasan72341.shared.extension.normalizedMangaSourceRef
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.nio.file.Path
import java.time.Instant

/**
 * Pushes / pulls Nyora library data through the nyora-sync Nyora Sync Edge Function.
 *
 * Sync strategy: push-then-pull, last-write-wins via updated_at.
 * Call [syncAll] on a background thread (it blocks on HTTP).
 *
 * NOT synced (local-only): manga_source (install state), chapter_pages (cache).
 *
 * Platforms covered: mac, linux, windows, web — all share this jvmMain module.
 */
class NyoraSync(
    private val repo: SqlDelightLibraryRepository,
    private val dataDir: Path,
    private val http: OkHttpClient = OkHttpClient(),
) {
    init { HelperProfile.confine(dataDir) }

    private val JSON_MT = "application/json; charset=utf-8".toMediaType()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val syncFunctionUrl get() = "${NyoraSyncConfig.url}/functions/v1/nyora-sync"
    private val INITIAL_SYNC_TIMESTAMP = "1970-01-01T00:00:00Z"
    private var pulledMangaRows: Map<String, SbManga> = emptyMap()
    private var pulledMangaSourceNames: Map<String, String> = emptyMap()
    private var pulledMangaIdAliases: Map<String, String> = emptyMap()

    private fun debug(msg: String) {
        val logFile = HelperProfile.confine(dataDir.resolve("auth_debug.log"))
        val text = "[${java.time.Instant.now()}] $msg\n"
        runCatching {
            java.nio.file.Files.write(logFile, text.toByteArray(), java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND)
        }
    }

    // ── Auth ────────────────────────────────────────────────────────────────

    private fun applyAuth(text: String) {
        val r = json.decodeFromString<AuthResponse>(text)
        val previousUserId = NyoraSyncConfig.userId
        val newUserId = NyoraSyncConfig.parseUserIdFromJwt(r.access_token)
        val parsedEmail = NyoraSyncConfig.parseEmailFromJwt(r.access_token)
        NyoraSyncConfig.accessToken = r.access_token
        NyoraSyncConfig.refreshToken = r.refresh_token ?: ""
        NyoraSyncConfig.userId = newUserId
        if (parsedEmail.isNotBlank()) NyoraSyncConfig.email = parsedEmail
        if (previousUserId.isNotBlank() && previousUserId != newUserId) {
            NyoraSyncConfig.lastSyncTimestamp = INITIAL_SYNC_TIMESTAMP
        }
        NyoraSyncConfig.saveTokens(dataDir)
    }

    /** OAuth2 password grant (form-encoded) → POST /auth/token. */
    fun signIn(email: String, password: String): Result<Unit> {
        if (!NyoraSyncConfig.isConfigured) return Result.failure(IllegalStateException("Sync server not configured"))
        val body = okhttp3.FormBody.Builder()
            .add("grant_type", "password")
            .add("username", email.trim())
            .add("password", password)
            .build()
        val req = Request.Builder().url("${NyoraSyncConfig.url}/auth/token").post(body).build()
        return runCatching {
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: error("Empty body")
                check(resp.isSuccessful) { "Sign-in failed ${resp.code}: $text" }
                applyAuth(text)
                // Nyora Sync's JWT carries only `sub` (no email claim), so persist the address
                // the user actually signed in with for display.
                NyoraSyncConfig.email = email.trim()
                NyoraSyncConfig.saveTokens(dataDir)
            }
        }
    }

    /** Create an account → POST /auth/register {email,password}; returns tokens on success. */
    fun register(email: String, password: String): Result<Unit> {
        if (!NyoraSyncConfig.isConfigured) return Result.failure(IllegalStateException("Sync server not configured"))
        val body = json.encodeToString(mapOf("email" to email.trim(), "password" to password)).toRequestBody(JSON_MT)
        val req = Request.Builder().url("${NyoraSyncConfig.url}/auth/register").post(body).build()
        return runCatching {
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: error("Empty body")
                check(resp.isSuccessful) { "Registration failed ${resp.code}: $text" }
                applyAuth(text)
                NyoraSyncConfig.email = email.trim()
                NyoraSyncConfig.saveTokens(dataDir)
            }
        }
    }

    fun refreshToken(): Boolean {
        if (!NyoraSyncConfig.isConfigured || NyoraSyncConfig.refreshToken.isBlank()) return false
        return runCatching {
            val body = okhttp3.FormBody.Builder()
                .add("grant_type", "refresh_token")
                .add("refresh_token", NyoraSyncConfig.refreshToken)
                .build()
            val req = Request.Builder().url("${NyoraSyncConfig.url}/auth/token").post(body).build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string() ?: return@use false
                if (!resp.isSuccessful) return@use false
                applyAuth(text)
                true
            }
        }.getOrDefault(false)
    }

    fun signOut() {
        NyoraSyncConfig.clearTokens(dataDir)
    }

    // ── Push ────────────────────────────────────────────────────────────────

    fun syncNow() = repo.withSyncOperation {
        if (!NyoraSyncConfig.isAuthenticated) return@withSyncOperation
        check(refreshToken()) { "Nyora Sync session expired. Sign in again." }
        val isBootstrap = NyoraSyncConfig.lastSyncTimestamp == INITIAL_SYNC_TIMESTAMP
        val cutoff = if (isBootstrap) 0L else Instant.parse(NyoraSyncConfig.lastSyncTimestamp).toEpochMilli()
        pushAll(cutoff)
        pullAll(if (isBootstrap) INITIAL_SYNC_TIMESTAMP else NyoraSyncConfig.lastSyncTimestamp)
    }

    fun restoreFromCloud() = repo.withSyncOperation {
        if (!NyoraSyncConfig.isAuthenticated) return@withSyncOperation
        check(refreshToken()) { "Nyora Sync session expired. Sign in again." }
        // Replacing local data is atomic: an interrupted/invalid cloud response must roll
        // the deletion back instead of leaving the user's offline library half-restored.
        repo.database.transaction {
            repo.clearDatabase()
            pullAll(INITIAL_SYNC_TIMESTAMP)
        }
    }

    /** Push all library tables to Nyora Sync. Runs on the caller's thread — use a background executor. */
    fun pushAll() = repo.withSyncOperation {
        if (!NyoraSyncConfig.isAuthenticated) return@withSyncOperation
        val cutoff = if (NyoraSyncConfig.lastSyncTimestamp == INITIAL_SYNC_TIMESTAMP) 0L 
                    else Instant.parse(NyoraSyncConfig.lastSyncTimestamp).toEpochMilli()
        pushAll(cutoff)
    }

    private fun pushAll(cutoff: Long) {
        pushFavourites(cutoff)
        pushHistory(cutoff)
        pushBookmarks(cutoff)
        pushMangaPrefs()
        pushCategories()
        pushMangaCategories()
        pushUpdates(cutoff)
        pushSourcePrefs()
        pushTracking(cutoff)
    }

    private fun pushFavourites(cutoff: Long) {
        val favs = repo.allFavouritesIncludingDeleted()
        if (favs.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = mutableListOf<SbFavourite>()
        val mangaRows = mutableListOf<SbManga>()
        val mangas = repo.load().mangas.associateBy { it.id }
        for (f in favs) {
            if (f.added_at <= cutoff && (f.deleted_at ?: 0L) <= cutoff) continue
            rows += SbFavourite(
                user_id = uid, 
                manga_id = f.manga_id,
                sort_key = f.sort_key.toInt(),
                deleted_at = f.deleted_at?.let { Instant.ofEpochMilli(it).toString() },
                updated_at = now
            )
            mangas[f.manga_id]?.toRemoteManga(uid, now)?.let { mangaRows += it }
        }
        if (rows.isEmpty()) return
        upsert("nyora_manga", mangaRows.distinctBy { it.id })
        upsert("nyora_favourite", rows)
    }

    // ── Cross-platform source_id normalization ───────────────────────────────
    // Desktop namespaces parser sources locally as "parser:<NAME>", but the sync
    // wire format is the BARE enum name <NAME> — matching Android and the already-
    // unified `source_ref` JSON ({"name":"<NAME>"}). Strip "parser:" when writing,
    // re-add it on read. Other source types (local:/script:) keep their prefix.
    private fun String.toWireSourceId(): String = canonicalWireSourceId(this)

    private fun String.fromWireSourceId(): String = localSourceIdFromWire(this)

    private fun pushHistory(cutoff: Long) {
        val history = repo.allHistoryIncludingDeleted()
        if (history.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = mutableListOf<SbHistory>()
        val mangaRows = mutableListOf<SbManga>()
        val mangas = repo.load().mangas.associateBy { it.id }
        for (h in history) {
            if (h.updated_at <= cutoff && (h.deleted_at ?: 0L) <= cutoff) continue
            val updatedAt = Instant.ofEpochMilli(h.updated_at).toString()
            rows += SbHistory(
                user_id = uid, manga_id = h.manga_id,
                source_id = h.source_id.toWireSourceId(), chapter_id = h.chapter_id,
                chapter_title = h.chapter_title, page = h.page.toInt(),
                percent = h.percent.toDouble(),
                updated_at = updatedAt,
                deleted_at = h.deleted_at?.let { Instant.ofEpochMilli(it).toString() }
            )
            mangas[h.manga_id]?.toRemoteManga(uid, updatedAt)?.let { mangaRows += it }
        }
        if (rows.isEmpty()) return
        upsert("nyora_manga", mangaRows.distinctBy { it.id })
        upsert("nyora_history", rows)
    }

    private fun pushBookmarks(cutoff: Long) {
        val bookmarks = repo.allBookmarksIncludingDeleted()
        if (bookmarks.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = mutableListOf<SbBookmark>()
        for (b in bookmarks) {
            if (b.created_at <= cutoff && (b.deleted_at ?: 0L) <= cutoff) continue
            rows += SbBookmark(
                user_id = uid,
                id = "${b.manga_id}:${b.chapter_id}:${b.page}",
                manga_id = b.manga_id, chapter_id = b.chapter_id,
                chapter_title = b.chapter_title, page = b.page.toInt(),
                note = b.note,
                created_at = Instant.ofEpochMilli(b.created_at).toString(),
                updated_at = now,
                deleted_at = b.deleted_at?.let { Instant.ofEpochMilli(it).toString() }
            )
        }
        if (rows.isEmpty()) return
        upsert("nyora_bookmark", rows)
    }

    private fun pushMangaPrefs() {
        val prefs = repo.allMangaPrefs()
        if (prefs.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = prefs.map { p ->
            SbMangaPrefs(
                user_id = uid,
                manga_id = p.mangaId,
                reader_mode = p.readerMode,
                brightness = p.brightness,
                contrast = p.contrast,
                saturation = p.saturation,
                hue = p.hue,
                palette = p.palette,
                updated_at = now
            )
        }
        upsert("nyora_manga_prefs", rows)
    }

    private fun pushCategories() {
        // Include soft-deleted categories so deletions (e.g. duplicate cleanup) propagate.
        val cats = repo.categoriesForSync()
        if (cats.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = cats.map { c ->
            SbCategory(
                user_id = uid,
                id = c.id.toString(),
                title = c.title,
                sort_key = c.sortKey.toInt(),
                updated_at = now,
                deleted_at = c.deletedAt?.let { Instant.ofEpochMilli(it).toString() },
            )
        }
        upsert("nyora_category", rows)
    }

    private fun pushMangaCategories() {
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = repo.database.favouriteCategoryQueries.selectAllMangaCategories().executeAsList().map { 
            SbMangaCategory(user_id = uid, manga_id = it.manga_id, category_id = it.category_id.toString(), updated_at = now)
        }
        if (rows.isEmpty()) return
        upsert("nyora_manga_category", rows)
    }

    private fun pushUpdates(cutoff: Long) {
        val updates = repo.allUpdatesIncludingDeleted()
        if (updates.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = mutableListOf<SbUpdate>()
        for (u in updates) {
            if (u.last_synced_at <= cutoff) continue
            rows += SbUpdate(
                user_id = uid, manga_id = u.manga_id, source_id = u.source_id.toWireSourceId(),
                last_chapter_count = u.last_chapter_count.toInt(), 
                new_chapters_count = u.new_chapters_count.toInt(),
                latest_chapter_title = u.latest_chapter_title,
                last_synced_at = Instant.ofEpochMilli(u.last_synced_at).toString(),
                updated_at = now
            )
        }
        if (rows.isEmpty()) return
        upsert("nyora_update", rows)
    }

    private fun pushSourcePrefs() {
        val uid = NyoraSyncConfig.userId
        val sources = repo.database.mangaSourceQueries.selectAll().executeAsList()
        if (sources.isEmpty()) return
        val now = Instant.now().toString()
        val rows = canonicalSourcePreferences(
            sources.map { source ->
                CanonicalSourcePreferenceCandidate(
                    localSourceId = source.id,
                    isPinned = source.is_pinned != 0L,
                    isEnabled = source.is_installed != 0L,
                )
            },
        ).map { source ->
            SbSourcePref(
                user_id = uid,
                source_id = source.wireSourceId,
                is_pinned = source.isPinned,
                // Mirror the web: is_enabled == "this source is in the user's installed set".
                // (Was hardcoded true, which pushed every source as installed.)
                is_enabled = source.isEnabled,
                updated_at = now
            )
        }
        upsert("nyora_source_prefs", rows)
    }

    /** Parse an ISO-8601 timestamp to epoch millis; blank/unparseable → 0. */
    private fun isoToMillis(iso: String?): Long {
        if (iso.isNullOrBlank()) return 0L
        return runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)
    }

    private fun pushTracking(cutoff: Long) {
        // allTracking() includes tombstoned rows so soft-deletes propagate.
        val tracking = repo.allTracking()
        if (tracking.isEmpty()) return
        val uid = NyoraSyncConfig.userId
        val now = Instant.now().toString()
        val rows = mutableListOf<SbTracking>()
        for (t in tracking) {
            val updatedMillis = isoToMillis(t.updatedAt)
            val deletedMillis = isoToMillis(t.deletedAt)
            if (updatedMillis <= cutoff && deletedMillis <= cutoff) continue
            rows += SbTracking(
                user_id = uid,
                tracker_id = t.trackerId,
                manga_id = t.mangaId,
                remote_id = t.remoteId,
                source_id = t.sourceId.toWireSourceId(),
                title = t.title,
                status = t.status,
                score = t.score.toDouble(),
                last_read_chapter = t.lastReadChapter.toDouble(),
                last_read_volume = t.lastReadVolume,
                total_chapters = t.totalChapters,
                total_volumes = t.totalVolumes,
                chapter_offset = t.chapterOffset,
                started_at = t.startedAt,
                finished_at = t.finishedAt,
                comment = t.comment,
                updated_at = t.updatedAt.ifBlank { now },
                deleted_at = t.deletedAt.ifBlank { null },
            )
        }
        if (rows.isEmpty()) return
        upsert("nyora_tracking", rows)
    }

    // ── Pull ────────────────────────────────────────────────────────────────

    /** Pull all library tables from Nyora Sync and apply locally. */
    fun pullAll() = repo.withSyncOperation {
        if (!NyoraSyncConfig.isAuthenticated) return@withSyncOperation
        pullAll(NyoraSyncConfig.lastSyncTimestamp)
    }

    private fun pullAll(cutoff: String) {
        debug("Starting cloud pull. cutoff=$cutoff")
        pullManga()
        pullFavourites(cutoff)
        pullHistory(cutoff)
        pullBookmarks(cutoff)
        pullCategories(cutoff)
        pullMangaCategories(cutoff)
        pullMangaPrefs(cutoff)
        pullUpdates(cutoff)
        pullSourcePrefs(cutoff)
        pullTracking(cutoff)
        NyoraSyncConfig.lastSyncTimestamp = Instant.now().toString()
        NyoraSyncConfig.saveTokens(dataDir)
        debug(
            "Cloud pull complete. manga=${repo.load().mangas.size} " +
                "history=${repo.allHistoryIncludingDeleted().size} " +
                "favourites=${repo.allFavouritesIncludingDeleted().size}"
        )
    }

    private fun pullManga() {
        // Always fetch parent manga rows. An old client can update only a history/bookmark row;
        // the complete parent set supplies the durable legacy-id -> canonical-id map for it.
        val text = fetch("nyora_manga")
        runCatching {
            val remoteRows = json.decodeFromString<List<SbManga>>(text)
            val aliases = LinkedHashMap<String, String>(remoteRows.size)
            val normalizedRows = remoteRows.map { row ->
                val sourceRef = normalizedMangaSourceRef(row.source_ref)
                val legacySourceName = mangaIdRemapSourceName(sourceRef)
                val canonicalUrl = legacySourceName?.let { canonicalLegacyMangaUrl(it, row.url) } ?: row.url
                val canonicalId = legacySourceName?.let { legacyMangaId(it, canonicalUrl).toString() } ?: row.id
                aliases[row.id] = canonicalId
                row.id to row.copy(
                    id = canonicalId,
                    url = canonicalUrl,
                    source_ref = MangaSourceRefCodec.encode(sourceRef),
                )
            }
            val rows = newestCanonicalRows(
                rows = normalizedRows,
                key = { it.second.id },
                remoteMangaId = { it.first },
                updatedAt = { it.second.updated_at },
                deletedAt = { null },
            ).map { it.second }
            pulledMangaIdAliases = aliases
            pulledMangaRows = rows.associateBy { it.id }
            pulledMangaSourceNames = rows.mapNotNull { row ->
                sourceNameFromRef(row.source_ref)?.let { name -> row.id to name }
            }.toMap()
            if (rows.isEmpty()) return@runCatching
            val existingMangas = repo.load().mangas.associateBy { it.id }
            val tagSer = kotlinx.serialization.builtins.ListSerializer(com.nyora.hasan72341.shared.model.MangaTag.serializer())
            val stringList = kotlinx.serialization.builtins.ListSerializer(kotlinx.serialization.serializer<String>())
            rows.forEach { row ->
                val existing = existingMangas[row.id]
                val pulledSource = normalizedMangaSourceRef(row.source_ref)
                val source = if (pulledSource is MangaSourceRef.Unknown) {
                    existing?.source?.takeUnless { it is MangaSourceRef.Unknown }
                        ?: inferSourceRefForManga(row.id)
                        ?: pulledSource
                } else {
                    pulledSource
                }
                val m = com.nyora.hasan72341.shared.model.Manga(
                    id = row.id,
                    title = row.title,
                    altTitles = runCatching { json.decodeFromString(stringList, row.alt_titles) }.getOrDefault(emptyList()),
                    url = row.url,
                    publicUrl = row.public_url,
                    rating = row.rating.toFloat(),
                    isNsfw = row.is_nsfw,
                    contentRating = row.content_rating?.let { runCatching { com.nyora.hasan72341.shared.model.ContentRating.valueOf(it) }.getOrNull() },
                    coverUrl = row.cover_url,
                    largeCoverUrl = row.large_cover_url,
                    state = row.state?.let { runCatching { com.nyora.hasan72341.shared.model.MangaState.valueOf(it) }.getOrNull() },
                    authors = runCatching { json.decodeFromString(stringList, row.authors) }.getOrDefault(emptyList()),
                    source = source,
                    description = row.description,
                    tags = runCatching { json.decodeFromString(tagSer, row.tags) }.getOrDefault(emptyList()),
                    chapters = existing?.chapters ?: emptyList(),
                    unread = existing?.unread ?: 0,
                    progress = existing?.progress ?: 0f
                )
                repo.upsertManga(m)
            }
        }.onFailure { System.err.println("[NyoraSync] pullManga failed: ${it.message}") }.getOrThrow()
    }

    private fun pullFavourites(cutoff: String) {
        val text = fetch("nyora_favourite", cutoff)
        runCatching {
            newestCanonicalRows(
                rows = json.decodeFromString<List<SbFavourite>>(text),
                key = { canonicalPulledMangaId(it.manga_id) },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at },
                deletedAt = { it.deleted_at },
            ).forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                if (row.deleted_at != null) {
                    repo.database.mangaFavouriteQueries.softDelete(
                        deleted_at = System.currentTimeMillis(),
                        manga_id = mangaId
                    )
                } else {
                    if (!repo.isFavourited(mangaId)) {
                        val now = System.currentTimeMillis()
                        repo.database.mangaFavouriteQueries.insert(mangaId, now, row.sort_key.toLong(), now)
                    }
                }
            }
        }.onFailure { System.err.println("[NyoraSync] pullFavourites failed: ${it.message}") }.getOrThrow()
    }

    private fun pullHistory(cutoff: String) {
        val text = fetch("nyora_history", cutoff)
        runCatching {
            newestCanonicalRows(
                rows = json.decodeFromString<List<SbHistory>>(text),
                key = { canonicalPulledMangaId(it.manga_id) },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at },
                deletedAt = { it.deleted_at },
            ).forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                if (row.deleted_at != null) {
                    repo.database.mangaHistoryQueries.softDelete(
                        deleted_at = System.currentTimeMillis(),
                        manga_id = mangaId
                    )
                } else {
                    val sourceId = row.source_id.fromWireSourceId().ifBlank { inferSourceIdForManga(mangaId) }
                    repo.upsertHistoryFromSync(
                        mangaId = mangaId, sourceId = sourceId,
                        chapterId = row.chapter_id, chapterTitle = row.chapter_title,
                        page = row.page, scroll = row.scroll,
                        percent = row.percent.toFloat(),
                        chaptersCount = row.chapters_count,
                        updatedAt = row.updated_at,
                    )
                }
            }
        }.onFailure { System.err.println("[NyoraSync] pullHistory failed: ${it.message}") }.getOrThrow()
    }

    private fun pullBookmarks(cutoff: String) {
        val text = fetch("nyora_bookmark", cutoff)
        runCatching {
            newestCanonicalRows(
                rows = json.decodeFromString<List<SbBookmark>>(text),
                key = {
                    "${canonicalPulledMangaId(it.manga_id)}|${it.chapter_id}|${it.page}"
                },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at ?: it.created_at },
                deletedAt = { it.deleted_at },
            ).forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                if (row.deleted_at != null) {
                    repo.database.bookmarkQueries.softDelete(
                        deleted_at = System.currentTimeMillis(),
                        manga_id = mangaId,
                        chapter_id = row.chapter_id,
                        page = row.page.toLong()
                    )
                } else {
                    if (!repo.isPageBookmarked(mangaId, row.chapter_id, row.page)) {
                        repo.addBookmark(
                            mangaId = mangaId, chapterId = row.chapter_id,
                            chapterTitle = row.chapter_title, page = row.page, note = row.note,
                        )
                    }
                }
            }
        }.onFailure { System.err.println("[NyoraSync] pullBookmarks failed: ${it.message}") }.getOrThrow()
    }

    private fun pullCategories(cutoff: String) {
        val text = fetch("nyora_category", cutoff)
        runCatching {
            json.decodeFromString<List<SbCategory>>(text).forEach { row ->
                if (row.deleted_at != null) {
                    repo.database.favouriteCategoryQueries.softDeleteCategory(
                        deleted_at = System.currentTimeMillis(),
                        id = row.id.toLongOrNull() ?: return@forEach
                    )
                } else {
                    val existing = repo.favouriteCategories()
                    if (existing.none { it.title == row.title }) {
                        repo.createCategory(row.title)
                    }
                }
            }
            // Collapse any duplicate-title categories that arrived from legacy per-device seeds.
            repo.dedupeCategories()
        }.onFailure { System.err.println("[NyoraSync] pullCategories failed: ${it.message}") }.getOrThrow()
    }

    private fun pullUpdates(cutoff: String) {
        val text = fetch("nyora_update", cutoff)
        runCatching {
            newestCanonicalRows(
                rows = json.decodeFromString<List<SbUpdate>>(text),
                key = { canonicalPulledMangaId(it.manga_id) },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at ?: it.last_synced_at },
                deletedAt = { null },
            ).forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                repo.recordUpdateSync(
                    mangaId = mangaId, sourceId = row.source_id.fromWireSourceId(),
                    currentChapterCount = row.last_chapter_count,
                    latestChapterTitle = row.latest_chapter_title,
                )
            }
        }.onFailure { System.err.println("[NyoraSync] pullUpdates failed: ${it.message}") }.getOrThrow()
    }

    private fun pullSourcePrefs(cutoff: String) {
        val text = fetch("nyora_source_prefs", cutoff)
        runCatching {
            val rows = newestCanonicalSourcePreferences(
                json.decodeFromString<List<SbSourcePref>>(text).map { row ->
                    PulledSourcePreferenceCandidate(
                        remoteSourceId = row.source_id,
                        isPinned = row.is_pinned,
                        isEnabled = row.is_enabled,
                        updatedAt = isoToMillis(row.updated_at),
                    )
                },
            )
            rows.forEach { row ->
                val localId = row.wireSourceId.fromWireSourceId()
                val existing = repo.database.mangaSourceQueries.selectById(localId).executeAsOneOrNull()
                if (existing != null) {
                    val currentPinned = existing.is_pinned != 0L
                    if (currentPinned != row.isPinned) {
                        repo.database.mangaSourceQueries.togglePin(localId)
                    }
                    // Apply the pulled installed set, mirroring the web (is_enabled drives the
                    // local installed set). Previously the pull ignored is_enabled entirely.
                    val currentInstalled = existing.is_installed != 0L
                    if (currentInstalled != row.isEnabled) {
                        repo.database.mangaSourceQueries.setInstalled(
                            if (row.isEnabled) 1L else 0L, localId
                        )
                    }
                }
            }
        }.onFailure { System.err.println("[NyoraSync] pullSourcePrefs failed: ${it.message}") }.getOrThrow()
    }

    private fun pullTracking(cutoff: String) {
        val text = fetch("nyora_tracking", cutoff)
        runCatching {
            // LWW guard: skip rows the local store has a newer copy of.
            val local = repo.allTracking().associateBy { "${it.trackerId}|${it.mangaId}" }
            newestCanonicalRows(
                rows = json.decodeFromString<List<SbTracking>>(text),
                key = { "${it.tracker_id}|${canonicalPulledMangaId(it.manga_id)}" },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at },
                deletedAt = { it.deleted_at },
            ).forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                val key = "${row.tracker_id}|$mangaId"
                val localUpdated = isoToMillis(local[key]?.updatedAt)
                if (localUpdated > isoToMillis(row.updated_at)) return@forEach
                if (!row.deleted_at.isNullOrBlank()) {
                    repo.removeTracking(row.tracker_id, mangaId)
                } else {
                    repo.saveTracking(
                        com.nyora.hasan72341.shared.repository.TrackingRow(
                            trackerId = row.tracker_id,
                            remoteId = row.remote_id,
                            sourceId = row.source_id.fromWireSourceId(),
                            mangaId = mangaId,
                            title = row.title,
                            status = row.status,
                            score = row.score.toFloat(),
                            lastReadChapter = row.last_read_chapter.toFloat(),
                            lastReadVolume = row.last_read_volume,
                            totalChapters = row.total_chapters,
                            totalVolumes = row.total_volumes,
                            chapterOffset = row.chapter_offset,
                            startedAt = row.started_at,
                            finishedAt = row.finished_at,
                            comment = row.comment,
                            updatedAt = row.updated_at ?: "",
                            deletedAt = "",
                        )
                    )
                }
            }
        }.onFailure { System.err.println("[NyoraSync] pullTracking failed: ${it.message}") }.getOrThrow()
    }

    private fun pullMangaCategories(cutoff: String) {
        val text = fetch("nyora_manga_category", cutoff)
        runCatching {
            newestCanonicalRows(
                rows = json.decodeFromString<List<SbMangaCategory>>(text),
                key = { "${canonicalPulledMangaId(it.manga_id)}|${it.category_id}" },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at },
                deletedAt = { it.deleted_at },
            ).forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                val catId = row.category_id.toLongOrNull() ?: return@forEach
                if (row.deleted_at != null) {
                    repo.removeFromCategory(mangaId, catId)
                } else {
                    repo.addToCategory(mangaId, catId)
                }
            }
        }.onFailure { System.err.println("[NyoraSync] pullMangaCategories failed: ${it.message}") }.getOrThrow()
    }

    private fun pullMangaPrefs(cutoff: String) {
        val text = fetch("nyora_manga_prefs", cutoff)
        runCatching {
            val rows = newestCanonicalRows(
                rows = json.decodeFromString<List<SbMangaPrefs>>(text),
                key = { canonicalPulledMangaId(it.manga_id) },
                remoteMangaId = { it.manga_id },
                updatedAt = { it.updated_at },
                deletedAt = { null },
            )
            rows.forEach { row ->
                val mangaId = canonicalPulledMangaId(row.manga_id)
                repo.saveMangaPrefs(
                    com.nyora.hasan72341.shared.repository.MangaPrefsRow(
                        mangaId = mangaId,
                        readerMode = row.reader_mode,
                        brightness = row.brightness,
                        contrast = row.contrast,
                        saturation = row.saturation,
                        hue = row.hue,
                        palette = row.palette,
                    )
                )
            }
        }.onFailure { System.err.println("[NyoraSync] pullMangaPrefs failed: ${it.message}") }.getOrThrow()
    }

    // ── Edge Function Helpers ───────────────────────────────────────────────

    private fun canonicalPulledMangaId(remoteId: String): String =
        pulledMangaIdAliases[remoteId] ?: remoteId

    /**
     * Alias and canonical cloud rows may collapse onto one local key. Backend row order is not a
     * conflict policy, so pick the newest effective update/tombstone; on an exact tie prefer the
     * already-canonical row.
     */
    private fun <T> newestCanonicalRows(
        rows: List<T>,
        key: (T) -> String,
        remoteMangaId: (T) -> String,
        updatedAt: (T) -> String?,
        deletedAt: (T) -> String?,
    ): List<T> = rows.groupBy(key).values.mapNotNull { candidates ->
        candidates.maxWithOrNull { left, right ->
            val leftId = remoteMangaId(left)
            val rightId = remoteMangaId(right)
            val leftCandidate = CanonicalAliasCandidate(
                remoteId = leftId,
                canonicalId = canonicalPulledMangaId(leftId),
                updatedAt = isoToMillis(updatedAt(left)),
                deletedAt = isoToMillis(deletedAt(left)),
            )
            val rightCandidate = CanonicalAliasCandidate(
                remoteId = rightId,
                canonicalId = canonicalPulledMangaId(rightId),
                updatedAt = isoToMillis(updatedAt(right)),
                deletedAt = isoToMillis(deletedAt(right)),
            )
            when (newestCanonicalAlias(listOf(leftCandidate, rightCandidate))) {
                leftCandidate -> if (leftCandidate == rightCandidate) 0 else 1
                else -> -1
            }
        }
    }

    private inline fun <reified T> upsert(table: String, rows: List<T>) {
        if (rows.isEmpty()) return
        upsertCanonicalRows(table, json.encodeToJsonElement(UpsertRequest(table = table, rows = rows)).jsonObject)
    }

    private fun upsertCanonicalRows(table: String, encoded: JsonObject) {
        val mangaRows = if (table == "nyora_manga" || table == "nyora_source_prefs" || table == "nyora_category") {
            emptyMap()
        } else {
            val now = Instant.now().toString()
            repo.load().mangas.mapNotNull { it.toRemoteManga(NyoraSyncConfig.userId, now) }
                .associateBy { it.id }
        }
        val portableRows = encoded.getValue("rows").jsonArray.mapNotNull { element ->
            val row = element.jsonObject
            val mangaId = row["manga_id"]?.jsonPrimitive?.contentOrNull
            val parent = mangaId?.let(mangaRows::get)
            if (mangaId != null && parent == null) return@mapNotNull null
            val sourceRef = row["source_ref"]?.jsonPrimitive?.contentOrNull
            if (sourceRef != null && !isCanonicalUploadSourceId(MangaSourceRefCodec.decode(sourceRef).name)) {
                return@mapNotNull null
            }
            if ("source_id" in row) {
                val sourceId = parent?.source_ref?.let(::canonicalWireSourceId)
                    ?: row.getValue("source_id").jsonPrimitive.content
                if (!isCanonicalUploadSourceId(sourceId)) return@mapNotNull null
                JsonObject(row + ("source_id" to JsonPrimitive(sourceId)))
            } else row
        }
        if (portableRows.isEmpty()) return
        // Each relationship batch carries its eligible parents first, including bookmark-only
        // and tracking-only manga. Rejected local/legacy rows stay untouched in SQLite.
        val parents = portableRows.mapNotNull { it["manga_id"]?.jsonPrimitive?.contentOrNull }
            .distinct().mapNotNull(mangaRows::get)
        if (parents.isNotEmpty()) upsert("nyora_manga", parents)
        runCatching {
            val body = JsonObject(encoded + ("rows" to JsonArray(portableRows))).toString().toRequestBody(JSON_MT)
            // Nyora Sync (FastAPI/JWT) authenticates on the Bearer token only — no Nyora Sync
            // apikey/anon header (that's a leftover the web client never sent either).
            val req = Request.Builder()
                .url(syncFunctionUrl)
                .header("Authorization", "Bearer ${NyoraSyncConfig.accessToken}")
                .post(body)
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    error("[NyoraSync] upsert $table failed ${resp.code}: ${resp.body?.string()}")
                }
            }
        }.onFailure { System.err.println("[NyoraSync] upsert $table network error: ${it.message}") }.getOrThrow()
    }

    private fun fetch(table: String, cutoff: String? = null): String = runCatching {
        val request = buildJsonObject {
            put("action", "select")
            put("table", table)
            if (cutoff != null) {
                put("since", cutoff)
            }
        }
        val body = request.toString().toRequestBody(JSON_MT)
        val req = Request.Builder()
            .url(syncFunctionUrl)
            .header("Authorization", "Bearer ${NyoraSyncConfig.accessToken}")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                error("[NyoraSync] fetch $table failed ${resp.code}: ${resp.body?.string()}")
            }
            val text = resp.body?.string() ?: error("[NyoraSync] fetch $table failed: empty body")
            val obj = json.parseToJsonElement(text).asJsonObject
            obj["data"]?.toString() ?: "[]"
        }
    }.onFailure { System.err.println("[NyoraSync] fetch $table network error: ${it.message}") }.getOrThrow()

    private val kotlinx.serialization.json.JsonElement.asJsonObject: kotlinx.serialization.json.JsonObject
        get() = this as? kotlinx.serialization.json.JsonObject ?: kotlinx.serialization.json.JsonObject(emptyMap())

    private fun sourceNameFromRef(sourceRef: String): String? =
        normalizedMangaSourceRef(sourceRef).name.takeIf {
            it.isNotBlank() && it != MangaSourceRef.Unknown.name
        }

    private fun inferSourceIdForManga(mangaId: String): String {
        val sources = repo.database.mangaSourceQueries.selectAll().executeAsList()

        val sourceName = pulledMangaSourceNames[mangaId]
        if (!sourceName.isNullOrBlank()) {
            val normalized = sourceName
                .removePrefix("JS_")
                .removePrefix("SCRIPT_")
            val candidates = setOf(
                sourceName,
                normalized,
                "parser:$sourceName",
                "parser:$normalized",
                "script:$sourceName",
                "script:$normalized",
            )
            return sources.firstOrNull { it.id in candidates }?.id
                ?: sources.firstOrNull { it.id.endsWith(":$normalized") }?.id
                ?: ""
        }

        val manga = pulledMangaRows[mangaId] ?: return ""
        val url = listOf(manga.url, manga.public_url).firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
            ?: return ""
        val host = runCatching { URI(url).host?.removePrefix("www.") }.getOrNull() ?: return ""
        return sources.firstOrNull { source ->
            val sourceHost = runCatching { URI(source.base_url).host?.removePrefix("www.") }.getOrNull()
            sourceHost != null && (host == sourceHost || host.endsWith(".$sourceHost"))
        }?.id
            ?: ""
    }

    private fun inferSourceRefForManga(mangaId: String): MangaSourceRef? {
        val sourceId = inferSourceIdForManga(mangaId).takeIf { it.isNotBlank() } ?: return null
        val source = repo.database.mangaSourceQueries.selectById(sourceId).executeAsOneOrNull()
        val normalized = sourceId
            .removePrefix("parser:")
            .removePrefix("script:")
        val engine = source?.engine?.let { runCatching { SourceEngine.valueOf(it) }.getOrNull() }
        return when (engine) {
            SourceEngine.JavaScript -> if (sourceId.startsWith("data:")) {
                MangaSourceRef.Script(sourceId)
            } else {
                MangaSourceRef.Script("JS_$normalized")
            }
            SourceEngine.Parser -> MangaSourceRef.Parser(normalized)
            SourceEngine.Dart -> null
            null -> MangaSourceRef.Script("JS_$normalized").takeIf { sourceId.startsWith("parser:") || sourceId.startsWith("script:") }
        }
    }

    private fun com.nyora.hasan72341.shared.model.Manga.toRemoteManga(uid: String, updatedAt: String): SbManga? {
        val wireSourceId = canonicalWireSourceId(source.name)
        if (!isCanonicalUploadSourceId(wireSourceId)) return null
        return SbManga(
            user_id = uid,
            id = id,
            title = title,
            alt_titles = json.encodeToString(altTitles),
            url = url,
            public_url = publicUrl,
            rating = rating.toDouble(),
            is_nsfw = isNsfw,
            content_rating = contentRating?.name,
            cover_url = coverUrl,
            large_cover_url = largeCoverUrl,
            state = state?.name,
            authors = json.encodeToString(authors),
            source_ref = canonicalWireSourceRef(source),
            description = description,
            tags = json.encodeToString(tags),
            updated_at = updatedAt,
        )
    }

    // ── DTOs (match Nyora Sync column names) ───────────────────────────────────

    @Serializable private data class AuthResponse(
        val access_token: String,
        val refresh_token: String? = null,
    )

    @Serializable private data class UpsertRequest<T>(
        val action: String = "upsert",
        val table: String,
        val rows: List<T>,
    )

    @Serializable private data class SbManga(
        val user_id: String = "", val id: String, val title: String,
        val alt_titles: String = "[]", val url: String = "", val public_url: String = "",
        val rating: Double = -1.0, val is_nsfw: Boolean = false,
        val content_rating: String? = null, val cover_url: String = "",
        val large_cover_url: String? = null, val state: String? = null,
        val authors: String = "[]", val source_ref: String = "{}",
        val description: String = "", val tags: String = "[]",
        val updated_at: String? = null,
    )

    @Serializable private data class SbFavourite(
        val user_id: String = "", val manga_id: String,
        val sort_key: Int = 0,
        val updated_at: String? = null,
        val deleted_at: String? = null,
    )

    @Serializable private data class SbHistory(
        val user_id: String = "", val manga_id: String,
        val source_id: String = "", val chapter_id: String = "",
        val chapter_title: String = "", val page: Int = 0,
        val scroll: Double = 0.0, val percent: Double = 0.0,
        val chapters_count: Int = 0, val updated_at: String? = null,
        val deleted_at: String? = null,
    )

    @Serializable private data class SbBookmark(
        val user_id: String = "", val id: String = "", val manga_id: String,
        val chapter_id: String = "", val chapter_title: String = "",
        val page: Int = 0, val scroll: Double = 0.0, val note: String = "",
        val image_url: String = "", val percent: Double = 0.0,
        val created_at: String? = null,
        val updated_at: String? = null,
        val deleted_at: String? = null,
    )

    @Serializable private data class SbCategory(
        val user_id: String = "", val id: String, val title: String,
        val sort_key: Int = 0,
        val updated_at: String? = null,
        val deleted_at: String? = null,
    )

    @Serializable private data class SbMangaCategory(
        val user_id: String = "", val manga_id: String, val category_id: String,
        val updated_at: String? = null,
        val deleted_at: String? = null,
    )

    @Serializable private data class SbUpdate(
        val user_id: String = "", val manga_id: String, val source_id: String = "",
        val last_chapter_count: Int = 0, val new_chapters_count: Int = 0,
        val latest_chapter_title: String = "", val last_synced_at: String? = null,
        val updated_at: String? = null,
    )

    @Serializable private data class SbSourcePref(
        val user_id: String = "",
        val source_id: String,
        val is_pinned: Boolean,
        val is_enabled: Boolean,
        val updated_at: String? = null,
    )

    @Serializable private data class SbTracking(
        val user_id: String = "",
        val tracker_id: String,
        val manga_id: String,
        val remote_id: String = "",
        val source_id: String = "",
        val title: String = "",
        val status: String = "",
        val score: Double = 0.0,
        val last_read_chapter: Double = 0.0,
        val last_read_volume: Int = 0,
        val total_chapters: Int = 0,
        val total_volumes: Int = 0,
        val chapter_offset: Int = 0,
        val started_at: String = "",
        val finished_at: String = "",
        val comment: String = "",
        val updated_at: String? = null,
        val deleted_at: String? = null,
    )

    @Serializable private data class SbMangaPrefs(
        val user_id: String = "",
        val manga_id: String,
        val reader_mode: String = "",
        val brightness: Double = 0.0,
        val contrast: Double = 1.0,
        val saturation: Double = 1.0,
        val hue: Double = 0.0,
        val palette: String = "",
        val updated_at: String? = null,
    )
}

/**
 * Convert every source representation written by either client into the public sync namespace.
 *
 * Older Android builds wrote `DD_*` (sometimes wrapped in JSON twice), while desktop wrote bare
 * parser names.  Data-driven sources must be represented as `data:<catalogue-id>` on the wire so
 * a pull does not turn them into a retired `parser:DD_*` source.
 */
internal fun canonicalWireSourceId(value: String): String {
    val raw = value.trim()
    val decoded = if (raw.startsWith("{")) normalizedMangaSourceRef(raw).name else raw
    val unwrapped = decoded
        .removePrefix("parser:")
        .removePrefix("script:")

    val direct = when {
        unwrapped.startsWith("DD_") -> "data:${canonicalDataSourceId(unwrapped.removePrefix("DD_"))}"
        unwrapped.startsWith("JS_data:") ->
            "data:${canonicalDataSourceId(unwrapped.removePrefix("JS_data:"))}"
        unwrapped.startsWith("data:") ->
            "data:${canonicalDataSourceId(unwrapped.removePrefix("data:"))}"
        else -> null
    }
    if (direct != null) return direct

    val legacyName = legacyParserSourceName(unwrapped)
    if (legacyName == "ASURASCANS_US") return "data:asurascans"
    return DataDrivenCatalog.load()
        .firstOrNull { legacyParserSourceName(it.definition.id) == legacyName }
        ?.source
        ?.id
        ?: unwrapped
}

/** Convert a sync source id back to the desktop-local namespace. */
internal fun localSourceIdFromWire(value: String): String {
    val canonical = canonicalWireSourceId(value)
    return when {
        canonical.isBlank() || ':' in canonical -> canonical
        else -> "parser:$canonical"
    }
}

internal data class CanonicalSourcePreferenceCandidate(
    val localSourceId: String,
    val isPinned: Boolean,
    val isEnabled: Boolean,
) {
    val wireSourceId: String = canonicalWireSourceId(localSourceId)
}

/** Prefer the live desktop `data:*` row when local aliases collapse onto one sync key. */
internal fun canonicalSourcePreferences(
    candidates: List<CanonicalSourcePreferenceCandidate>,
): List<CanonicalSourcePreferenceCandidate> = candidates
    .groupBy { it.wireSourceId }
    .toSortedMap()
    .values
    .map { aliases ->
        aliases.maxWith(
            compareBy<CanonicalSourcePreferenceCandidate> {
                currentDesktopDataPreferenceRank(it.localSourceId, it.wireSourceId)
            }.thenBy { it.localSourceId },
        )
    }

internal data class PulledSourcePreferenceCandidate(
    val remoteSourceId: String,
    val isPinned: Boolean,
    val isEnabled: Boolean,
    val updatedAt: Long,
) {
    val wireSourceId: String = canonicalWireSourceId(remoteSourceId)
}

/**
 * Collapse remote aliases before mutating local source state. The newest backend clock wins;
 * exact clock ties prefer the current canonical wire id, followed by stable value tie-breakers.
 */
internal fun newestCanonicalSourcePreferences(
    candidates: List<PulledSourcePreferenceCandidate>,
): List<PulledSourcePreferenceCandidate> = candidates
    .groupBy { it.wireSourceId }
    .toSortedMap()
    .values
    .mapNotNull { aliases ->
        aliases.maxWithOrNull(
            compareBy<PulledSourcePreferenceCandidate> { it.updatedAt }
                .thenBy { remoteSourcePreferenceRank(it.remoteSourceId, it.wireSourceId) }
                .thenBy { it.remoteSourceId }
                .thenBy { it.isPinned }
                .thenBy { it.isEnabled },
        )
    }

private fun remoteSourcePreferenceRank(remoteSourceId: String, wireSourceId: String): Int {
    val remote = remoteSourceId.trim()
    return when {
        remote == wireSourceId -> 2
        wireSourceId.startsWith("data:") &&
            remote == "DD_${wireSourceId.removePrefix("data:")}" -> 1
        else -> 0
    }
}

private fun currentDesktopDataPreferenceRank(localSourceId: String, wireSourceId: String): Int {
    if (!wireSourceId.startsWith("data:")) return 0
    val local = localSourceId.trim().removePrefix("script:")
    return when (local) {
        wireSourceId -> 2
        "DD_${wireSourceId.removePrefix("data:")}" -> 1
        else -> 0
    }
}

/** Encode manga metadata with the same canonical source namespace as child source_id fields. */
internal fun canonicalWireSourceRef(source: MangaSourceRef): String = MangaSourceRefCodec.encode(
    MangaSourceRefCodec.decodeName(canonicalWireSourceId(source.name)),
)

internal data class CanonicalAliasCandidate(
    val remoteId: String,
    val canonicalId: String,
    val updatedAt: Long,
    val deletedAt: Long,
)

/** Order-independent LWW choice after legacy and canonical ids collapse onto one key. */
internal fun newestCanonicalAlias(candidates: List<CanonicalAliasCandidate>): CanonicalAliasCandidate? =
    candidates.maxWithOrNull(
        compareBy<CanonicalAliasCandidate> { maxOf(it.updatedAt, it.deletedAt) }
            .thenBy { if (it.remoteId == it.canonicalId) 1 else 0 }
            .thenBy { it.remoteId },
    )

private val canonicalUploadSourcePattern = Regex("data:[a-z0-9][a-z0-9._-]*")

private fun isCanonicalUploadSourceId(value: String): Boolean = canonicalUploadSourcePattern.matches(value)
