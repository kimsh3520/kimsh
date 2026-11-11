package com.sfe.pdf3dviewer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * PDF 3D Viewer for Android.
 * The viewer itself (U3D decoder + three.js renderer) lives in assets/index.html;
 * this activity hosts it in a WebView and hands it files picked by the user or
 * opened from other apps ("open with").
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK_FILE = 1001;
    private static final int MAX_BYTES = 200 * 1024 * 1024;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private volatile byte[] pendingBytes;
    private volatile String pendingName;
    private volatile boolean pageReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#1e293b"));
        w.setNavigationBarColor(Color.parseColor("#1e293b"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f4f6f8"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100); // keep the layout independent of the system font size

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !"file".equals(request.getUrl().getScheme());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[]{"application/pdf", "application/octet-stream", "model/u3d"});
                try {
                    startActivityForResult(i, REQ_PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "파일 선택 창을 열 수 없습니다", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        web.loadUrl("file:///android_asset/index.html");
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** "Open with" / "Share" from a file manager, e-mail, messenger ... */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;
        final Uri target = uri;
        new Thread(() -> {
            try {
                byte[] data = readAll(target);
                pendingName = displayName(target);
                pendingBytes = data;
                if (pageReady) runOnUiThread(this::notifyPage);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "파일을 읽을 수 없습니다: " + e.getMessage(),
                        Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void notifyPage() {
        if (pendingBytes == null) return;
        String name = pendingName == null ? "도면.pdf" : pendingName;
        web.evaluateJavascript("window.openFromAndroid && window.openFromAndroid("
                + JSONObject.quote(name) + ")", null);
    }

    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) throw new Exception("빈 파일");
            byte[] buf = new byte[64 * 1024];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new Exception("파일이 너무 큽니다");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null ? "도면.pdf" : name;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.handleBack ? window.handleBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("AndroidBridge");
            web.destroy();
        }
        super.onDestroy();
    }

    /** Methods callable from the page as window.AndroidBridge.* */
    private class Bridge {
        @JavascriptInterface
        public void appReady() {
            pageReady = true;
            if (pendingBytes != null) runOnUiThread(MainActivity.this::notifyPage);
        }

        @JavascriptInterface
        public String takePendingFile() {
            byte[] b = pendingBytes;
            pendingBytes = null;
            return b == null ? "" : Base64.encodeToString(b, Base64.NO_WRAP);
        }

        @JavascriptInterface
        public void showDialog(final String title, final String text) {
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle(title)
                    .setMessage(text)
                    .setPositiveButton("확인", null)
                    .show());
        }
    }
}
