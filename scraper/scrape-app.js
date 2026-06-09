/**
 * 라운지엑스 앱 리뷰 수집기 (구글 플레이 + 애플 앱스토어)
 *
 * - 구글 플레이: google-play-scraper 로 최신 리뷰 수집
 * - 애플 앱스토어: 공식 RSS 가 텍스트 리뷰를 노출하지 않아(2026 기준),
 *   앱 상세의 "리뷰 전체보기"(see-all) 페이지에 서버 렌더링된
 *   serialized-server-data JSON 을 파싱해 리뷰를 추출 (브라우저 불필요)
 * - 두 플랫폼의 공식 평점/평가수(metadata)도 함께 저장 → 대시보드 평점 KPI
 *
 * 출력: data/reviews-app.json { lastScrapedAt, reviews, errors, storeMeta }
 * 리뷰 스키마: { storeId, author, rating, text, date(YYYY-MM-DD), firstSeenAt }
 */
const fs = require('fs').promises;
const path = require('path');

const STORES_PATH = path.join(__dirname, 'stores-app.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews-app.json');
const GOOGLE_MAX = 200; // 페이지네이션 상한
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const log = (...a) => console.log(`[scrape-app ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toYMD = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? String(d).slice(0, 10) : dt.toISOString().slice(0, 10);
};

async function loadExisting() {
  try {
    return JSON.parse(await fs.readFile(REVIEWS_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { lastScrapedAt: null, reviews: [], errors: [], storeMeta: {} };
    throw e;
  }
}

// ── 구글 플레이 ──────────────────────────────────────────────
async function scrapeGoogle(store) {
  const gplayMod = require('google-play-scraper');
  const gplay = gplayMod.default || gplayMod;
  const all = [];
  let token = null;
  for (let i = 0; i < Math.ceil(GOOGLE_MAX / 100); i++) {
    const res = await gplay.reviews({
      appId: store.googlePlayId,
      lang: 'ko',
      country: 'kr',
      sort: gplay.sort.NEWEST,
      num: 100,
      paginate: true,
      nextPaginationToken: token,
    });
    all.push(...res.data);
    token = res.nextPaginationToken;
    if (!token || res.data.length === 0) break;
  }
  const reviews = all
    .filter((r) => (r.text || '').trim())
    .map((r) => ({
      storeId: store.id,
      author: r.userName || '',
      rating: r.score ?? null,
      text: (r.text || '').trim(),
      date: toYMD(r.date),
      ownerReply: (r.replyText || '').trim() || null,
      ownerReplyDate: r.replyDate ? toYMD(r.replyDate) : null,
    }));

  // 앱 공식 평점/평가수
  let meta = {};
  try {
    const app = await gplay.app({ appId: store.googlePlayId, lang: 'ko', country: 'kr' });
    meta = { rating: app.score ?? null, ratingCount: app.ratings ?? null };
  } catch (e) {
    log(`구글 메타 조회 실패: ${e.message}`);
  }
  log(`구글 플레이 → ${reviews.length}건 (평점 ${meta.rating ?? '?'}, 평가 ${meta.ratingCount ?? '?'})`);
  return { reviews, meta };
}

// ── 애플 앱스토어 ────────────────────────────────────────────
async function scrapeApple(store) {
  const seeAllUrl = `https://apps.apple.com/${store.country}/app/id${store.appleAppId}?see-all=reviews`;
  const res = await fetch(seeAllUrl, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) throw new Error(`see-all 페이지 ${res.status}`);
  const html = await res.text();
  const m = html.match(/id="serialized-server-data">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('serialized-server-data 를 찾지 못함 (페이지 구조 변경 가능)');

  const json = JSON.parse(m[1]);
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    // 리뷰 객체 시그니처: rating(number) + contents(본문) + reviewerName
    if (typeof o.rating === 'number' && typeof o.contents === 'string' && 'reviewerName' in o) {
      const dev = o.developerResponse || o.editedReview?.developerResponse;
      out.push({
        id: o.id,
        storeId: store.id,
        author: o.reviewerName || '',
        rating: o.rating,
        text: [o.title, o.contents].filter(Boolean).join('\n').trim(),
        date: toYMD(o.date),
        ownerReply: (typeof dev === 'object' ? dev?.body : dev) || null,
        ownerReplyDate: typeof dev === 'object' ? dev?.modified || null : null,
      });
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(json);
  // id 기준 중복 제거 후 id 필드는 버림
  const reviews = [...new Map(out.map((r) => [r.id, r])).values()].map(({ id, ...r }) => r);

  // 앱 공식 평점/평가수 (iTunes lookup)
  let meta = {};
  try {
    const lk = await fetch(`https://itunes.apple.com/lookup?id=${store.appleAppId}&country=${store.country}`);
    const data = await lk.json();
    const r = data.results && data.results[0];
    if (r) meta = { rating: r.averageUserRating ?? null, ratingCount: r.userRatingCount ?? null };
  } catch (e) {
    log(`애플 메타 조회 실패: ${e.message}`);
  }
  log(`애플 앱스토어 → ${reviews.length}건 (평점 ${meta.rating ?? '?'}, 평가 ${meta.ratingCount ?? '?'})`);
  return { reviews, meta };
}

// 이번 수집에서 처음 등장한 리뷰만 firstSeenAt 기록 → 대시보드 NEW 배지 판별용
// 기존 리뷰에 새로 달린 사장님 답글은 backfill (말투 참고용)
function dedupe(prev, fresh, runIso) {
  const keyOf = (r) => `${r.storeId}|${r.date}|${r.text}`;
  const byKey = new Map(prev.map((r) => [keyOf(r), r]));
  const out = [...prev];
  let added = 0;
  for (const r of fresh) {
    const key = keyOf(r);
    const existing = byKey.get(key);
    if (!existing) {
      const nr = { ...r, firstSeenAt: runIso };
      byKey.set(key, nr);
      out.push(nr);
      added++;
    } else if (r.ownerReply && !existing.ownerReply) {
      existing.ownerReply = r.ownerReply;
      existing.ownerReplyDate = r.ownerReplyDate || existing.ownerReplyDate || null;
    }
  }
  return { merged: out, added };
}

async function main() {
  const stores = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
  const existing = await loadExisting();
  const errors = [];
  const fresh = [];
  const storeMeta = { ...(existing.storeMeta || {}) };

  for (const store of stores) {
    try {
      const { reviews, meta } = store.platform === 'apple' ? await scrapeApple(store) : await scrapeGoogle(store);
      fresh.push(...reviews);
      storeMeta[store.id] = meta;
    } catch (e) {
      log(`실패 → ${store.name}: ${e.message}`);
      errors.push({ storeId: store.id, name: store.name, message: e.message, at: new Date().toISOString() });
    }
    await sleep(500);
  }

  const runIso = new Date().toISOString();
  const { merged, added } = dedupe(existing.reviews || [], fresh, runIso);
  await fs.mkdir(path.dirname(REVIEWS_PATH), { recursive: true });
  await fs.writeFile(
    REVIEWS_PATH,
    JSON.stringify({ lastScrapedAt: runIso, reviews: merged, errors, storeMeta }, null, 2),
    'utf8'
  );
  log(`저장 완료: 누적 ${merged.length}건 (신규 +${added}건, 오류 ${errors.length}건)`);
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
