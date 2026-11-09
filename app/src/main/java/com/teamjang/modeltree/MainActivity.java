package com.teamjang.modeltree;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TableLayout;
import android.widget.TableRow;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {

    /** 자주 쓰는 검색어 버튼. 단어를 더 넣으면 버튼이 늘어납니다. */
    private static final String[] QUICK_KEYWORDS = {"볼트", "기준핀"};

    private static final int REQ_PICK_FILES = 1;
    private static final int REQ_PICK_FOLDER = 2;
    private static final int REQ_SAVE_EXCEL = 3;

    private static final String XLSX_MIME =
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private static final String[] EXCEL_HEADERS = {"파일명", "전체이름", "명칭", "규격(M)", "길이", "수량"};
    private static final int[] EXCEL_WIDTHS = {24, 26, 16, 12, 10, 8};

    private final List<Uri> fileUris = new ArrayList<>();
    private final List<String> fileNames = new ArrayList<>();
    private final List<Extractor.Row> rows = new ArrayList<>();
    private final List<Button> keywordButtons = new ArrayList<>();
    private String lastKeyword = "";
    private boolean busy = false;

    private TextView filesInfo;
    private TextView logView;
    private TableLayout table;
    private ScrollView scroll;
    private Button btnPickFiles;
    private Button btnPickFolder;
    private Button btnClearFiles;
    private Button btnSave;
    private Button btnClearLog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        filesInfo = findViewById(R.id.filesInfo);
        logView = findViewById(R.id.log);
        table = findViewById(R.id.table);
        scroll = findViewById(R.id.scroll);
        btnPickFiles = findViewById(R.id.btnPickFiles);
        btnPickFolder = findViewById(R.id.btnPickFolder);
        btnClearFiles = findViewById(R.id.btnClearFiles);
        btnSave = findViewById(R.id.btnSave);
        btnClearLog = findViewById(R.id.btnClearLog);
        LinearLayout keywordRow = findViewById(R.id.keywordRow);

        table.setColumnStretchable(0, true);
        table.setColumnShrinkable(0, true);

        btnPickFiles.setOnClickListener(v -> pickFiles());
        btnPickFolder.setOnClickListener(v -> pickFolder());
        btnClearFiles.setOnClickListener(v -> clearFiles());
        btnSave.setOnClickListener(v -> saveExcel());
        btnClearLog.setOnClickListener(v -> clearLog());

        for (final String kw : QUICK_KEYWORDS) {
            Button b = new Button(this);
            b.setText(kw);
            b.setTextSize(16);
            b.setOnClickListener(v -> runSearch(kw));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMarginStart(dp(8));
            keywordRow.addView(b, lp);
            keywordButtons.add(b);
        }

        refreshFilesInfo();
    }

    // ------------------------------------------------------------------ 파일 선택

    private void pickFiles() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/pdf", "application/octet-stream"});
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(i, REQ_PICK_FILES);
    }

    private void pickFolder() {
        startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_PICK_FOLDER);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;

        if (requestCode == REQ_PICK_FILES) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int k = 0; k < clip.getItemCount(); k++) {
                    Uri u = clip.getItemAt(k).getUri();
                    addFile(u, queryName(u));
                }
            } else if (data.getData() != null) {
                Uri u = data.getData();
                addFile(u, queryName(u));
            }
            refreshFilesInfo();
        } else if (requestCode == REQ_PICK_FOLDER) {
            if (data.getData() != null) addFolder(data.getData());
            refreshFilesInfo();
        } else if (requestCode == REQ_SAVE_EXCEL) {
            if (data.getData() != null) writeExcel(data.getData());
        }
    }

    private boolean addFile(Uri uri, String name) {
        for (Uri existing : fileUris) {
            if (existing.equals(uri)) return false;
        }
        fileUris.add(uri);
        fileNames.add(name);
        return true;
    }

    /** 폴더 안의 PDF 파일을 모두 추가 (하위 폴더는 보지 않음) */
    private void addFolder(Uri tree) {
        int added = 0;
        Cursor c = null;
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree));
            c = getContentResolver().query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null);
            while (c != null && c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) continue;
                if (name != null && name.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
                    if (addFile(DocumentsContract.buildDocumentUriUsingTree(tree, id), name)) added++;
                }
            }
        } catch (Exception e) {
            toast("폴더를 읽지 못했습니다: " + e.getMessage());
        } finally {
            if (c != null) c.close();
        }
        if (added == 0) toast("선택한 폴더에 새로 추가할 PDF 파일이 없습니다.");
    }

    private void clearFiles() {
        fileUris.clear();
        fileNames.clear();
        refreshFilesInfo();
    }

    private void refreshFilesInfo() {
        if (fileNames.isEmpty()) {
            filesInfo.setText("선택된 PDF 없음 — 위 버튼으로 파일이나 폴더를 고르세요.");
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("선택된 PDF ").append(fileNames.size()).append("개");
        int show = Math.min(fileNames.size(), 5);
        for (int i = 0; i < show; i++) {
            sb.append("\n• ").append(fileNames.get(i));
        }
        if (fileNames.size() > show) {
            sb.append("\n… 외 ").append(fileNames.size() - show).append("개");
        }
        filesInfo.setText(sb.toString());
    }

    private String queryName(Uri uri) {
        try (Cursor c = getContentResolver().query(
                uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // 이름을 못 얻으면 아래의 대체 이름 사용
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : uri.toString();
    }

    private long querySize(Uri uri) {
        try (Cursor c = getContentResolver().query(
                uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
            // 크기를 모르면 -1
        }
        return -1;
    }

    // ------------------------------------------------------------------ 검색

    private void runSearch(final String keyword) {
        if (busy) return;
        if (fileUris.isEmpty()) {
            toast("PDF 파일을 먼저 선택해주세요.");
            return;
        }
        setBusy(true);
        clearResults();
        lastKeyword = keyword;
        log("검색어: " + keyword);

        final List<Uri> uris = new ArrayList<>(fileUris);
        final List<String> names = new ArrayList<>(fileNames);

        new Thread(() -> {
            List<Extractor.Row> all = new ArrayList<>();
            for (int i = 0; i < uris.size(); i++) {
                String name = names.get(i);
                log("처리 중: " + name);
                try {
                    List<Extractor.Row> found = searchOne(uris.get(i), name, keyword);
                    all.addAll(found);
                    log("  -> " + found.size() + "개 항목 찾음");
                } catch (OutOfMemoryError oom) {
                    log("  [오류] " + name + " : 메모리가 부족합니다 (파일이 너무 큽니다)");
                } catch (Throwable t) {
                    log("  [오류] " + name + " 처리 실패: " + t.getMessage());
                }
            }
            Extractor.sortRows(all);
            runOnUiThread(() -> showResults(all, keyword));
        }, "search").start();
    }

    private List<Extractor.Row> searchOne(Uri uri, String name, String keyword) throws IOException {
        long size = querySize(uri);
        int cap = (size > 0 && size < Integer.MAX_VALUE - 64) ? (int) size + 1 : (1 << 20);
        byte[] buf = new byte[cap];
        int len = 0;
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("파일을 열 수 없습니다");
            while (true) {
                if (len == buf.length) {
                    long grown = (long) buf.length * 3 / 2 + 1;
                    buf = Arrays.copyOf(buf, (int) Math.min(grown, Integer.MAX_VALUE - 64));
                }
                int n = in.read(buf, len, buf.length - len);
                if (n < 0) break;
                len += n;
            }
        }
        return Extractor.search(name, buf, len, keyword, this::log);
    }

    private void showResults(List<Extractor.Row> all, String keyword) {
        rows.clear();
        rows.addAll(all);
        lastKeyword = keyword;

        table.removeAllViews();
        if (!all.isEmpty()) {
            addTableRow("전체이름", "규격", "길이", "수량", true, 0);
            int index = 0;
            for (Extractor.Row r : all) {
                index++;
                addTableRow(r.fullName, r.size, r.length, String.valueOf(r.qty), false, index);
            }
        }
        logView.append("완료. 총 " + all.size() + "개 항목 찾음. (규격 순 정렬)\n");
        setBusy(false);
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private void addTableRow(String a, String b, String c, String d, boolean header, int index) {
        TableRow row = new TableRow(this);
        int bg = header ? Color.parseColor("#DDE3F5")
                : (index % 2 == 0 ? Color.parseColor("#EEF0F7") : Color.WHITE);
        row.setBackgroundColor(bg);
        row.addView(cell(a, header, Gravity.START | Gravity.CENTER_VERTICAL));
        row.addView(cell(b, header, Gravity.CENTER));
        row.addView(cell(c, header, Gravity.CENTER));
        row.addView(cell(d, header, Gravity.CENTER));
        table.addView(row, new TableLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private TextView cell(String text, boolean bold, int gravity) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(13);
        tv.setTextColor(Color.BLACK);
        tv.setGravity(gravity);
        tv.setPadding(dp(6), dp(7), dp(6), dp(7));
        if (bold) tv.setTypeface(Typeface.DEFAULT_BOLD);
        return tv;
    }

    // ------------------------------------------------------------------ 엑셀 저장

    private void saveExcel() {
        if (rows.isEmpty()) {
            toast("저장할 데이터가 없습니다.");
            return;
        }
        String stamp = new SimpleDateFormat("yyyyMMdd_HHmm", Locale.US).format(new Date());
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(XLSX_MIME);
        i.putExtra(Intent.EXTRA_TITLE, "검색결과_" + lastKeyword + "_" + stamp + ".xlsx");
        startActivityForResult(i, REQ_SAVE_EXCEL);
    }

    private void writeExcel(Uri uri) {
        List<Object[]> data = new ArrayList<>();
        for (Extractor.Row r : rows) {
            data.add(new Object[]{r.fileName, r.fullName, r.label, r.size, r.length, r.qty});
        }
        try (OutputStream os = getContentResolver().openOutputStream(uri, "wt")) {
            if (os == null) throw new IOException("저장 위치를 열 수 없습니다");
            XlsxWriter.write(os, "검색결과", EXCEL_HEADERS, data, EXCEL_WIDTHS);
            toast("엑셀 파일로 저장되었습니다.");
            log("엑셀 저장 완료: " + queryName(uri));
        } catch (Exception e) {
            toast("저장 실패: " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------ 화면 도우미

    private void clearLog() {
        if (busy) return;
        clearResults();
        rows.clear();
        btnSave.setEnabled(false);
    }

    private void clearResults() {
        logView.setText("");
        table.removeAllViews();
    }

    private void setBusy(boolean value) {
        busy = value;
        for (Button b : keywordButtons) b.setEnabled(!value);
        btnPickFiles.setEnabled(!value);
        btnPickFolder.setEnabled(!value);
        btnClearFiles.setEnabled(!value);
        btnClearLog.setEnabled(!value);
        btnSave.setEnabled(!value && !rows.isEmpty());
    }

    /** 어느 스레드에서 불러도 안전한 로그 출력 */
    private void log(final String msg) {
        runOnUiThread(() -> {
            logView.append(msg + "\n");
            scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}
