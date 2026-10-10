import java.io.File as JFile
import java.util.zip.ZipFile

// Self-contained build of the Nyora parser helper directly from this repo's
// source (src/). Produces the deployable fat jar `nyora-helper.jar`
// (Main-Class = HelperMain, the native kotatsu-parsers REST engine). The CI
// deploy workflow builds this and rolls it out to the api.nyora.xyz cluster.
plugins {
    kotlin("multiplatform")        version "2.1.21"
    kotlin("plugin.serialization") version "2.1.21"
    id("app.cash.sqldelight")      version "2.1.0"
}

group = "com.nyora"
version = "2.0.7"

val sharedSrc: String = "${projectDir}/src"

// Bundle the data-driven catalogue from the `data/` submodule as a classpath
// resource (nyora/catalogue.json) so the runtime works offline and every build
// ships the exact catalogue of the pinned submodule commit.
val dataDrivenResDir = layout.buildDirectory.dir("generated/datadriven-res")

val bundleDataDrivenCatalogue = tasks.register<Copy>("bundleDataDrivenCatalogue") {
    from("$projectDir/data/catalogue.json", "$projectDir/data/blocked-sources.json")
    into(dataDrivenResDir.map { it.dir("nyora") })
}

tasks.matching { it.name == "jvmProcessResources" }.configureEach {
    dependsOn(bundleDataDrivenCatalogue)
}

sqldelight {
    databases {
        create("NyoraDatabase") {
            packageName.set("com.nyora.hasan72341.shared.db")
            srcDirs.from(file("$sharedSrc/commonMain/sqldelight"))
        }
    }
}

kotlin {
    jvmToolchain(17)
    jvm()

    compilerOptions {
        // data/engine uses non-local break/continue (stable in 2.2; preview in 2.1).
        freeCompilerArgs.add("-Xnon-local-break-continue")
    }

    sourceSets {
        val commonMain by getting {
            kotlin.srcDirs("$sharedSrc/commonMain/kotlin")
            resources.srcDirs("$sharedSrc/commonMain/resources")
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
                implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.6.1")
                implementation("app.cash.sqldelight:runtime:2.1.0")
                implementation("app.cash.sqldelight:coroutines-extensions:2.1.0")
            }
        }
        val jvmMain by getting {
            kotlin.srcDirs(
                "$sharedSrc/jvmMain/kotlin",
                // Data-driven runtime from the nyora-data-driven submodule:
                // 35+ generic engines + EngineRegistry + core model. Compiled
                // in-tree (no Maven/JitPack artifact) so shared and data stay
                // pinned to the same commit.
                "$projectDir/data/engine",
                "$projectDir/data/src/main/kotlin",
            )
            resources.srcDirs("$sharedSrc/jvmMain/resources", dataDrivenResDir)
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.10.2")
                implementation("app.cash.sqldelight:sqlite-driver:2.1.0")
                // OkHttp 5 — aligned with kotatsu-parsers-redo.
                implementation("com.squareup.okhttp3:okhttp:5.1.0")
                implementation("com.squareup.okhttp3:okhttp-dnsoverhttps:5.1.0")
                implementation("org.jsoup:jsoup:1.21.2")
                // Native Kotatsu parsers (the in-process parser engine).
                implementation("com.github.clquwu:kotatsu-parsers-redo:59c033ecfd")
                implementation("org.json:json:20240303")
            }
        }
        val jvmTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation("com.squareup.okhttp3:mockwebserver3:5.1.0")
                implementation("com.squareup.okhttp3:okhttp-tls:5.1.0")
            }
        }
    }
}

// --- Fat JAR (Main-Class = HelperMain) for the headless REST helper ---

val mergedServicesDir = layout.buildDirectory.dir("merged-services").map { it.asFile }

tasks.register("mergeServiceFiles") {
    group = "build"
    val jvmMain = kotlin.targets.getByName("jvm").compilations.getByName("main")
    inputs.files(jvmMain.runtimeDependencyFiles)
    outputs.dir(mergedServicesDir)
    doLast {
        val outDir = mergedServicesDir.get()
        outDir.deleteRecursively()
        val servicesOut = JFile(outDir, "META-INF/services").apply { mkdirs() }
        val accum = mutableMapOf<String, StringBuilder>()
        jvmMain.runtimeDependencyFiles!!
            .filter { it.isFile && it.name.endsWith(".jar") }
            .forEach { jar ->
                ZipFile(jar).use { zf ->
                    val entries = zf.entries()
                    while (entries.hasMoreElements()) {
                        val entry = entries.nextElement()
                        if (!entry.isDirectory &&
                            entry.name.startsWith("META-INF/services/") &&
                            entry.name.length > "META-INF/services/".length
                        ) {
                            val key = entry.name.removePrefix("META-INF/services/")
                            val text = zf.getInputStream(entry).bufferedReader().readText()
                            accum.getOrPut(key) { StringBuilder() }.append(text).append('\n')
                        }
                    }
                }
            }
        accum.forEach { (name, content) -> JFile(servicesOut, name).writeText(content.toString()) }
    }
}

tasks.register<Jar>("helperJar") {
    group = "build"
    description = "Deployable fat JAR for the headless Nyora parser helper."
    archiveBaseName.set("nyora-helper")
    archiveVersion.set("")
    archiveClassifier.set("")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest {
        attributes(
            "Main-Class" to "com.nyora.hasan72341.shared.HelperMain",
            "Multi-Release" to "true",
        )
    }
    val jvmMain = kotlin.targets.getByName("jvm").compilations.getByName("main")
    dependsOn(jvmMain.compileTaskProvider, "jvmProcessResources", "mergeServiceFiles")
    from(jvmMain.output.allOutputs, mergedServicesDir)
    from(provider {
        jvmMain.runtimeDependencyFiles!!
            .filter { it.isDirectory || it.name.endsWith(".jar") }
            .map { if (it.isDirectory) it else zipTree(it) }
    }) {
        exclude(
            "META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/*.EC",
            "META-INF/MANIFEST.MF", "META-INF/LICENSE", "META-INF/LICENSE.txt",
            "META-INF/NOTICE", "META-INF/NOTICE.txt", "META-INF/services/**",
            "module-info.class",
        )
    }
}

// Tests must never discover a developer's native profile or working-directory .env files.
tasks.withType<Test>().configureEach {
    val sandbox = layout.buildDirectory.dir("test-sandbox").get().asFile
    val testHome = JFile(sandbox, "home")
    val testWork = JFile(sandbox, "work")
    systemProperty("user.home", testHome.absolutePath)
    environment("NYORA_HELPER_TOKEN", "isolated-test-token-0123456789abcdef")
    environment("XDG_DATA_HOME", JFile(sandbox, "data").absolutePath)
    environment("XDG_CONFIG_HOME", JFile(sandbox, "config").absolutePath)
    environment("APPDATA", JFile(sandbox, "appdata").absolutePath)
    environment("NYORA_CACHE_DIR", JFile(sandbox, "cache").absolutePath)
    workingDir(testWork)
    doFirst { testHome.mkdirs(); testWork.mkdirs() }
}
