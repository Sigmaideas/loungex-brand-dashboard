/**
 * 네이버 데이터랩 검색어 트렌드 수집기
 *
 * - '라운지엑스' 브랜드 검색 관심도의 최근 1년 추이(주간) 수집
 * - 데이터랩은 상대값(해당 그룹 내 최고점=100)을 반환 → 검색 관심도의 '추세'를 보여줌
 * - 한 번 호출로 전체 기간을 받으므로 매 실행마다 덮어씀(누적 불필요)
 *
 * 필요: 환경변수 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 * 없으면 조용히 스킵(파이프라인 비차단)
 */
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'data', 'trend.json');
const API_URL = 'https://openapi.naver.com/v1/datalab/search';

const log = (...a) => console.log(`[trend ${new Date().toISOString().slice(11, 19)}]`, ...a);
const ymd = (d) => d.toISOString().slice(0, 10);

// 추적할 키워드 그룹 (브랜드). 비교 키워드를 넣고 싶으면 그룹 추가(최대 5개)
const KEYWORD_GROUPS = [{ groupName: '라운지엑스', keywords: ['라운지엑스', '라운지 엑스', 'loungex'] }];

async function main() {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    log('NAVER_CLIENT_ID/SECRET 없음 — 검색 트렌드 수집 스킵');
    return;
  }
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
  const body = {
    startDate: ymd(start),
    endDate: ymd(end),
    timeUnit: 'week',
    keywordGroups: KEYWORD_GROUPS,
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`데이터랩 API ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const groups = (json.results || []).map((r) => ({
    title: r.title,
    data: (r.data || []).map((d) => ({ period: d.period, ratio: d.ratio })),
  }));

  const out = {
    lastScrapedAt: new Date().toISOString(),
    startDate: json.startDate,
    endDate: json.endDate,
    timeUnit: json.timeUnit,
    groups,
  };
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  const pts = groups[0]?.data?.length || 0;
  log(`저장 완료: ${groups.length}개 그룹, ${pts}개 구간 → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('검색 트렌드 수집 오류:', err.message);
  process.exit(0); // 비차단
});
