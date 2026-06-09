/**
 * 네이버 플레이스 리뷰 크롤러 (GraphQL 직접 호출)
 *
 * 동작:
 *  1. 모바일 컨텍스트로 m.place.naver.com 한 번 로드해서 쿠키/세션 확보
 *  2. api.place.naver.com/graphql 의 getVisitorReviews 를 page.request 로 직접 POST
 *  3. cursor 기반 페이지네이션으로 매장당 최대 50건 수집
 *  4. headless 에서도 안정적으로 동작
 *
 * GraphQL 스키마가 바뀌면 scraper/_test_resp.js 로 새 쿼리/응답 캡쳐 후
 * 아래 GRAPHQL_QUERY 와 mapReview 갱신.
 */
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const HEADLESS = process.env.HEADLESS !== 'false';
const MAX_REVIEWS_PER_STORE = 50;
const PAGE_SIZE = 10;
const GRAPHQL_URL = 'https://api.place.naver.com/graphql';
const STORES_PATH = path.join(__dirname, 'stores.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 카페/음식점 공통 — 카테고리가 다른 매장이 추가되면 inspect8.js 로 cidList 재캡쳐
const CID_LIST = ['220036', '220052', '220576', '1004964'];

// 캡쳐된 getVisitorReviews 쿼리 (2026-05 기준)
const GRAPHQL_QUERY = `query getVisitorReviews($input: VisitorReviewsInput) {
  visitorReviews(input: $input) {
    items {
      id
      cursor
      reviewId
      rating
      author { id nickname __typename }
      body
      visited
      created
      reply { body created __typename }
      visitCategories { code name keywords { code name __typename } __typename }
      representativeVisitDateTime
      __typename
    }
    total
    __typename
  }
}`;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDelay = (min, max) => sleep(min + Math.random() * (max - min));
const log = (...a) => console.log(`[scrape ${new Date().toISOString().slice(11, 19)}]`, ...a);

function placeIdFromUrl(url) {
  const m = url.match(/place\/(\d+)/);
  return m ? m[1] : null;
}
function reviewPageUrl(placeId) {
  return `https://m.place.naver.com/place/${placeId}/review/visitor?reviewSort=recent`;
}

async function loadStores() { return JSON.parse(await fs.readFile(STORES_PATH, 'utf8')); }
async function loadExisting() {
  try { return JSON.parse(await fs.readFile(REVIEWS_PATH, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { lastScrapedAt: null, reviews: [], errors: [] }; throw e; }
}
async function saveAll(payload) {
  await fs.mkdir(path.dirname(REVIEWS_PATH), { recursive: true });
  await fs.writeFile(REVIEWS_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function buildVariables(placeId, after) {
  const input = {
    businessId: placeId,
    businessType: 'restaurant',
    item: '0',
    bookingBusinessId: null,
    size: PAGE_SIZE,
    isPhotoUsed: false,
    sort: 'recent',
    includeContent: true,
    getUserStats: true,
    includeReceiptPhotos: true,
    cidList: CID_LIST,
    getReactions: true,
    getTrailer: true,
  };
  if (after) input.after = after;
  return { input };
}

async function fetchPage(page, placeId, after) {
  const body = [
    {
      operationName: 'getVisitorReviews',
      variables: buildVariables(placeId, after),
      query: GRAPHQL_QUERY,
    },
  ];
  const resp = await page.request.post(GRAPHQL_URL, {
    data: body,
    headers: {
      'content-type': 'application/json',
      accept: '*/*',
      'accept-language': 'ko',
      referer: reviewPageUrl(placeId),
    },
    timeout: 15000,
  });
  if (!resp.ok()) throw new Error(`GraphQL HTTP ${resp.status()}`);
  const json = await resp.json();
  const data = (Array.isArray(json) ? json[0] : json)?.data?.visitorReviews;
  return {
    items: data?.items || [],
    total: data?.total || 0,
  };
}

function mapReview(item, store) {
  const body = (item.body || '').trim();
  const date = item.visited || item.representativeVisitDateTime || item.created || null;
  const rating = item.rating != null ? Number(item.rating) || null : null;
  const nickname = item.author?.nickname || item.nickname || '';
  const replyBody = (item.reply?.body || '').trim();
  return {
    storeId: store.id,
    storeName: store.name,
    date,
    text: body,
    rating,
    authorHash: nickname ? sha256(nickname) : null,
    collectedAt: new Date().toISOString(),
    // 사장님 답글 (있으면) — 자동 답글 생성 시 말투 참고용
    ownerReply: replyBody || null,
    ownerReplyDate: item.reply?.created || null,
  };
}

function dedupe(prev, fresh, runIso) {
  const keyOf = (r) => `${r.storeId}|${r.date}|${r.text}`;
  const byKey = new Map(prev.map((r) => [keyOf(r), r]));
  const out = [...prev];
  let added = 0;
  for (const r of fresh) {
    const key = keyOf(r);
    const existing = byKey.get(key);
    if (!existing) {
      // 이번 수집에서 처음 등장한 리뷰만 firstSeenAt 기록 → 대시보드 NEW 배지 판별용
      const nr = { ...r, firstSeenAt: runIso };
      byKey.set(key, nr);
      out.push(nr);
      added++;
    } else if (r.ownerReply && !existing.ownerReply) {
      // 기존 리뷰에 새로 달린 사장님 답글 반영 (말투 참고용)
      existing.ownerReply = r.ownerReply;
      existing.ownerReplyDate = r.ownerReplyDate || existing.ownerReplyDate || null;
    }
  }
  return { merged: out, added };
}

async function scrapeStore(browser, store) {
  const placeId = placeIdFromUrl(store.naverPlaceUrl);
  if (!placeId) throw new Error(`URL 에서 placeId 추출 실패: ${store.naverPlaceUrl}`);
  const ctx = await browser.newContext({
    userAgent: MOBILE_UA,
    locale: 'ko-KR',
    viewport: { width: 414, height: 896 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  try {
    log(`방문 → ${store.name}`);
    // 페이지를 한 번 열어 쿠키/세션 확보 (DOM은 안 씀)
    await page.goto(reviewPageUrl(placeId), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randDelay(1500, 3000);

    const all = [];
    let after = null;
    for (let i = 0; i < 8 && all.length < MAX_REVIEWS_PER_STORE; i++) {
      let res;
      try {
        res = await fetchPage(page, placeId, after);
      } catch (e) {
        log(`  → ${store.name}: GraphQL 호출 실패 (${e.message})`);
        break;
      }
      if (res.items.length === 0) break;
      all.push(...res.items);
      after = res.items[res.items.length - 1]?.cursor;
      if (!after) break;
      await randDelay(700, 1500);
    }

    const reviews = all
      .slice(0, MAX_REVIEWS_PER_STORE)
      .map((it) => mapReview(it, store))
      .filter((r) => r.text);
    log(`수집 → ${store.name}: ${reviews.length}건`);
    return reviews;
  } finally {
    await ctx.close();
  }
}

async function main() {
  const allStores = await loadStores();
  const filter = process.env.STORE_ID;
  const stores = filter ? allStores.filter((s) => s.id === filter) : allStores;
  if (filter && stores.length === 0) throw new Error(`STORE_ID=${filter} 매장을 찾지 못했습니다.`);
  const existing = await loadExisting();
  const errors = [];

  log(`총 ${stores.length}개 매장 수집 시작 (headless=${HEADLESS})`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const fresh = [];
  try {
    for (const store of stores) {
      try {
        const list = await scrapeStore(browser, store);
        fresh.push(...list);
      } catch (err) {
        log(`실패 → ${store.name}: ${err.message}`);
        errors.push({ storeId: store.id, name: store.name, message: err.message, at: new Date().toISOString() });
      }
      await randDelay(2000, 5000);
    }
  } finally {
    await browser.close();
  }

  const runIso = new Date().toISOString();
  const { merged, added } = dedupe(existing.reviews || [], fresh, runIso);
  await saveAll({ lastScrapedAt: runIso, reviews: merged, errors });
  log(`저장 완료: 누적 ${merged.length}건 (신규 +${added}건, 오류 ${errors.length}건)`);
}

main().catch((err) => { console.error('치명적 오류:', err); process.exit(1); });
