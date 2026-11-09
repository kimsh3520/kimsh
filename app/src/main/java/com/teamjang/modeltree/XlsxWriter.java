package com.teamjang.modeltree;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** 외부 라이브러리 없이 만드는 최소한의 .xlsx 작성기 (첫 줄은 굵은 글씨 머리글). */
public final class XlsxWriter {

    private static final String XML_HEAD = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

    private static final String CONTENT_TYPES = XML_HEAD
            + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
            + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
            + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
            + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
            + "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
            + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
            + "</Types>";

    private static final String ROOT_RELS = XML_HEAD
            + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
            + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>"
            + "</Relationships>";

    private static final String WORKBOOK_RELS = XML_HEAD
            + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
            + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>"
            + "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
            + "</Relationships>";

    private static final String STYLES = XML_HEAD
            + "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">"
            + "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font>"
            + "<font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>"
            + "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill>"
            + "<fill><patternFill patternType=\"gray125\"/></fill></fills>"
            + "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
            + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
            + "<cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
            + "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>"
            + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>"
            + "</styleSheet>";

    private XlsxWriter() {
    }

    /**
     * @param headers 첫 줄에 들어갈 머리글
     * @param rows    각 줄의 값 (String 은 글자, Integer/Long/Double 은 숫자로 저장)
     * @param widths  열 너비(글자 수 기준). 머리글 개수와 같아야 함
     */
    public static void write(OutputStream os, String sheetName, String[] headers,
                             List<Object[]> rows, int[] widths) throws IOException {
        ZipOutputStream zip = new ZipOutputStream(os);
        putEntry(zip, "[Content_Types].xml", CONTENT_TYPES);
        putEntry(zip, "_rels/.rels", ROOT_RELS);
        putEntry(zip, "xl/workbook.xml", XML_HEAD
                + "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\""
                + " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
                + "<sheets><sheet name=\"" + escape(sheetName) + "\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
        putEntry(zip, "xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
        putEntry(zip, "xl/styles.xml", STYLES);
        putEntry(zip, "xl/worksheets/sheet1.xml", buildSheet(headers, rows, widths));
        zip.finish();
        zip.flush();
    }

    private static String buildSheet(String[] headers, List<Object[]> rows, int[] widths) {
        StringBuilder sb = new StringBuilder(4096);
        sb.append(XML_HEAD);
        sb.append("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">");
        sb.append("<cols>");
        for (int i = 0; i < widths.length; i++) {
            sb.append("<col min=\"").append(i + 1).append("\" max=\"").append(i + 1)
                    .append("\" width=\"").append(widths[i]).append("\" customWidth=\"1\"/>");
        }
        sb.append("</cols><sheetData>");

        sb.append("<row r=\"1\">");
        for (int c = 0; c < headers.length; c++) {
            appendString(sb, cellRef(c, 1), headers[c], true);
        }
        sb.append("</row>");

        int r = 2;
        for (Object[] row : rows) {
            sb.append("<row r=\"").append(r).append("\">");
            for (int c = 0; c < row.length; c++) {
                Object v = row[c];
                String ref = cellRef(c, r);
                if (v instanceof Number) {
                    sb.append("<c r=\"").append(ref).append("\"><v>").append(v.toString()).append("</v></c>");
                } else if (v != null && !v.toString().isEmpty()) {
                    appendString(sb, ref, v.toString(), false);
                }
            }
            sb.append("</row>");
            r++;
        }
        sb.append("</sheetData></worksheet>");
        return sb.toString();
    }

    private static void appendString(StringBuilder sb, String ref, String text, boolean bold) {
        sb.append("<c r=\"").append(ref).append("\" t=\"inlineStr\"");
        if (bold) sb.append(" s=\"1\"");
        sb.append("><is><t xml:space=\"preserve\">").append(escape(text)).append("</t></is></c>");
    }

    private static String cellRef(int col, int row) {
        StringBuilder letters = new StringBuilder();
        int n = col;
        do {
            letters.insert(0, (char) ('A' + n % 26));
            n = n / 26 - 1;
        } while (n >= 0);
        return letters.append(row).toString();
    }

    private static String escape(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                default:
                    // XML 에서 허용되지 않는 제어 문자는 버린다
                    if (ch >= 0x20 || ch == '\t' || ch == '\n' || ch == '\r') sb.append(ch);
            }
        }
        return sb.toString();
    }

    private static void putEntry(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }
}
