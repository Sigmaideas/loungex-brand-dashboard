/**
 * Google Places API 로 매장 리뷰 수집
 *
 * - stores-google.json 의 googlePlaceId 기준
 * - Place Details API: 매장당 최대 5건 리뷰 반환 (API 제약)
 * - 매일 누적해 dedup 하면 점진적으로 데이터 쌓임
 * - data/reviews-google.json 에 저장
 *
 * 호출량: 매장 8 × 일 1회 = 240/월. Pro tier 무료 한도 ($200) 안.
 */
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const STORES_PATH = path.join(__dirname, 'stores-google.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews-google.json');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const log = (...a) => console.log(`[scrape-google ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPlaceDetails(placeId) {
  const url = `https://places.googleapis.com/v1/places/${placeId}?languageCode=ko`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,reviews',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function mapReview(r, store) {
  const text = (r.text?.text || r.originalText?.text || '').trim();
  return {
    storeId: store.id,
    storeName: store.name,
    date: r.publishTime ? r.publishTime.slice(0, 10) : null,
    text,
    rating: r.rating != null ? Number(r.rating) || null : null,
    authorHash: r.authorAttribution?.displayName ? sha256(r.authorAttribution.displayName) : null,
    collectedAt: new Date().toISOString(),
  };
}

async function loadExisting() {
  try { return JSON.parse(await fs.readFile(REVIEWS_PATH, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { lastScrapedAt: null, reviews: [], errors: [] }; throw e; }
}

function dedupe(prev, fresh) {
  const seen = new Set(prev.map((r) => `${r.storeId}|${r.date}|${r.text}`));
  const out = [...prev];
  let added = 0;
  for (const r of fresh) {
    const key = `${r.storeId}|${r.date}|${r.text}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); added++; }
  }
  return { merged: out, added };
}

async function main() {
  if (!API_KEY) throw new Error('GOOGLE_PLACES_API_KEY 환경변수가 필요합니다 (.env 파일 확인).');
  let allStores;
  try {
    allStores = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('stores-google.json 이 없습니다. `npm run find:google` 먼저 실행하세요.');
    throw e;
  }
  const stores = allStores.filter((s) => s.googlePlaceId);
  if (stores.length === 0) {
    throw new Error('googlePlaceId 가 설정된 매장이 없습니다. `npm run find:google` 실행 또는 stores-google.json 수동 입력 필요.');
  }
  log(`총 ${stores.length}개 매장 수집 시작`);
  const existing = await loadExisting();
  const errors = [];
  const fresh = [];
  for (const store of stores) {
    try {
      const detail = await fetchPlaceDetails(store.googlePlaceId);
      const reviews = (detail.reviews || []).map((r) => mapReview(r, store)).filter((r) => r.text);
      log(`수집 → ${store.name}: ${reviews.length}건 (전체 ${detail.userRatingCount || '?'}건 중)`);
      fresh.push(...reviews);
    } catch (e) {
      log(`실패 → ${store.name}: ${e.message}`);
      errors.push({ storeId: store.id, name: store.name, message: e.message, at: new Date().toISOString() });
    }
    await sleep(300);
  }
  const { merged, added } = dedupe(existing.reviews || [], fresh);
  await fs.mkdir(path.dirname(REVIEWS_PATH), { recursive: true });
  await fs.writeFile(
    REVIEWS_PATH,
    JSON.stringify({ lastScrapedAt: new Date().toISOString(), reviews: merged, errors }, null, 2),
    'utf8'
  );
  log(`저장 완료: 누적 ${merged.length}건 (신규 +${added}건, 오류 ${errors.length}건)`);
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
