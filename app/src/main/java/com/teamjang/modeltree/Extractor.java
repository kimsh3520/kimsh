package com.teamjang.modeltree;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 3D PDF 모델트리 부품명 검색 핵심 로직 (PC용 model_tree_extractor.py 를 그대로 옮긴 것).
 * 안드로이드 클래스를 쓰지 않는 순수 자바라서 PC에서도 테스트할 수 있습니다.
 */
public final class Extractor {

    public interface Logger {
        void log(String msg);
    }

    /** 검색 결과 한 줄 */
    public static final class Row {
        public final String fileName;
        public final String fullName;
        public final String label;
        public final String size;
        public final String length;
        public final int qty;
        final double sizeNum;
        final double lengthNum;

        Row(String fileName, String fullName, String label, String size, String length, int qty) {
            this.fileName = fileName;
            this.fullName = fullName;
            this.label = label;
            this.size = size;
            this.length = length;
            this.qty = qty;
            this.sizeNum = sizeNumber(size);
            this.lengthNum = lengthNumber(length);
        }
    }

    private static final String[] CAD_EXTENSIONS = {
            "par", "asm", "psm", "pwd",          // Solid Edge
            "ipt", "iam",                        // Inventor
            "sldprt", "sldasm",                  // SolidWorks
            "prt", "catpart", "catproduct",      // Pro/E, CATIA
            "stp", "step", "igs", "iges"
    };

    private static final String EXT = buildExtPattern();

    private static String buildExtPattern() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < CAD_EXTENSIONS.length; i++) {
            if (i > 0) sb.append('|');
            sb.append(CAD_EXTENSIONS[i]);
        }
        return sb.toString();
    }

    // 파이썬의 \s 와 같은 범위의 공백 문자들
    private static final String WS =
            "[\\s\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\u001c-\\u001f]";
    // 한글 완성형 가-힣
    private static final String HANGUL = "\\uAC00-\\uD7A3";

    /** "이름.확장자:일련번호" (이름에 한글 포함 가능) */
    private static final Pattern NODE_PATTERN = Pattern.compile(
            "([ -~" + HANGUL + "]{1,120}?\\.(?:" + EXT + "))" + WS + "*:" + WS + "*([\\p{L}\\p{N}_.]+)",
            Pattern.CASE_INSENSITIVE);

    /** 확장자 없이 "한글이름:일련번호" 형태만 있는 경우 */
    private static final Pattern FALLBACK_PATTERN = Pattern.compile(
            "([" + HANGUL + "][ -~" + HANGUL + "]{0,58}?)" + WS + "*:" + WS
                    + "*(\\p{Nd}+(?:\\.\\p{Nd}+)?[A-Za-z]?)");

    /**
     * "M규격-길이mm" 분해. 구분자는 - _ * 공백 x 모두 허용, 앞의 M 과 뒤의 mm 은 있어도 없어도 됨.
     * 예: M3-5mm, M3_5mm, M3*5mm, M3 5mm, M3 x 5mm, M2.5-6mm, 기준핀 4-10
     */
    private static final Pattern SIZE_PATTERN = Pattern.compile(
            "(M)?" + WS + "*(\\p{Nd}+(?:\\.\\p{Nd}+)?)" + WS + "*(?:[-_*]|x)?" + WS
                    + "*(\\p{Nd}+(?:\\.\\p{Nd}+)?)" + WS + "*(mm)?",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern LEADING_NUMBER = Pattern.compile("^(\\p{Nd}+(?:\\.\\p{Nd}+)?)");

    private Extractor() {
    }

    /** PDF 한 개(바이트)에서 '이름 -> 등장 횟수'를 모두 찾는다. */
    public static Map<String, Integer> extractItems(byte[] data, int len, String fileName, Logger log) {
        // 한글은 UTF-8 로 저장되어 있다고 가정 (cp949 로 읽으면 압축 데이터가 가짜 한글로 읽힘)
        String text = new String(data, 0, len, StandardCharsets.UTF_8);

        HashSet<String> pairs = new HashSet<>();
        Matcher m = NODE_PATTERN.matcher(text);
        while (m.find()) {
            pairs.add(m.group(1).trim() + "\u0000" + m.group(2));
        }
        m = FALLBACK_PATTERN.matcher(text);
        while (m.find()) {
            pairs.add(m.group(1).trim() + "\u0000" + m.group(2));
        }

        LinkedHashMap<String, Integer> counts = new LinkedHashMap<>();
        for (String pair : pairs) {
            String name = pair.substring(0, pair.indexOf('\u0000'));
            Integer old = counts.get(name);
            counts.put(name, old == null ? 1 : old + 1);
        }

        if (counts.isEmpty()) {
            if (log != null) {
                log.log("  [알림] " + fileName + " 에서 'CAD 파일명.확장자:번호' 형태를 찾지 못했습니다. 일반 문자열 검색으로 대체합니다.");
            }
            // 최후의 대체 수단: 읽을 수 있는 ASCII 문자열(길이 3 이상) 전부를 후보로 사용
            int start = -1;
            for (int i = 0; i <= len; i++) {
                boolean printable = i < len && data[i] >= 0x20 && data[i] <= 0x7e;
                if (printable) {
                    if (start < 0) start = i;
                } else if (start >= 0) {
                    if (i - start >= 3) {
                        String s = new String(data, start, i - start, StandardCharsets.ISO_8859_1);
                        Integer old = counts.get(s);
                        counts.put(s, old == null ? 1 : old + 1);
                    }
                    start = -1;
                }
            }
        }
        return counts;
    }

    static String stripExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : CAD_EXTENSIONS) {
            String suffix = "." + ext;
            if (lower.endsWith(suffix)) {
                return name.substring(0, name.length() - suffix.length());
            }
        }
        return name;
    }

    private static String stripChars(String s, String chars) {
        int a = 0;
        int b = s.length();
        while (a < b && chars.indexOf(s.charAt(a)) >= 0) a++;
        while (b > a && chars.indexOf(s.charAt(b - 1)) >= 0) b--;
        return s.substring(a, b);
    }

    /** 'SEMS M3-8' / '기준핀 4-10' 같은 이름을 {명칭, 규격, 길이} 로 분해 */
    static String[] parseName(String nameNoExt) {
        Matcher m = SIZE_PATTERN.matcher(nameNoExt);
        if (!m.find()) {
            return new String[]{nameNoExt.trim(), "", ""};
        }
        String size = (m.group(1) != null ? "M" : "") + m.group(2);
        String length = m.group(3) + "mm";
        String label = stripChars(nameNoExt.substring(0, m.start()) + nameNoExt.substring(m.end()), " -_");
        return new String[]{label, size, length};
    }

    static double sizeNumber(String size) {
        String digits = size.toUpperCase(Locale.ROOT).startsWith("M") ? size.substring(1) : size;
        if (digits.isEmpty()) return Double.POSITIVE_INFINITY;
        try {
            return Double.parseDouble(digits);
        } catch (NumberFormatException e) {
            return Double.POSITIVE_INFINITY;
        }
    }

    static double lengthNumber(String length) {
        Matcher m = LEADING_NUMBER.matcher(length);
        if (m.find()) {
            try {
                return Double.parseDouble(m.group(1));
            } catch (NumberFormatException e) {
                return Double.POSITIVE_INFINITY;
            }
        }
        return Double.POSITIVE_INFINITY;
    }

    /** PDF 한 개에서 검색어가 들어간 이름만 골라 결과 행으로 만든다. */
    public static List<Row> search(String fileName, byte[] data, int len, String keyword, Logger log) {
        Map<String, Integer> counts = extractItems(data, len, fileName, log);
        String normKeyword = keyword.replace(" ", "").toLowerCase(Locale.ROOT);
        List<Row> rows = new ArrayList<>();
        for (Map.Entry<String, Integer> e : counts.entrySet()) {
            String baseName = e.getKey();
            String normName = baseName.replace(" ", "").toLowerCase(Locale.ROOT);
            if (!normName.contains(normKeyword)) continue;
            String[] p = parseName(stripExtension(baseName));
            rows.add(new Row(fileName, baseName, p[0], p[1], p[2], e.getValue()));
        }
        return rows;
    }

    /** 규격(M) 오름차순, 같은 규격이면 길이 오름차순. 규격/길이를 못 읽은 항목은 맨 뒤. */
    public static void sortRows(List<Row> rows) {
        Collections.sort(rows, new Comparator<Row>() {
            @Override
            public int compare(Row a, Row b) {
                int c = Double.compare(a.sizeNum, b.sizeNum);
                if (c != 0) return c;
                c = Double.compare(a.lengthNum, b.lengthNum);
                if (c != 0) return c;
                c = a.fullName.compareTo(b.fullName);
                if (c != 0) return c;
                return a.fileName.compareTo(b.fileName);
            }
        });
    }
}
