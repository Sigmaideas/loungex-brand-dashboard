# 라운지엑스 매장 리뷰 모니터링 대시보드

라운지엑스(LOUNGE'X) 매장의 네이버 플레이스 리뷰를 주기적으로 수집하고, 매장별 리뷰 수·감성 분포·월간 활성도를 한눈에 볼 수 있는 **회사 내부용** 대시보드입니다.

---

## ⚠️ 법적 / 윤리적 주의사항

본 도구는 **회사 내부 운영 모니터링** 목적으로만 사용하며, 외부 공개·재배포·상용 데이터 판매를 금지합니다. 네이버는 약관(ToS)에서 자동화된 데이터 수집을 일반적으로 제한하며, 사용 시 다음 사항을 인지해야 합니다.

- **약관 리스크**: 네이버 ToS는 무단 크롤링을 제한할 수 있습니다. 본 프로젝트는 *공개적으로 노출된 매장 리뷰를 사람의 열람 패턴에 가까운 빈도(하루 1회 이하)로 수집*하지만, 차단·계정 제재의 가능성은 사용자가 감수해야 합니다.
- **저작권**: 리뷰 본문의 저작권은 작성자에게 있습니다. 수집된 데이터는 내부 분석에만 사용하고 외부에 재공개하지 마십시오.
- **개인정보**: 작성자 닉네임은 수집 즉시 SHA-256으로 해시 처리되어 원본이 저장되지 않습니다. 닉네임 외 개인정보는 수집하지 않습니다.
- **윤리적 운영**: 매장 간 2~5초·스크롤 간 1~3초 랜덤 딜레이, 하루 1회 이하 실행을 기본값으로 합니다. 더 공격적인 빈도로 변경하지 마세요.

---

## 1. 설치

Node.js 18+ / Python 3 / macOS 또는 Linux 환경을 가정합니다.

```bash
npm install
npx playwright install chromium
cp .env.example .env
# .env 파일을 열어 ANTHROPIC_API_KEY 값을 채워 넣으세요
```

---

## 2. 매장 추가/수정

`scraper/stores.json`을 편집합니다.

```json
[
  {
    "id": "store_001",
    "name": "라운지엑스 강남점",
    "naverPlaceUrl": "https://map.naver.com/p/entry/place/12345678"
  }
]
```

- `id`: 매장 고유 식별자(자유 형식, 변경 시 기존 데이터와 매칭이 끊깁니다)
- `name`: 대시보드에 표시될 매장명
- `naverPlaceUrl`: 네이버 지도에서 해당 매장의 **상세 페이지 URL** (검색 URL이 아닌 `place/{ID}` 형태 권장)

URL을 얻는 방법: 네이버 지도에서 매장을 검색 → 상세 진입 → 주소창의 `https://map.naver.com/p/entry/place/{숫자ID}` 부분을 복사.

---

## 3. 사용법

```bash
# 1) 데이터 수집 + 감성분석 (한 번에)
npm run update

# 따로 실행도 가능
npm run scrape    # 리뷰 수집 → data/reviews.json
npm run analyze   # 감성분석 + 요약 → data/summary.json

# 2) 대시보드 보기
npm run dashboard
# 브라우저에서 http://localhost:8080 접속
```

크롤링 진행 상황을 직접 보고 싶다면:

```bash
HEADLESS=false npm run scrape
```

---

## 4. 정기 실행 (macOS)

### 옵션 A: cron

```bash
crontab -e
```

매일 오전 7시에 실행:

```cron
0 7 * * * cd /Users/사용자/Documents/loungex-brand-dashboard && /usr/local/bin/npm run update >> /tmp/loungex-scrape.log 2>&1
```

### 옵션 B: launchd (macOS 권장)

`~/Library/LaunchAgents/com.loungex.scrape.plist` 파일을 만들어 다음 내용 입력:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.loungex.scrape</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/사용자/Documents/loungex-brand-dashboard && /usr/local/bin/npm run update</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/loungex-scrape.log</string>
  <key>StandardErrorPath</key><string>/tmp/loungex-scrape.err.log</string>
</dict>
</plist>
```

등록:

```bash
launchctl load ~/Library/LaunchAgents/com.loungex.scrape.plist
```

> ⚠️ 하루 **1회 이하** 실행을 권장합니다. 더 빈번한 실행은 차단 위험을 높입니다.

---

## 5. 폴더 구조

```
loungex-brand-dashboard/
├── scraper/
│   ├── stores.json     # 모니터링 대상 매장 리스트
│   ├── scrape.js       # Playwright 리뷰 크롤러
│   └── analyze.js      # Claude 감성분석 + 요약 생성
├── data/               # 자동 생성 (git 무시)
│   ├── reviews.json    # 원시 리뷰 + 감성 라벨
│   └── summary.json    # 대시보드 입력 데이터
├── dashboard/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## 6. 트러블슈팅

### 리뷰가 0건으로 수집된다 / "리뷰 탭을 찾지 못했습니다" 에러

네이버는 페이지 구조와 클래스명을 자주 바꿉니다. `scraper/scrape.js` 상단의 `SELECTORS` 상수에 한 곳에 모아뒀으니 여기만 수정하세요.

```js
const SELECTORS = {
  entryIframe: 'iframe#entryIframe',
  reviewTab: 'a[role="tab"]:has-text("리뷰"), a:has-text("리뷰")',
  reviewItem: 'li.place_apply_pui, ...',
  reviewBody: 'a[class*="content"], ...',
  reviewDate: 'time, span[class*="date"], ...',
  // ...
};
```

**셀렉터 갱신 절차**:
1. `HEADLESS=false npm run scrape`로 실제 브라우저를 띄움
2. DevTools에서 리뷰 항목을 우클릭 → Inspect로 현재 클래스명 확인
3. `SELECTORS`의 해당 키를 새 셀렉터로 교체. 여러 후보가 있으면 콤마(`,`)로 구분해 OR 매칭하세요.

### 네이버에 차단된 것 같다

- **즉시 중단하고 24~48시간 휴식**. 추가 시도는 차단을 영구화시킬 수 있습니다.
- `headless: false`로 한 번 수동 방문하여 캡차/이상 페이지 여부 확인
- IP/네트워크를 잠시 변경 후 재시도. 재실행 시 `npm run scrape`보다 매장을 1~2개로 줄여 시작

### `summary.json`이 없어 대시보드가 비어 있다

`npm run update`를 한 번도 실행하지 않은 상태입니다. 먼저 `stores.json`에 실제 URL을 채우고 `npm run update`를 실행하세요.

### Anthropic API 오류

- `.env`에 `ANTHROPIC_API_KEY`가 올바르게 설정되어 있는지 확인
- 모델 ID는 `scraper/analyze.js`의 `MODEL` 상수에서 변경 가능 (기본값: `claude-haiku-4-5-20251001`)
- 분석 실패한 리뷰는 자동으로 `neutral`로 표시되며, 다음 실행 시 재시도됩니다 (sentiment가 채워져 있으므로 스킵됨에 주의 — 강제 재분석을 원하면 해당 리뷰의 `sentiment` 필드를 삭제 후 재실행)

---

## 라이선스 / 책임 범위

본 코드는 라운지엑스 내부 모니터링 전용입니다. 외부 배포·제3자 제공은 금지하며, 사용 중 발생하는 약관/법적 이슈에 대한 책임은 운영자에게 있습니다.
