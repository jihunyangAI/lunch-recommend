# 오늘 뭐 먹지? · AI 맛집 추천

내 주변 식당을 지도에서 보고, Gemini에게 오늘의 메뉴를 추천받는 Next.js 웹앱.

- 현재 위치 자동 감지 (권한이 없으면 서울시청 기준)
- Google Places API (New)로 주변 식당 검색 — 반경 도보 5분(500m) / 도보 10분(800m) / 차량 5분(2km)
- 지도 마커 + 카드 목록 (이름, 종류, 거리, 평점, 가격대), Google Maps 상세 페이지 링크
- 키워드 검색 (예: "김밥") — Places Text Search로 반경 안에서 이름·음식 종류로 찾기. 주변 검색과 하루 횟수를 같이 씀
- 즐겨찾기 (브라우저 localStorage)
- 원하는 위치에서 조회: 지도 이동 후 "이 지역에서 다시 검색", PC는 지도 우클릭
- Gemini AI 추천 (`gemini-3.5-flash-lite`, 불가 시 3.1 / 2.5 Flash-Lite로 자동 전환)

## 로컬 실행

```bash
cp .env.example .env.local   # 값 채우기
npm install
npm run dev                  # http://localhost:3001
```

## 환경변수

| 이름 | 위치 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_MAPS_API_KEY` | 브라우저 | Maps JavaScript API + Places API (New) 키. **HTTP 리퍼러 제한 필수** (localhost, 배포 도메인) |
| `NEXT_PUBLIC_MAPS_MAP_ID` | 브라우저 | JavaScript용 Map ID (Advanced Marker에 필요) |
| `GEMINI_API_KEY` | 서버 전용 | https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | 서버 전용 | 기본 `gemini-3.5-flash-lite` |

`NEXT_PUBLIC_*` 값은 빌드 시점에 번들에 들어가므로, 바꾸면 다시 배포해야 합니다.

## AI 추천 API 보호

`/api/recommend`는 같은 사이트에서 온 요청만 받고, IP당 분당 6회 / 하루 100회로 제한합니다
(인스턴스별 메모리 기준). 공개 배포 시 Vercel Firewall에 `/api/recommend` 레이트 리밋 규칙을 추가하는 것을 권장합니다.
