package com.nyora.hasan72341.shared

import com.nyora.hasan72341.shared.data.ExtensionInstaller
import com.nyora.hasan72341.shared.data.SourceCatalogClient
import com.nyora.hasan72341.shared.net.HelperNetworkConfig
import com.nyora.hasan72341.shared.model.MangaSource
import com.nyora.hasan72341.shared.model.SourceEngine
import com.nyora.hasan72341.shared.proxy.NyoraRestServer
import com.nyora.hasan72341.shared.reader.PageImageLoader
import com.nyora.hasan72341.shared.repository.JsonToSqlMigration
import com.nyora.hasan72341.shared.repository.SqlDelightLibraryRepository
import com.nyora.hasan72341.shared.repository.SqlDelightNyoraBackupRepository
import com.nyora.hasan72341.shared.proxy.buildCatalogueHttpClient
import com.nyora.hasan72341.shared.proxy.downloadCatalogue
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.StandardCopyOption
import kotlin.io.path.writeText

internal fun persistAtomically(
    target: Path,
    content: String,
    writer: (Path, String) -> Unit = { path, text -> Files.writeString(path, text) },
) {
    HelperProfile.confine(target)
    val parent = requireNotNull(target.parent) { "Catalogue path must have a parent directory" }
    Files.createDirectories(parent)
    val temporary = Files.createTempFile(parent, target.fileName.toString(), ".tmp")
    try {
        writer(temporary, content)
        try {
            Files.move(
                temporary,
                target,
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
        }
    } finally {
        Files.deleteIfExists(temporary)
    }
}

object HelperMain {

    /** Bootstrapped state shared by every entry point (desktop helper, web server). */
    class Bootstrap(
        val repository: SqlDelightLibraryRepository,
        val facade: NyoraFacade,
        val downloads: com.nyora.hasan72341.shared.download.DownloadManager,
        val networkConfig: HelperNetworkConfig,
    )

    /**
     * Open the DB, run migrations, seed the built-in source catalog and wire up
     * a [NyoraFacade] + [com.nyora.hasan72341.shared.download.DownloadManager]. Reused by
     * both the loopback desktop helper and the deployable web server so source
     * seeding stays in one place.
     */
    fun bootstrap(): Bootstrap {
        HelperProfile.bearerToken() // Validate credentials before opening any writable storage.
        val networkConfig = HelperNetworkConfig() // Validate isolated relay configuration before storage.
        val repository = SqlDelightLibraryRepository()
        JsonToSqlMigration.runIfNeeded(repository)
        loadPersistedDataDrivenCatalogue()
        seedBuiltInSources(repository)

        val (mangaCount, sourceCount) = repository.count()

        val runtime = com.nyora.hasan72341.shared.extension.JvmExtensionRuntime(
            networkConfig = networkConfig,
        )
        val facade = NyoraFacade(
            repository = repository,
            runtime = runtime,
        )
        val downloadManager = com.nyora.hasan72341.shared.download.DownloadManager(facade = facade, pageLoader = PageImageLoader(networkConfig))

        // Nyora Sync Sync initialization
        val dataDir = SqlDelightLibraryRepository.defaultDatabasePath().parent
        com.nyora.hasan72341.shared.sync.NyoraSyncConfig.load(dataDir)
        
        if (!HelperProfile.isolated) {
            // Always try loading .env.sync if it exists (prioritize these values)

            // Search for .env.sync in standard locations
            val envPaths = listOf(
                java.nio.file.Path.of(".env.sync"),
                java.nio.file.Path.of("../.env.sync"),
                java.nio.file.Path.of("../../.env.sync")
            )
            for (envSync in envPaths) {
                if (java.nio.file.Files.exists(envSync)) {
                    val props = java.util.Properties()
                    java.nio.file.Files.newInputStream(envSync).use { props.load(it) }
                    props.getProperty("NYORA_SYNC_URL")?.takeIf { it.isNotBlank() }?.let { com.nyora.hasan72341.shared.sync.NyoraSyncConfig.url = it }
                    props.getProperty("GOOGLE_DESKTOP_CLIENT_ID")?.takeIf { it.isNotBlank() }?.let { com.nyora.hasan72341.shared.sync.NyoraSyncConfig.googleDesktopClientId = it }
                    props.getProperty("GOOGLE_SERVER_CLIENT_ID")?.takeIf { it.isNotBlank() }?.let { com.nyora.hasan72341.shared.sync.NyoraSyncConfig.googleServerClientId = it }
                    props.getProperty("GOOGLE_CLIENT_SECRET")?.takeIf { it.isNotBlank() }?.let { com.nyora.hasan72341.shared.sync.NyoraSyncConfig.googleClientSecret = it }
                    break
                }
            }
            run {
                val envSync = Path.of("../.env.sync")
                if (Files.exists(envSync)) {
                    val props = java.util.Properties()
                    Files.newInputStream(envSync).use { props.load(it) }
                    props.getProperty("NYORA_SYNC_URL")
                        ?.takeIf { it.isNotBlank() }
                        ?.let { com.nyora.hasan72341.shared.sync.NyoraSyncConfig.url = it }
                    props.getProperty("GOOGLE_DESKTOP_CLIENT_ID")?.takeIf { it.isNotBlank() }?.let {
                        com.nyora.hasan72341.shared.sync.NyoraSyncConfig.googleDesktopClientId = it
                    }
                    props.getProperty("GOOGLE_SERVER_CLIENT_ID")?.takeIf { it.isNotBlank() }?.let {
                        com.nyora.hasan72341.shared.sync.NyoraSyncConfig.googleServerClientId = it
                    }
                    props.getProperty("GOOGLE_CLIENT_SECRET")?.takeIf { it.isNotBlank() }?.let {
                        com.nyora.hasan72341.shared.sync.NyoraSyncConfig.googleClientSecret = it
                    }
                }
            }
        }

        if (HelperProfile.isolated || com.nyora.hasan72341.shared.sync.NyoraSyncConfig.isConfigured) {
            val sync = com.nyora.hasan72341.shared.sync.NyoraSync(repository, dataDir)
            repository.nyoraSync = sync
            // Trigger an initial pull in the background if we are authenticated
            if (!HelperProfile.isolated && com.nyora.hasan72341.shared.sync.NyoraSyncConfig.isAuthenticated) {
                Thread {
                    sync.refreshToken()
                    sync.pullAll()
                }.also { it.isDaemon = true; it.name = "nyora-sync-initial-pull" }.start()
            }
        }

        return Bootstrap(repository, facade, downloadManager, networkConfig)
    }

    fun createServer(
        boot: Bootstrap,
        port: Int = 0,
        staticRoot: String? = null,
    ): NyoraRestServer = buildServer(boot, port, staticRoot, catalogueDownloader = null)

    /** Internal downloader injection keeps the factory's catalogue wiring integration-testable. */
    internal fun createServer(
        boot: Bootstrap,
        port: Int = 0,
        staticRoot: String? = null,
        catalogueDownloader: (URI) -> String,
    ): NyoraRestServer = buildServer(boot, port, staticRoot, catalogueDownloader)

    private fun buildServer(
        boot: Bootstrap,
        port: Int,
        staticRoot: String?,
        catalogueDownloader: ((URI) -> String)?,
    ): NyoraRestServer = NyoraRestServer(
        facade = boot.facade,
        catalog = SourceCatalogClient(networkConfig = boot.networkConfig),
        installer = ExtensionInstaller(networkConfig = boot.networkConfig),
        pageLoader = PageImageLoader(networkConfig = boot.networkConfig),
        downloads = boot.downloads,
        networkConfig = boot.networkConfig,
        backupRepository = SqlDelightNyoraBackupRepository(boot.repository),
        reseedDataDrivenSources = { seedBuiltInSources(boot.repository) },
        catalogueDownloader = catalogueDownloader ?: { uri ->
            downloadCatalogue(uri, buildCatalogueHttpClient(boot.networkConfig.snapshot()))
        },
        host = if (HelperProfile.isolated) java.net.InetAddress.getByName("127.0.0.1") else java.net.InetAddress.getLoopbackAddress(),
        port = port,
        staticRoot = staticRoot,
    )

    @JvmStatic
    fun main(args: Array<String>) {
        HelperProfile.bearerToken()
        val isolatedPortFile = if (HelperProfile.isolated) HelperProfile.portFile() else null
        if (HelperProfile.isolated) {
            val temporary = HelperProfile.directory("tmp").toString()
            System.setProperty("java.io.tmpdir", temporary)
            System.setProperty("org.sqlite.tmpdir", temporary)
        }
        val processLock = if (HelperProfile.isolated) HelperProfile.acquireProcessLock() else null
        val boot = bootstrap()
        val server = createServer(
            boot = boot,
            // Pin the port for a stable reverse-proxy upstream when hosted (else ephemeral).
            port = if (HelperProfile.isolated) 0 else System.getenv("NYORA_HELPER_PORT")?.toIntOrNull() ?: 0,
        )

        val portFile = isolatedPortFile ?: Path.of(
            System.getProperty("nyora.helper.port-file")
                ?: System.getenv("NYORA_HELPER_PORT_FILE")
                ?: defaultPortFile().toString(),
        )
        try {
            val baseUrl = server.start()
            val port = baseUrl.substringAfterLast(":")
            if (HelperProfile.isolated) {
                persistAtomically(portFile, port)
                HelperProfile.privatePermissions(portFile)
            } else {
                Files.createDirectories(portFile.parent ?: Path.of("."))
                portFile.writeText(port)
            }
            println("Nyora helper listening at $baseUrl")
        } catch (failure: Throwable) {
            server.stop()
            runCatching { boot.repository.driver.close() }
            runCatching { processLock?.close() }
            throw failure
        }

        Runtime.getRuntime().addShutdownHook(Thread {
            runCatching { Files.deleteIfExists(HelperProfile.confine(portFile)) }
            server.stop()
            runCatching { boot.repository.driver.close() }
            runCatching { processLock?.close() }
        })

        // Parent-PID watchdog: if our launcher (SwiftUI app) dies without a
        // clean termination, exit so we don't linger as a zombie helper.
        startParentWatchdog(args)

        Thread.currentThread().join()
    }

    private fun startParentWatchdog(args: Array<String>) {
        val watchedPid = args.firstNotNullOfOrNull { arg ->
            arg.removePrefix("--watch-pid=").takeIf { it != arg && it.isNotBlank() }?.toLongOrNull()
        } ?: System.getProperty("nyora.watch.pid")?.toLongOrNull()
        ?: System.getenv("NYORA_WATCH_PID")?.toLongOrNull()
        ?: return

        val thread = Thread {
            while (true) {
                if (!ProcessHandle.of(watchedPid).map { it.isAlive }.orElse(false)) {
                    System.err.println("Watched parent pid $watchedPid is gone, shutting down helper.")
                    System.exit(0)
                }
                Thread.sleep(1500)
            }
        }
        thread.isDaemon = true
        thread.name = "nyora-parent-watchdog"
        thread.start()
    }

    private fun defaultPortFile(): Path {
        val osName = System.getProperty("os.name", "").lowercase()
        val home = Path.of(System.getProperty("user.home"))
        val dir = when {
            osName.contains("win") -> {
                val appData = System.getenv("APPDATA")?.takeIf { it.isNotBlank() }
                    ?: home.resolve("AppData").resolve("Roaming").toString()
                Path.of(appData, "Nyora")
            }
            osName.contains("mac") ->
                home.resolve("Library").resolve("Application Support").resolve("Nyora")
            else -> {
                val base = System.getenv("XDG_CONFIG_HOME")?.let { Path.of(it) }
                    ?: home.resolve(".config")
                base.resolve("nyora")
            }
        }
        Files.createDirectories(dir)
        return dir.resolve("helper.port")
    }

    /** Store a validated remote catalogue in the same application directory as the helper DB. */
    fun persistDataDrivenCatalogue(remoteJson: String) {
        persistAtomically(dataDrivenCataloguePath(), remoteJson)
    }

    private fun loadPersistedDataDrivenCatalogue() {
        val path = dataDrivenCataloguePath()
        if (!Files.exists(path)) return
        runCatching {
            com.nyora.hasan72341.shared.extension.DataDrivenCatalog.replace(Files.readString(path))
        }.onFailure { error ->
            System.err.println("Saved data-driven catalogue ignored: ${error.message}")
        }
    }

    private fun dataDrivenCataloguePath(): Path =
        HelperProfile.confine(SqlDelightLibraryRepository.defaultDatabasePath().parent.resolve("data-driven-catalogue.json"))

    private fun seedBuiltInSources(repository: SqlDelightLibraryRepository) {
        val sourceCaseMarker = HelperProfile.confine(SqlDelightLibraryRepository.defaultDatabasePath().parent.resolve(".source_id_case_v1"))
        if (!Files.exists(sourceCaseMarker)) {
            repository.migrateDataSourceIdCase()
            Files.writeString(sourceCaseMarker, "v1")
        }
        val current = repository.load()
        val keepRows = current.sources
        val existing = keepRows.associateBy { it.id }

        if (existing.containsKey("demo:javascript")) {
            repository.deleteSource("demo:javascript")
        }

        // The desktop catalogue is the pinned, bundled data-driven source set. Existing
        // rows retain user-controlled installation and pin state across catalogue updates.
        val catalog = com.nyora.hasan72341.shared.extension.DataDrivenCatalog.load()
        val validDataIds = catalog.mapTo(HashSet()) { it.source.id }
        for (entry in catalog) {
            val seed = entry.source
            val id = seed.id
            val prior = existing[id]
            if (prior != null) {
                val updated = prior.copy(
                    name = seed.name,
                    lang = seed.lang,
                    baseUrl = seed.baseUrl,
                    engine = SourceEngine.JavaScript,
                    contentType = seed.contentType,
                    notes = seed.notes,
                    localPath = seed.localPath,
                    canUninstall = false,
                    isNsfw = seed.isNsfw,
                )
                if (updated != prior) repository.upsertSource(updated)
                continue
            }
            repository.upsertSource(seed)
        }

        // Parser-backed rows belong to the retired Kotatsu runtime. Pruning them is safe:
        // library, history, and favourites refer to manga rows, not a source-row foreign key.
        for (row in keepRows) {
            if (row.id.startsWith("parser:") ||
                (row.id.startsWith("data:") && row.id !in validDataIds)
            ) {
                repository.deleteSource(row.id)
            }
        }

        // One-time migration for returning users: remap legacy manga ids (details rows were
        // keyed by url.hashCode) to the cross-platform nyoraId scheme so favourites/history/
        // bookmarks survive the id change and merge with the web app on the next sync.
        // v2 extends the original Parser-only pass to data:/Script rows and native replacements.
        // Existing installations already carry v1, so re-run the idempotent migration once.
        val mangaIdMarker = HelperProfile.confine(SqlDelightLibraryRepository.defaultDatabasePath().parent.resolve(".manga_id_nyora_v2"))
        if (!Files.exists(mangaIdMarker)) {
            runCatching { repository.migrateMangaIdsToNyoraId() }
                .onFailure { System.err.println("manga_id migration failed (non-fatal): ${it.message}") }
                .onSuccess { runCatching { Files.writeString(mangaIdMarker, "v2") } }
        }
    }

}
