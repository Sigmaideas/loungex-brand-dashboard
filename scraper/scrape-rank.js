/**
 * 네이버 플레이스 검색 순위 수집기
 *
 * - rank-config.json 의 매장별 (좌표, 키워드)로 getPlacesList 호출
 * - 결과 리스트에서 우리 매장(placeId)의 순위를 산출 → 키워드별 노출 경쟁력
 * - 좌표를 명시하므로 실행 환경(IP)과 무관하게 일관된 지역 기준 순위
 * - data/rank.json 에 현재 순위 + 일자별 추이(history) 누적
 *
 * 추가 인증/키 불필요. 브라우저 불필요(순수 fetch).
 */
const fs = require('fs').promises;
const path = require('path');

const STORES_PATH = path.join(__dirname, 'stores.json');
const CONFIG_PATH = path.join(__dirname, 'rank-config.json');
const RANK_PATH = path.join(__dirname, '..', 'data', 'rank.json');
const GRAPHQL_URL = 'https://api.place.naver.com/place/graphql';
const DISPLAY = 100; // 100위까지 조회
const HISTORY_MAX = 90; // 추이 보관 일수
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const QUERY = `query getPlacesList($input: PlaceListInput) {
  placeList(input: $input) {
    businesses { total items { id name __typename } __typename }
    __typename
  }
}`;

const log = (...a) => console.log(`[scrape-rank ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// KST 날짜 (YYYY-MM-DD)
const kstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const placeIdOf = (url) => (url || '').match(/place\/(\d+)/)?.[1] || null;

async function fetchRank(keyword, placeId, coord) {
  const body = JSON.stringify([
    {
      operationName: 'getPlacesList',
      variables: {
        input: {
          query: keyword,
          businessType: 'place',
          start: 1,
          display: DISPLAY,
          adult: false,
          spq: false,
          queryRank: '',
          x: coord.x,
          y: coord.y,
          deviceType: 'pc',
        },
      },
      query: QUERY,
    },
  ]);
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: 'https://m.place.naver.com',
      Referer: 'https://m.place.naver.com/',
    },
    body,
  });
  if (!res.ok) throw new Error(`graphql ${res.status}`);
  const j = await res.json();
  const biz = j[0]?.data?.placeList?.businesses;
  const items = biz?.items || [];
  const idx = items.findIndex((it) => it.id === String(placeId));
  return { rank: idx >= 0 ? idx + 1 : null, total: biz?.total ?? null };
}

async function main() {
  const stores = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  let existing = { records: {} };
  try {
    existing = JSON.parse(await fs.readFile(RANK_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const records = existing.records || {};
  const today = kstDate();
  const storeById = new Map(stores.map((s) => [s.id, s]));

  for (const [storeId, cfg] of Object.entries(config.stores || {})) {
    const store = storeById.get(storeId);
    if (!store) continue;
    const placeId = placeIdOf(store.naverPlaceUrl);
    if (!placeId) continue;
    for (const keyword of cfg.keywords || []) {
      const key = `${storeId}|${keyword}`;
      try {
        const { rank, total } = await fetchRank(keyword, placeId, cfg.coord);
        const rec = records[key] || { storeId, storeName: store.name, keyword, history: [] };
        rec.prevRank = rec.rank ?? null;
        rec.rank = rank;
        rec.total = total;
        rec.storeName = store.name;
        // 같은 날짜는 갱신, 아니면 추가
        const last = rec.history[rec.history.length - 1];
        if (last && last.date === today) last.rank = rank;
        else rec.history.push({ date: today, rank });
        if (rec.history.length > HISTORY_MAX) rec.history = rec.history.slice(-HISTORY_MAX);
        records[key] = rec;
        log(`${store.name} · "${keyword}" → ${rank ? rank + '위' : '100위권 밖'} (전체 ${total})`);
      } catch (e) {
        log(`실패: ${store.name} · "${keyword}" — ${e.message}`);
      }
      await sleep(400);
    }
  }

  const out = { lastScrapedAt: new Date().toISOString(), updatedDate: today, records };
  await fs.mkdir(path.dirname(RANK_PATH), { recursive: true });
  await fs.writeFile(RANK_PATH, JSON.stringify(out, null, 2), 'utf8');
  log(`저장 완료: ${Object.keys(records).length}개 키워드 → ${RANK_PATH}`);
}

main().catch((err) => {
  console.error('순위 수집 오류:', err.message);
  process.exit(1);
});
