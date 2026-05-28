/**
 * 매장 이름으로 Google Places 검색 → place_id 자동 매칭
 *
 *  stores.json (네이버) 의 매장명을 그대로 사용해서 Google Places API 의
 *  Text Search 로 검색 → 첫 번째 결과를 stores-google.json 에 저장.
 *
 *  검색 결과가 애매하거나 잘못 매칭되면 stores-google.json 을 수동으로 수정하세요.
 */
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const SRC = path.join(__dirname, 'stores.json');
const OUT = path.join(__dirname, 'stores-google.json');

const log = (...a) => console.log(`[find-google ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPlace(query) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'ko', regionCode: 'KR' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.places?.[0] || null;
}

async function main() {
  if (!API_KEY) throw new Error('GOOGLE_PLACES_API_KEY 환경변수가 필요합니다 (.env 파일 확인).');
  const stores = JSON.parse(await fs.readFile(SRC, 'utf8'));
  log(`총 ${stores.length}개 매장 검색 시작`);
  const result = [];
  for (const s of stores) {
    try {
      const place = await findPlace(s.name);
      if (place) {
        log(`✓ ${s.name} → ${place.id}`);
        result.push({
          id: s.id,
          name: s.name,
          googlePlaceId: place.id,
          googleDisplayName: place.displayName?.text || null,
          googleAddress: place.formattedAddress || null,
        });
      } else {
        log(`✗ ${s.name} → 검색 결과 없음`);
        result.push({ id: s.id, name: s.name, googlePlaceId: null });
      }
    } catch (e) {
      log(`✗ ${s.name} → 실패: ${e.message}`);
      result.push({ id: s.id, name: s.name, googlePlaceId: null });
    }
    await sleep(250);
  }
  await fs.writeFile(OUT, JSON.stringify(result, null, 2), 'utf8');
  const matched = result.filter((r) => r.googlePlaceId).length;
  log(`저장: ${OUT} (매칭 ${matched}/${result.length})`);
  if (matched < result.length) {
    log('매칭 실패 매장은 stores-google.json 에서 수동으로 googlePlaceId 입력 가능');
  }
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
