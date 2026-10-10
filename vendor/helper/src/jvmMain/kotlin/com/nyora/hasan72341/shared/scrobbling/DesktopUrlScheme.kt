package com.nyora.hasan72341.shared.scrobbling

import com.nyora.hasan72341.shared.HelperProfile
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import kotlin.concurrent.thread

/**
 * Desktop `nyora://` URL-scheme plumbing shared by the Windows and Linux apps.
 *
 * Tracker sign-in on desktop redirects to `nyora://<slug>-auth?code=...` — the
 * same custom scheme the mobile / mac apps use, and the only redirect the
 * providers have registered. The OS launches this app to handle that URL, so we:
 *  1. Register the app as the handler for the `nyora` scheme (idempotent).
 *  2. Stay single-instance: the OS-spawned handler process forwards the URL to
 *     the already-running app (which holds the pending OAuth waiter) and exits.
 *
 * Instance coordination uses a loopback [ServerSocket] on [COORD_PORT]. Whoever
 * binds it first is the primary; later launches that carry a `nyora://` URL
 * connect, hand it over, and exit. (This is IPC only — never an OAuth redirect,
 * so it needs no provider registration.)
 */
object DesktopUrlScheme {

    private const val COORD_PORT = 43219
    private const val SCHEME = "nyora"

    /**
     * Wire up scheme handling. Returns true if THIS process should exit
     * immediately — it was only spawned to deliver a URL to the running primary.
     *
     * @param args process args (a `nyora://` URL may be among them).
     * @param onUrl invoked on the primary with each captured callback URL.
     */
    fun install(args: Array<String>, onUrl: (String) -> Unit): Boolean {
        check(!HelperProfile.isolated) { "Isolated desktop OAuth callbacks must be owned by the launcher" }
        val url = args.firstOrNull { it.startsWith("$SCHEME://") }

        // Carry a URL and a primary is already up → hand it off and exit.
        if (url != null && forwardToPrimary(url)) return true

        // Try to become the primary by binding the coordination socket.
        val server = runCatching {
            ServerSocket(COORD_PORT, 16, InetAddress.getByName("127.0.0.1"))
        }.getOrNull()

        if (server != null) {
            thread(isDaemon = true, name = "nyora-url-coordinator") {
                while (!server.isClosed) {
                    val incoming = runCatching { server.accept() }.getOrNull() ?: continue
                    incoming.use { sock ->
                        val line = runCatching {
                            BufferedReader(
                                InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8)
                            ).readLine()
                        }.getOrNull()
                        if (!line.isNullOrBlank()) runCatching { onUrl(line.trim()) }
                    }
                }
            }
            Runtime.getRuntime().addShutdownHook(Thread { runCatching { server.close() } })
        }

        registerHandler()

        // Cold start that carried a URL with no primary running: we ARE the primary
        // now, so deliver to ourselves (best-effort; a fresh process rarely holds a
        // matching pending waiter, but this keeps the path correct).
        if (url != null && server != null) runCatching { onUrl(url) }

        return false
    }

    private fun forwardToPrimary(url: String): Boolean = runCatching {
        Socket(InetAddress.getByName("127.0.0.1"), COORD_PORT).use { sock ->
            OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8).use { w ->
                w.write(url)
                w.write("\n")
                w.flush()
            }
        }
        true
    }.getOrDefault(false)

    /** Register this executable as the OS handler for `nyora://` (idempotent, best-effort). */
    private fun registerHandler() {
        val os = System.getProperty("os.name", "").lowercase()
        val exe = currentExecutable() ?: return
        runCatching {
            when {
                os.contains("win") -> registerWindows(exe)
                os.contains("nux") || os.contains("nix") -> registerLinux(exe)
            }
        }
    }

    private fun currentExecutable(): String? =
        runCatching { ProcessHandle.current().info().command().orElse(null) }.getOrNull()

    private fun registerWindows(exe: String) {
        // HKCU\Software\Classes\nyora — per-user, no admin rights needed.
        val base = "HKCU\\Software\\Classes\\$SCHEME"
        fun reg(vararg a: String) = runCatching {
            ProcessBuilder(listOf("reg", "add", *a, "/f"))
                .redirectErrorStream(true).start().waitFor()
        }
        reg(base, "/ve", "/d", "URL:Nyora Protocol")
        reg(base, "/v", "URL Protocol", "/d", "")
        reg("$base\\shell\\open\\command", "/ve", "/d", "\"$exe\" \"%1\"")
    }

    private fun registerLinux(exe: String) {
        val home = System.getProperty("user.home") ?: return
        val appsDir = File("$home/.local/share/applications").apply { mkdirs() }
        val desktop = File(appsDir, "nyora-url-handler.desktop")
        desktop.writeText(
            """
            [Desktop Entry]
            Type=Application
            Name=Nyora URL Handler
            Exec=$exe %u
            StartupNotify=false
            NoDisplay=true
            MimeType=x-scheme-handler/$SCHEME;
            """.trimIndent() + "\n"
        )
        runCatching {
            ProcessBuilder("xdg-mime", "default", "nyora-url-handler.desktop", "x-scheme-handler/$SCHEME")
                .redirectErrorStream(true).start().waitFor()
        }
        runCatching {
            ProcessBuilder("update-desktop-database", appsDir.absolutePath)
                .redirectErrorStream(true).start().waitFor()
        }
    }
}
