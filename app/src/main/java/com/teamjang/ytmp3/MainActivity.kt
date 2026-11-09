package com.teamjang.ytmp3

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.view.WindowManager
import android.widget.*
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.*
import java.io.File

class MainActivity : Activity() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var job: Job? = null
    private var stopRequested = false
    private val processId = "ytmp3"

    private lateinit var urls: EditText
    private lateinit var quality: Spinner
    private lateinit var playlist: CheckBox
    private lateinit var meta: CheckBox
    private lateinit var btnGo: Button
    private lateinit var btnStop: Button
    private lateinit var btnUpdate: Button
    private lateinit var status: TextView
    private lateinit var bar: ProgressBar
    private lateinit var log: TextView
    private lateinit var logScroll: ScrollView

    private val outDir: File
        get() = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "SH MP3"
        )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        urls = findViewById(R.id.urls)
        quality = findViewById(R.id.quality)
        playlist = findViewById(R.id.playlist)
        meta = findViewById(R.id.meta)
        btnGo = findViewById(R.id.btnGo)
        btnStop = findViewById(R.id.btnStop)
        btnUpdate = findViewById(R.id.btnUpdate)
        status = findViewById(R.id.status)
        bar = findViewById(R.id.bar)
        log = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)

        quality.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            listOf("128 kbps", "192 kbps", "320 kbps")
        )
        quality.setSelection(prefs().getInt("q", 1))

        findViewById<Button>(R.id.btnPaste).setOnClickListener { paste() }
        findViewById<Button>(R.id.btnClear).setOnClickListener { urls.setText("") }
        btnGo.setOnClickListener { startDownload() }
        btnStop.setOnClickListener { stop() }
        btnUpdate.setOnClickListener { updateEngine() }

        if (Build.VERSION.SDK_INT <= 28 &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
        }

        setBusy(true)
        btnStop.isEnabled = false
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                try {
                    YoutubeDL.getInstance().init(applicationContext)
                    FFmpeg.getInstance().init(applicationContext)
                    true
                } catch (e: Exception) {
                    appendLog("초기화 실패: ${e.message}"); false
                }
            }
            if (ok) {
                status.text = "엔진 최신 버전 확인 중..."
                withContext(Dispatchers.IO) { doUpdate(quiet = true) }
                status.text = "준비 완료"
                appendLog("준비 완료. 유튜브 앱에서 [공유 → SH MP3]를 누르거나 주소를 붙여넣으세요.")
            }
            setBusy(false)
            handleShare(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    private fun handleShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        val url = Regex("https?://\\S+").find(text)?.value ?: return
        intent.action = null
        urls.setText(url)
        if (!isBusy()) startDownload()
        else appendLog("다른 작업 중이라 주소만 넣어 두었습니다: $url")
    }

    private fun prefs() = getSharedPreferences("ytmp3", Context.MODE_PRIVATE)

    private fun paste() {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        val t = cm.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()?.trim()
        if (t.isNullOrEmpty()) { toast("클립보드가 비어 있습니다"); return }
        val cur = urls.text.toString().trim()
        urls.setText(if (cur.isEmpty()) t else "$cur\n$t")
    }

    private var busy = false
    private fun isBusy() = busy
    private fun setBusy(b: Boolean) {
        busy = b
        btnGo.isEnabled = !b
        btnUpdate.isEnabled = !b
        btnStop.isEnabled = b
        if (b) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun appendLog(msg: String) {
        runOnUiThread {
            log.append(msg + "\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_SHORT).show()

    private fun isMix(url: String): Boolean = try {
        (Uri.parse(url).getQueryParameter("list") ?: "").uppercase().startsWith("RD")
    } catch (e: Exception) { false }

    private fun startDownload() {
        val list = urls.text.toString().lines().map { it.trim() }.filter { it.isNotEmpty() }
        if (list.isEmpty()) { toast("유튜브 주소를 입력하세요"); return }
        val kbps = when (quality.selectedItemPosition) { 0 -> 128; 2 -> 320; else -> 192 }
        prefs().edit().putInt("q", quality.selectedItemPosition).apply()
        val wantPlaylist = playlist.isChecked
        val wantMeta = meta.isChecked
        val dir = outDir.apply { mkdirs() }

        stopRequested = false
        setBusy(true)
        val wl = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ytmp3:dl").apply { acquire(60 * 60 * 1000L) }

        job = scope.launch {
            var ok = 0; var fail = 0
            val saved = mutableListOf<String>()
            for ((i, url) in list.withIndex()) {
                if (stopRequested) break
                appendLog("── (${i + 1}/${list.size}) $url")
                val pl = wantPlaylist && !isMix(url)
                if (wantPlaylist && isMix(url)) appendLog("· 유튜브 '믹스' 주소라서 이 곡 하나만 받습니다.")
                bar.progress = 0
                val result = withContext(Dispatchers.IO) {
                    runCatching {
                        val req = YoutubeDLRequest(url).apply {
                            addOption("-f", "bestaudio/best")
                            addOption("-x")
                            addOption("--audio-format", "mp3")
                            addOption("--audio-quality", "${kbps}K")
                            addOption("-P", dir.absolutePath)
                            addOption("-o", "%(title)s.%(ext)s")
                            addOption("--windows-filenames")
                            addOption("--no-mtime")
                            addOption("--newline")
                            addOption("--ignore-errors")
                            addOption(if (pl) "--yes-playlist" else "--no-playlist")
                            if (wantMeta) {
                                addOption("--embed-metadata")
                                addOption("--embed-thumbnail")
                                addOption("--convert-thumbnails", "jpg")
                            }
                        }
                        YoutubeDL.getInstance().execute(req, processId) { progress, _, line ->
                            onLine(i, list.size, progress, line, saved)
                        }
                    }
                }
                if (stopRequested) break
                result.onSuccess { ok++ }.onFailure { e ->
                    fail++
                    appendLog("✖ 실패: " + (e.message ?: e.toString()).lines()
                        .filter { it.contains("ERROR") }.ifEmpty { listOf(e.toString()) }
                        .joinToString("\n").take(500))
                }
            }
            if (saved.isNotEmpty()) {
                MediaScannerConnection.scanFile(this@MainActivity, saved.toTypedArray(), null, null)
            }
            if (wl.isHeld) wl.release()
            setBusy(false)
            if (stopRequested) {
                status.text = "중지됨"
            } else {
                bar.progress = 1000
                status.text = "끝: 성공 ${ok}건, 실패 ${fail}건 (파일 ${saved.size}개)"
                toast("다운로드 완료: 파일 ${saved.size}개")
            }
        }
    }

    private fun onLine(i: Int, n: Int, progress: Float, line: String, saved: MutableList<String>) {
        runOnUiThread {
            if (progress >= 0) bar.progress = (progress * 10).toInt()
            when {
                line.startsWith("[download] Downloading item") ->
                    appendLog("· " + line.removePrefix("[download] ").replace("Downloading item", "재생목록 곡"))
                line.startsWith("[download]") && line.contains("%") ->
                    status.text = "(${i + 1}/$n) 받는 중 ${"%.1f".format(progress)}%"
                line.startsWith("[ExtractAudio] Destination:") -> {
                    val path = line.substringAfter("Destination:").trim()
                    saved.add(path)
                    status.text = "(${i + 1}/$n) MP3 변환 중..."
                    appendLog("✔ " + File(path).name)
                }
                line.contains("has already been downloaded") ->
                    appendLog("· 이미 있음: " + line.substringAfter("[download] "))
            }
        }
    }

    private fun stop() {
        stopRequested = true
        YoutubeDL.getInstance().destroyProcessById(processId)
        job?.cancel()
        appendLog("사용자가 중지했습니다.")
        setBusy(false)
        status.text = "중지됨"
    }

    private fun doUpdate(quiet: Boolean) {
        try {
            val st = YoutubeDL.getInstance().updateYoutubeDL(applicationContext)
            val ver = YoutubeDL.getInstance().version(applicationContext)
            if (!quiet || st == YoutubeDL.UpdateStatus.DONE)
                appendLog(if (st == YoutubeDL.UpdateStatus.DONE) "엔진 업데이트 완료 ($ver)" else "엔진이 최신입니다 ($ver)")
        } catch (e: Exception) {
            appendLog("엔진 업데이트 확인 실패: ${e.message?.take(200)}")
        }
    }

    private fun updateEngine() {
        setBusy(true); btnStop.isEnabled = false
        status.text = "엔진 업데이트 중..."
        scope.launch {
            withContext(Dispatchers.IO) { doUpdate(quiet = false) }
            status.text = "준비 완료"
            setBusy(false)
        }
    }

    override fun onDestroy() {
        if (busy) YoutubeDL.getInstance().destroyProcessById(processId)
        scope.cancel()
        super.onDestroy()
    }
}
