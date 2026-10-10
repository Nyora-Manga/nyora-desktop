package com.nyora.hasan72341.shared

import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions

/** Explicit desktop isolation. The existing hosted/native path policy remains the default. */
object HelperProfile {
    const val PROTOCOL = "nyora-desktop-helper/1"
    const val REVISION = "2.0.7-desktop-relay.6"

    val isolated: Boolean get() = System.getProperty("nyora.desktop.isolated") == "true"

    fun bearerToken(): String? {
        if (!isolated) return null
        val token = System.getenv("NYORA_HELPER_TOKEN")
        require(token != null && token.matches(Regex("[A-Za-z0-9_-]{32,256}"))) {
            "Isolated helper requires a per-launch NYORA_HELPER_TOKEN"
        }
        return token
    }

    private fun configuredRoot(): Path {
        val value = System.getProperty("nyora.data.dir")
        require(!value.isNullOrBlank()) { "Isolated helper requires nyora.data.dir" }
        val path = Path.of(value)
        require(path.isAbsolute) { "Isolated profile must be absolute" }
        val root = path.normalize()
        require(root.parent != null) { "Filesystem root cannot be a helper profile" }
        require(!Files.isSymbolicLink(root)) { "Helper profile cannot be a symbolic link" }
        return root
    }

    fun root(): Path {
        val root = configuredRoot()
        Files.createDirectories(root)
        privatePermissions(root, directory = true)
        return root
    }

    /** Reject stored absolute paths and symbolic-link descendants before reads/writes/deletes. */
    fun confine(path: Path): Path {
        if (!isolated) return path
        val root = configuredRoot()
        val normalized = path.normalize()
        require(path.isAbsolute && normalized.startsWith(root)) { "Path is outside isolated profile" }
        var cursor = root
        for (component in root.relativize(normalized)) {
            cursor = cursor.resolve(component)
            require(!Files.isSymbolicLink(cursor)) { "Symbolic links are not allowed in isolated storage" }
        }
        // Also check the existing ancestor physically; absent descendants may be created later.
        var existing = normalized
        while (!Files.exists(existing, LinkOption.NOFOLLOW_LINKS) && existing != root) {
            existing = requireNotNull(existing.parent)
        }
        if (Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            require(existing.toRealPath().startsWith(root.toRealPath())) { "Path escapes isolated profile" }
        }
        return normalized
    }

    fun databasePath(path: Path): Path {
        val database = confine(path)
        if (isolated) {
            for (suffix in listOf("-journal", "-wal", "-shm")) {
                confine(database.resolveSibling(database.fileName.toString() + suffix))
            }
        }
        return database
    }

    fun path(relative: String): Path = confine(root().resolve(relative))

    fun directory(relative: String): Path = path(relative).also {
        Files.createDirectories(it)
        privatePermissions(it, directory = true)
    }

    fun isolatedPath(relative: String): Path? = if (isolated) path(relative) else null

    fun portFile(): Path {
        val value = System.getProperty("nyora.helper.port-file")
        require(!value.isNullOrBlank()) { "Isolated helper requires a private nyora.helper.port-file" }
        return confine(Path.of(value)).also {
            require(it != configuredRoot()) { "Port metadata must be a file" }
        }
    }

    /** Retained for the process lifetime: prevents two helpers from opening the same profile. */
    fun acquireProcessLock(): AutoCloseable {
        val channel = FileChannel.open(path(".helper.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE)
        val lock = try { channel.tryLock() } catch (failure: Throwable) { channel.close(); throw failure }
        if (lock == null) {
            channel.close()
            error("Isolated profile already has a running helper")
        }
        return AutoCloseable { lock.release(); channel.close() }
    }

    fun privatePermissions(path: Path, directory: Boolean = false) {
        if (!isolated || !Files.getFileStore(path).supportsFileAttributeView("posix")) return
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(if (directory) "rwx------" else "rw-------"))
    }
}
