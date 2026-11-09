# 모델트리 검색기 (안드로이드)

3D PDF 모델트리에서 부품명을 검색해 엑셀(.xlsx)로 저장하는 앱입니다. (PC용 model_tree_extractor.py 와 같은 검색 규칙)

- PDF 선택 / 폴더 선택 → "볼트", "기준핀" 버튼 → 규격(M) 순 정렬 결과 → 엑셀로 저장
- 검색 단어를 더 추가하려면 `MainActivity.java` 의 `QUICK_KEYWORDS` 에 적으면 버튼이 늘어납니다.
- 이 브랜치(modeltree-app)에 올리면 GitHub Actions 가 APK 를 빌드해 Releases 에 올립니다.
