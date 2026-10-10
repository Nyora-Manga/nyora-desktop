package com.nyora.hasan72341.shared.download

import com.nyora.hasan72341.shared.HelperProfile
import com.nyora.hasan72341.shared.NyoraFacade
import com.nyora.hasan72341.shared.reader.PageImageLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.io.path.absolutePathString
import kotlin.io.path.createDirectories

/**
 * Single in-memory download queue. Each chapter download is a coroutine that
 * fetches pages via the existing `PageImageLoader` and writes them into a
 * `.cbz` (renamed zip) under
 *   ~/Library/Application Support/Nyora/downloads/<source>/<manga>/<chapter>.cbz
 *
 * State lives entirely in this manager; SwiftUI polls `list()` to render
 * progress. Restarts wipe the in-memory map — completed CBZs survive because
 * they're files on disk.
 */
class DownloadManager(
    private val facade: NyoraFacade,
    private val pageLoader: PageImageLoader = PageImageLoader(),
    private val rootDir: Path = defaultDownloadsDir(),
) {
    init { HelperProfile.confine(rootDir) }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val store = ConcurrentHashMap<String, DownloadEntry>()
    @Volatile private var settings = DownloadSettings()
    @Volatile private var limiter = Semaphore(settings.maxConcurrentDownloads, true)

    fun list(): List<DownloadEntry> =
        store.values.sortedByDescending { it.startedAt }

    fun get(id: String): DownloadEntry? = store[id]

    fun configure(newSettings: DownloadSettings) {
        val normalized = newSettings.copy(
            maxConcurrentDownloads = newSettings.maxConcurrentDownloads.coerceIn(1, 8),
        )
        settings = normalized
        limiter = Semaphore(normalized.maxConcurrentDownloads, true)
    }

    fun currentSettings(): DownloadSettings = settings

    fun start(
        sourceId: String,
        mangaUrl: String,
        chapterUrl: String,
        mangaTitle: String,
        chapterTitle: String,
    ): DownloadEntry {
        val id = UUID.randomUUID().toString()
        val entry = DownloadEntry(
            id = id,
            sourceId = sourceId,
            mangaTitle = mangaTitle,
            chapterTitle = chapterTitle,
            chapterUrl = chapterUrl,
            startedAt = System.currentTimeMillis(),
            status = DownloadStatus.QUEUED,
        )
        store[id] = entry
        scope.launch { run(id, sourceId, chapterUrl, mangaTitle, chapterTitle) }
        return entry
    }

    fun cancel(id: String) {
        store[id]?.job?.cancel()
        store[id] = (store[id] ?: return).copy(status = DownloadStatus.CANCELLED)
    }

    /**
     * Drop all finished entries (COMPLETED / FAILED / CANCELLED) from the in-memory
     * queue view. Active entries (QUEUED / RUNNING) are left untouched. Returns the
     * number of rows removed. Downloaded files on disk are not affected.
     */
    fun clearFinished(): Int {
        val done = store.values
            .filter { it.status == DownloadStatus.COMPLETED ||
                      it.status == DownloadStatus.FAILED ||
                      it.status == DownloadStatus.CANCELLED }
            .map { it.id }
        done.forEach { store.remove(it) }
        return done.size
    }

    private fun run(
        id: String,
        sourceId: String,
        chapterUrl: String,
        mangaTitle: String,
        chapterTitle: String,
    ) {
        val acquiredLimiter = limiter
        try {
            acquiredLimiter.acquire()
            mutate(id) { it.copy(status = DownloadStatus.RUNNING) }

            // 1) Resolve page list (cached if we've opened this chapter before).
            val pages: List<com.nyora.hasan72341.shared.model.MangaPage> =
                facade.cachedPages(sourceId, chapterUrl) ?: run {
                    val source = facade.listSources().firstOrNull { it.id == sourceId }
                        ?: error("Source not installed: $sourceId")
                    val service = facade.openExtension(source)
                    val list = runBlocking {
                        service.getPageList(
                            com.nyora.hasan72341.shared.model.MangaChapter(id = chapterUrl, title = chapterTitle, url = chapterUrl),
                        )
                    }
                    facade.cachePages(sourceId, chapterUrl, mangaTitle, list)
                    list
                }

            mutate(id) { it.copy(totalPages = pages.size) }

            // 2) Resolve output path.
            val safeManga = mangaTitle.toSafeName()
            val safeChapter = chapterTitle.toSafeName().ifBlank { "chapter" }
            val targetDir = HelperProfile.confine(rootDir.resolve(sourceId.toSafeName()).resolve(safeManga))
            targetDir.createDirectories()
            val mode = settings.format
            val (target, tempTarget) = when (mode) {
                DownloadFormat.FOLDER -> {
                    val folder = HelperProfile.confine(targetDir.resolve(safeChapter))
                    folder.createDirectories()
                    folder to folder
                }
                DownloadFormat.ZIP -> {
                    val archive = HelperProfile.confine(targetDir.resolve("$safeChapter.zip"))
                    archive to targetDir.resolve("$safeChapter.zip.part")
                }
                DownloadFormat.AUTO, DownloadFormat.CBZ -> {
                    val archive = HelperProfile.confine(targetDir.resolve("$safeChapter.cbz"))
                    archive to targetDir.resolve("$safeChapter.cbz.part")
                }
            }

            when (mode) {
                DownloadFormat.FOLDER -> {
                    pageLoop@ for ((index, page) in pages.withIndex()) {
                        if (store[id]?.status == DownloadStatus.CANCELLED) return
                        val bytes = tryLoadPage(id, index, page, sourceId) ?: continue@pageLoop
                        val ext = guessExt(page.url, bytes)
                        Files.write(HelperProfile.confine(target.resolve("%03d.%s".format(index + 1, ext))), bytes)
                        mutate(id) { it.copy(completedPages = index + 1) }
                    }
                }
                else -> {
                    ZipOutputStream(BufferedOutputStream(Files.newOutputStream(HelperProfile.confine(tempTarget)))).use { zip ->
                        pageLoop@ for ((index, page) in pages.withIndex()) {
                            if (store[id]?.status == DownloadStatus.CANCELLED) {
                                Files.deleteIfExists(HelperProfile.confine(tempTarget))
                                return
                            }
                            val bytes = tryLoadPage(id, index, page, sourceId) ?: continue@pageLoop
                            val entry = ZipEntry("%03d.%s".format(index + 1, guessExt(page.url, bytes)))
                            zip.putNextEntry(entry)
                            ByteArrayInputStream(bytes).copyTo(zip)
                            zip.closeEntry()
                            mutate(id) { it.copy(completedPages = index + 1) }
                        }
                    }
                    Files.move(HelperProfile.confine(tempTarget), HelperProfile.confine(target), StandardCopyOption.REPLACE_EXISTING)
                }
            }

            mutate(id) {
                it.copy(
                    status = DownloadStatus.COMPLETED,
                    filePath = target.absolutePathString(),
                    finishedAt = System.currentTimeMillis(),
                )
            }
        } catch (err: Throwable) {
            mutate(id) {
                it.copy(
                    status = if (err is kotlinx.coroutines.CancellationException) DownloadStatus.CANCELLED else DownloadStatus.FAILED,
                    error = err.message?.take(160),
                    finishedAt = System.currentTimeMillis(),
                )
            }
        } finally {
            acquiredLimiter.release()
        }
    }

    private fun mutate(id: String, fn: (DownloadEntry) -> DownloadEntry) {
        store[id]?.let { store[id] = fn(it) }
    }

    private fun tryLoadPage(
        id: String,
        index: Int,
        page: com.nyora.hasan72341.shared.model.MangaPage,
        sourceId: String,
    ): ByteArray? {
        return try {
            pageLoader.loadBytes(page.url, page.headers, sourceId = sourceId)
        } catch (err: Throwable) {
            // Stop this job on a verification/relay failure; never complete an empty archive.
            if (generateSequence(err) { it.cause }.any { it.message.orEmpty().contains("verification_required") || it.message.orEmpty().contains("desktop_relay_") }) throw err
            mutate(id) { it.copy(failedPages = it.failedPages + 1) }
            System.err.println("Page ${index + 1} failed: ${err.message}")
            null
        }
    }

    private fun String.toSafeName(): String =
        replace(Regex("[/\\\\:*?\"<>|]"), "_").trim().take(120)

    private fun guessExt(url: String, bytes: ByteArray): String {
        val lower = url.lowercase()
        listOf("png", "jpg", "jpeg", "webp", "gif").forEach { ext ->
            if (lower.endsWith(".$ext")) return ext
        }
        if (bytes.size >= 12) {
            if (bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte()) return "jpg"
            if (bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte()) return "png"
            if (bytes[0] == 0x52.toByte() && bytes[1] == 0x49.toByte() &&
                bytes[8] == 0x57.toByte() && bytes[9] == 0x45.toByte()
            ) return "webp"
            if (bytes[0] == 0x47.toByte() && bytes[1] == 0x49.toByte()) return "gif"
        }
        return "img"
    }

    companion object {
        fun defaultDownloadsDir(): Path {
            if (HelperProfile.isolated) return HelperProfile.directory("downloads")
            val home = Path.of(System.getProperty("user.home"))
            val dir = when {
                System.getProperty("os.name").lowercase().contains("mac") ->
                    home.resolve("Library").resolve("Application Support")
                        .resolve("Nyora").resolve("downloads")
                else -> {
                    val xdgData = System.getenv("XDG_DATA_HOME")?.let { Path.of(it) }
                        ?: home.resolve(".local").resolve("share")
                    xdgData.resolve("nyora").resolve("downloads")
                }
            }
            dir.createDirectories()
            return dir
        }
    }
}

@kotlinx.serialization.Serializable
data class DownloadEntry(
    val id: String,
    val sourceId: String,
    val mangaTitle: String,
    val chapterTitle: String,
    val chapterUrl: String,
    val totalPages: Int = 0,
    val completedPages: Int = 0,
    val failedPages: Int = 0,
    val status: DownloadStatus,
    val filePath: String? = null,
    val error: String? = null,
    val startedAt: Long,
    val finishedAt: Long? = null,
    /// Job ref isn't serializable; transient-only.
    @kotlinx.serialization.Transient val job: Job? = null,
)

@kotlinx.serialization.Serializable
enum class DownloadStatus { QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED }

@kotlinx.serialization.Serializable
data class DownloadSettings(
    val maxConcurrentDownloads: Int = 3,
    val format: DownloadFormat = DownloadFormat.AUTO,
)

@kotlinx.serialization.Serializable
enum class DownloadFormat { AUTO, FOLDER, CBZ, ZIP }
