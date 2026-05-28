/**
 * 감성분석 + 대시보드 요약 데이터 생성 (키워드 룰 기반, API 불필요)
 *
 * - data/reviews.json 의 각 리뷰에 sentiment 필드 추가 (positive/negative/neutral)
 * - 긍정/부정 키워드 매칭 점수를 비교해 분류, 동점이면 neutral
 * - 이미 sentiment가 있는 리뷰는 스킵 (사전 갱신 후 재분석하려면 reviews.json 의 sentiment 필드 삭제)
 * - data/summary.json 생성 (대시보드 소스)
 */
const fs = require('fs').promises;
const path = require('path');

// SOURCE=google 이면 구글, 아니면 네이버 (기본)
const SOURCE = process.env.SOURCE === 'google' ? 'google' : 'naver';
const SUFFIX = SOURCE === 'google' ? '-google' : '';
const REVIEWS_PATH = path.join(__dirname, '..', 'data', `reviews${SUFFIX}.json`);
const SUMMARY_PATH = path.join(__dirname, '..', 'data', `summary${SUFFIX}.json`);
const STORES_PATH = path.join(__dirname, `stores${SUFFIX}.json`);

const log = (...a) => console.log(`[analyze:${SOURCE} ${new Date().toISOString().slice(11, 19)}]`, ...a);

// 한국어 카페/매장 리뷰용 감성 키워드 사전
// 새 단어가 자주 등장하면 여기에 추가만 하면 됨
const POSITIVE_KEYWORDS = [
  '맛있', '맛집', '맛나', '좋아', '좋았', '좋네', '좋고', '좋은', '좋습', '좋더',
  '훌륭', '최고', '멋지', '멋있', '깔끔', '친절', '추천', '만족',
  '편안', '편하', '편리', '쾌적', '넓어', '조용', '아늑', '예쁘', '예뻐', '이쁘', '이뻐',
  '감사', '행복', '즐거', '재방문', '또 가', '또 올', '또 갈', '다시 가', '다시 올',
  '사랑', '굿', '짱', '대박', '완벽', '신선', '부드러', '풍부', '진하',
  '향긋', '고소', '달콤', '청결', '깨끗', '인생', '잘 먹', '잘먹',
  '빠른', '신속', '따뜻', '잘 나', '환상', '너무 좋', '분위기 좋', '분위기가 좋', '분위기도 좋',
  '인테리어 좋', '인테리어가 좋', '맘에 들', '마음에 들', '베스트',
  '신기', '저렴', '놀랐', '퀄리티', '가성비', '힙한', '퀄리티있',
];

const NEGATIVE_KEYWORDS = [
  '별로', '별루', '실망', '불친절', '짜증', '화났', '화나', '화가', '최악',
  '아쉽', '아쉬워', '아쉬운', '비싸', '비싼', '좁', '시끄러', '더럽', '지저분',
  '느림', '느려', '늦어', '늦었', '불편', '불쾌', '싫어',
  '안 좋', '안좋', '다신 안', '다시는 안', '후회', '안 가', '안갈', '못 가', '못갈',
  '평범', '맛없', '맛 없', '맛이 없', '차갑', '미지근', '무성의', '무관심', '인색',
  '형편없', '짜증나', '쓰레기', '엉망', '오래 기다', '한참 기다',
  '대기 시간', '대기시간이', '재방문 안', '두 번 다시', '두번 다시',
];
// 부정어가 부정 키워드 앞에 있으면 부정 매칭 무효 (예: "안 비싸", "전혀 별로")
const NEGATION_PREFIXES = ['안 ', '안', '덜 ', '덜', '전혀 ', '전혀'];

function hasNegationPrefix(text, idx) {
  const window = text.slice(Math.max(0, idx - 6), idx);
  return NEGATION_PREFIXES.some((p) => window.endsWith(p));
}

function scoreReview(text) {
  if (!text) return { pos: 0, neg: 0, sentiment: 'neutral' };
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) pos++;
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(kw, from);
      if (idx === -1) break;
      if (!hasNegationPrefix(lower, idx)) {
        neg++;
        break; // 같은 키워드 중복 카운트 방지 — 한 번 매칭으로 충분
      }
      from = idx + kw.length;
    }
  }
  let sentiment = 'neutral';
  if (pos > neg) sentiment = 'positive';
  else if (neg > pos) sentiment = 'negative';
  return { pos, neg, sentiment };
}

function classify(text) {
  return scoreReview(text).sentiment;
}

// 대표 리뷰 후보: 글자 ≥ MIN_REP_LEN, 점수 ≥ MIN_REP_SCORE, 점수 높은 순 상위 N개
const MIN_REP_LEN = 30;
const MIN_REP_SCORE = 2;
const REP_COUNT = 3;

function pickRepresentatives(items, sentiment) {
  const scoreKey = sentiment === 'positive' ? 'pos' : 'neg';
  const toRep = (r) => ({ date: r.date, text: r.text, rating: r.rating, sentiment: r.sentiment });
  const sortByScore = (a, b) => b[scoreKey] - a[scoreKey] || (b.text?.length || 0) - (a.text?.length || 0);

  const allOfSentiment = items.filter((r) => r.sentiment === sentiment);
  const strict = allOfSentiment
    .filter((r) => (r.text || '').length >= MIN_REP_LEN && r[scoreKey] >= MIN_REP_SCORE)
    .sort(sortByScore);

  if (strict.length >= REP_COUNT) return strict.slice(0, REP_COUNT).map(toRep);

  // 엄격 기준이 3건 미만이면 같은 감성 전체에서 점수 높은 순으로 채움 (짧거나 점수 낮은 것도 허용)
  const strictSet = new Set(strict);
  const fillers = allOfSentiment.filter((r) => !strictSet.has(r)).sort(sortByScore);
  return [...strict, ...fillers].slice(0, REP_COUNT).map(toRep);
}

// 네이버 리뷰 날짜 문자열 파싱
// - "2025.04.10" 4자리 연도 절대 날짜
// - "3일 전", "2주 전" 등 상대 날짜
// - "25.12.27" 2자리 연도 절대 날짜 (요일 없음, 과거 연도)
// - "5.6.수" 올해 (요일 suffix 있음)
function parseDate(s) {
  if (!s) return null;
  const trimmed = String(s).trim();

  const abs4 = trimmed.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (abs4) return new Date(`${abs4[1]}-${abs4[2].padStart(2, '0')}-${abs4[3].padStart(2, '0')}`);

  const rel = trimmed.match(/(\d+)\s*(일|주|개월|달|년)\s*전/);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date();
    if (rel[2] === '일') d.setDate(d.getDate() - n);
    else if (rel[2] === '주') d.setDate(d.getDate() - n * 7);
    else if (rel[2] === '개월' || rel[2] === '달') d.setMonth(d.getMonth() - n);
    else if (rel[2] === '년') d.setFullYear(d.getFullYear() - n);
    return d;
  }

  // 숫자 토큰 개수로 구분:
  //   3개 (예: "25.12.30.화") → YY.M.D (과거 연도, 요일 suffix 포함)
  //   2개 (예: "5.6.수")      → M.D (올해)
  const nums = trimmed.match(/\d+/g) || [];
  if (nums.length >= 3) {
    const yy = Number(nums[0]);
    const year = yy + (yy >= 70 ? 1900 : 2000);
    return new Date(year, Number(nums[1]) - 1, Number(nums[2]));
  }
  if (nums.length === 2) {
    const now = new Date();
    return new Date(now.getFullYear(), Number(nums[0]) - 1, Number(nums[1]));
  }
  return null;
}

async function main() {
  const data = JSON.parse(await fs.readFile(REVIEWS_PATH, 'utf8'));
  const stores = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
  const reviews = data.reviews || [];

  // 룰 기반은 빠르고 무료라 매번 전체 재분류 (사전 갱신이 즉시 반영됨)
  const scored = new Map();
  let changed = 0;
  for (const r of reviews) {
    const s = scoreReview(r.text);
    scored.set(r, s);
    if (r.sentiment !== s.sentiment) changed++;
    r.sentiment = s.sentiment;
  }
  log(`전체 ${reviews.length}건 재분류 (변경 ${changed}건)`);

  // 매장별 집계
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const buckets = new Map(stores.map((s) => [s.id, { id: s.id, name: s.name, items: [] }]));
  for (const r of reviews) {
    const b = buckets.get(r.storeId);
    if (b) {
      const { pos, neg } = scored.get(r);
      b.items.push({ ...r, pos, neg });
    }
  }

  const storesSummary = [...buckets.values()].map((b) => {
    const total = b.items.length;
    const pos = b.items.filter((r) => r.sentiment === 'positive').length;
    const neg = b.items.filter((r) => r.sentiment === 'negative').length;
    const neu = b.items.filter((r) => r.sentiment === 'neutral').length;
    const dates = b.items.map((r) => parseDate(r.date)).filter(Boolean);
    const monthly = dates.filter((d) => d >= thirtyDaysAgo).length;
    const latest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    return {
      id: b.id,
      name: b.name,
      reviewCount: total,
      positiveRatio: total ? pos / total : 0,
      negativeRatio: total ? neg / total : 0,
      neutralRatio: total ? neu / total : 0,
      monthlyActivity: monthly,
      latestReviewDate: latest ? latest.toISOString().slice(0, 10) : null,
    };
  });

  const totalReviews = reviews.length;
  const totalStores = stores.length;
  const monthlyTotal = storesSummary.reduce((a, s) => a + s.monthlyActivity, 0);

  // 연도별 × 월별 감성 집계 (월 인덱스 0~11)
  const monthlySentimentByYear = {};
  for (const r of reviews) {
    const d = parseDate(r.date);
    if (!d || !r.sentiment) continue;
    const y = d.getFullYear();
    const m = d.getMonth();
    if (!monthlySentimentByYear[y]) {
      monthlySentimentByYear[y] = Array.from({ length: 12 }, () => ({ positive: 0, negative: 0, neutral: 0 }));
    }
    if (monthlySentimentByYear[y][m][r.sentiment] != null) {
      monthlySentimentByYear[y][m][r.sentiment]++;
    }
  }
  const availableYears = Object.keys(monthlySentimentByYear).map(Number).sort((a, b) => b - a);

  // 매장별 최근 5건 + 긍정/부정 대표 3건씩 (모달용)
  const recentReviewsByStore = {};
  const representativeByStore = {};
  for (const b of buckets.values()) {
    const sorted = [...b.items].sort((a, c) => {
      const da = parseDate(a.date)?.getTime() || 0;
      const dc = parseDate(c.date)?.getTime() || 0;
      return dc - da;
    });
    recentReviewsByStore[b.id] = sorted.slice(0, 5).map((r) => ({
      date: r.date,
      text: r.text,
      rating: r.rating,
      sentiment: r.sentiment,
    }));
    representativeByStore[b.id] = {
      positive: pickRepresentatives(b.items, 'positive'),
      negative: pickRepresentatives(b.items, 'negative'),
    };
  }

  const summary = {
    lastUpdated: new Date().toISOString(),
    totalStores,
    totalReviews,
    avgReviewsPerStore: totalStores ? Number((totalReviews / totalStores).toFixed(1)) : 0,
    monthlyActivity: monthlyTotal,
    stores: storesSummary,
    recentReviewsByStore,
    representativeByStore,
    monthlySentimentByYear,
    availableYears,
  };

  await fs.writeFile(REVIEWS_PATH, JSON.stringify(data, null, 2), 'utf8');
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  log(`summary 저장: ${SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
