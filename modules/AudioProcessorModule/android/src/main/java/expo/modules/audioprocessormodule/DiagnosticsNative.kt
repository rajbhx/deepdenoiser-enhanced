package expo.modules.audioprocessormodule

import android.Manifest
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.BatteryManager
import android.os.Debug
import android.os.PowerManager
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * Read-only device information plus an explicitly opted-in, bounded diagnostic
 * event store. The store has its own allowlist and lives in noBackupFilesDir;
 * it never accepts paths, URIs, filenames, raw exception text or media hashes.
 * It does not change the app's existing backup or recording configuration.
 */
internal object DiagnosticsNative {
    private val lock = Any()
    private const val MAX_BYTES = 32 * 1024
    private const val MAX_EVENTS = 50
    private val domains = setOf("app", "ui", "import", "share", "process", "record", "export", "diagnostics", "model")
    private val stages = setOf("general", "prepare", "cache", "decode", "analyze", "model", "denoise", "finalize", "mux", "import", "share", "record-start", "record-stop", "export", "self-check", "storage")
    private val codes = setOf("START", "OK", "FAIL_MEMORY", "FAIL_STORAGE", "FAIL_PERMISSION", "FAIL_DECODE", "FAIL_MODEL", "FAIL_INTEGRITY", "FAIL_IO", "FAIL_RECORDER", "FAIL_UNKNOWN", "CANCELLED", "INTERRUPTED")
    private val levels = setOf("info", "warning", "error")

    private fun diagnosticFile(context: Context) = AtomicFile(File(context.noBackupFilesDir, "diagnostic_history_v1.json"))

    fun readHistory(context: Context): String? = synchronized(lock) {
        val file = diagnosticFile(context)
        try {
            file.openRead().use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > MAX_BYTES) throw IllegalStateException("Diagnostic history exceeds the size limit")
                    output.write(buffer, 0, count)
                }
                String(output.toByteArray(), Charsets.UTF_8)
            }
        } catch (_: java.io.FileNotFoundException) {
            null
        }
    }

    /** Rebuild the JSON from an allowlist rather than persisting supplied text. */
    fun writeHistory(context: Context, json: String) = synchronized(lock) {
        require(json.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Diagnostic history is too large" }
        val parsed = JSONObject(json)
        require(parsed.optInt("version", 0) == 1 && parsed.optBoolean("enabled", false)) { "Invalid diagnostic history" }
        val source = parsed.getJSONArray("events")
        require(source.length() <= MAX_EVENTS) { "Too many diagnostic events" }
        val safeEvents = JSONArray()
        for (i in 0 until source.length()) {
            val event = source.getJSONObject(i)
            val domain = event.getString("domain")
            val stage = event.getString("stage")
            val code = event.getString("code")
            val level = event.getString("level")
            val time = event.getLong("time")
            require(domain in domains && stage in stages && code in codes && level in levels && time >= 0) {
                "Invalid diagnostic event"
            }
            val safe = JSONObject().put("domain", domain).put("stage", stage).put("code", code)
                .put("level", level).put("time", time)
            if (event.has("elapsedMs")) {
                val elapsed = event.getLong("elapsedMs")
                require(elapsed in 0..86400000L) { "Invalid diagnostic duration" }
                safe.put("elapsedMs", elapsed)
            }
            safeEvents.put(safe)
        }
        val safeJson = JSONObject().put("version", 1).put("enabled", true).put("events", safeEvents).toString()
        val atomic = diagnosticFile(context)
        val stream = atomic.startWrite()
        try {
            stream.write(safeJson.toByteArray(Charsets.UTF_8))
            atomic.finishWrite(stream)
        } catch (error: Exception) {
            atomic.failWrite(stream)
            throw error
        }
    }

    fun deleteHistory(context: Context) = synchronized(lock) {
        val atomic = diagnosticFile(context)
        atomic.delete()
        val base = atomic.baseFile
        if (base.exists() || File(base.path + ".bak").exists() || File(base.path + ".new").exists()) {
            throw IllegalStateException("Diagnostic history could not be removed")
        }
    }

    private fun permission(context: Context, name: String): Boolean =
        context.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED

    private fun signer(context: Context): android.content.pm.Signature? = try {
        @Suppress("DEPRECATION")
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageInfo(context.packageName, flags)
        @Suppress("DEPRECATION")
        val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        signatures?.firstOrNull()
    } catch (_: Exception) { null }

    private fun certificateSha256(signature: android.content.pm.Signature?): String? = try {
        signature?.let { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) } }
    } catch (_: Exception) { null }

    // This is a certificate subject hint, not proof of trust or production readiness.
    private fun hasDebugSubject(signature: android.content.pm.Signature?): Boolean? = try {
        signature?.let {
            val certificate = CertificateFactory.getInstance("X.509").generateCertificate(it.toByteArray().inputStream()) as X509Certificate
            certificate.subjectX500Principal.name.contains("CN=Android Debug", ignoreCase = true)
        }
    } catch (_: Exception) { null }

    private fun exitReason(code: Int): String = when (code) {
        ApplicationExitInfo.REASON_CRASH -> "Java crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "Native crash"
        ApplicationExitInfo.REASON_ANR -> "App not responding"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "Low memory"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "User requested or system action"
        ApplicationExitInfo.REASON_USER_STOPPED -> "User stopped"
        ApplicationExitInfo.REASON_SIGNALED -> "Process signal"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Resource limit"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "Initialization failure"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "Permission changed"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "Dependency stopped"
        ApplicationExitInfo.REASON_OTHER -> "Other"
        else -> "Unknown"
    }

    fun getInfo(context: Context): Map<String, Any?> {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo().also { activityManager.getMemoryInfo(it) }
        val notifications = (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()
        @Suppress("DEPRECATION")
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val versionCode = if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else packageInfo.versionCode.toLong()
        val previousExit: Map<String, Any?>? = if (Build.VERSION.SDK_INT >= 30) {
            try {
                activityManager.getHistoricalProcessExitReasons(context.packageName, 0, 1).firstOrNull()?.let {
                    mapOf("reason" to exitReason(it.reason), "time" to it.timestamp)
                }
            } catch (_: Exception) { null }
        } else null
        val mediaAudioPermission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        val mediaVideoPermission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO else Manifest.permission.READ_EXTERNAL_STORAGE
        val signature = signer(context)
        val batteryPercent = try {
            val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
        } catch (_: Exception) { null }
        val thermalStatus = if (Build.VERSION.SDK_INT >= 29) try {
            (context.getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus
        } catch (_: Exception) { null } else null
        return mapOf(
            "packageName" to context.packageName,
            "versionName" to (packageInfo.versionName ?: "unknown"),
            "versionCode" to versionCode,
            "debuggable" to ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0),
            "certificateSha256" to certificateSha256(signature),
            "androidDebugSubject" to hasDebugSubject(signature),
            "manufacturer" to Build.MANUFACTURER,
            "model" to Build.MODEL,
            "androidVersion" to Build.VERSION.RELEASE,
            "sdk" to Build.VERSION.SDK_INT,
            "abi" to (Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"),
            "cpuCount" to Runtime.getRuntime().availableProcessors(),
            "batteryPercent" to batteryPercent,
            "thermalStatus" to thermalStatus,
            "totalMemoryBytes" to memory.totalMem,
            "availableMemoryBytes" to memory.availMem,
            "lowMemory" to memory.lowMemory,
            "processPssBytes" to (Debug.getPss().toLong() * 1024L),
            "freeStorageBytes" to context.filesDir.usableSpace,
            "totalStorageBytes" to context.filesDir.totalSpace,
            "microphoneGranted" to permission(context, Manifest.permission.RECORD_AUDIO),
            "notificationsEnabled" to notifications,
            "mediaAudioGranted" to permission(context, mediaAudioPermission),
            "mediaVideoGranted" to permission(context, mediaVideoPermission),
            "previousExit" to previousExit,
        )
    }
}
