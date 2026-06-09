/**
 * 자동 답글 생성 (Claude API, 빌드 시 사전 생성)
 *
 * - 대시보드 리뷰 모달에 노출되는 리뷰(최근 + 긍정/부정 대표)에 대해서만 생성 → 비용 한정
 * - 실제 사장님 답글(ownerReply)을 few-shot 예시로 사용해 말투를 모사
 * - data/reply-cache{SUFFIX}.json 에 캐시 → 한 번 생성한 리뷰는 재생성하지 않음
 * - 생성 결과를 summary{SUFFIX}.json 의 리뷰 항목에 autoReply 로 주입
 *
 * 필요: 환경변수 ANTHROPIC_API_KEY (로컬은 .env, CI 는 GitHub Secret)
 * 키가 없으면 조용히 스킵(기존 summary 유지) → 다른 파이프라인을 막지 않음
 */
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const SOURCE = process.env.SOURCE || 'naver';
const SUFFIX = SOURCE === 'naver' ? '' : `-${SOURCE}`;
const SUMMARY_PATH = path.join(__dirname, '..', 'data', `summary${SUFFIX}.json`);
const REVIEWS_PATH = path.join(__dirname, '..', 'data', `reviews${SUFFIX}.json`);
const CACHE_PATH = path.join(__dirname, '..', 'data', `reply-cache${SUFFIX}.json`);
const MODEL = process.env.REPLY_MODEL || 'claude-haiku-4-5-20251001';
const MAX_EXAMPLES = 6;

const log = (...a) => console.log(`[reply:${SOURCE} ${new Date().toISOString().slice(11, 19)}]`, ...a);
const keyOf = (storeId, text) => crypto.createHash('sha256').update(`${storeId}|${text}`).digest('hex').slice(0, 16);
const readJson = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};

function buildSystemPrompt(examples) {
  const exBlock = examples.length
    ? examples
        .map((e, i) => `예시 ${i + 1}\n[고객 리뷰] ${e.review}\n[사장님 답글] ${e.reply}`)
        .join('\n\n')
    : '(참고할 기존 답글이 없습니다. 정중하고 따뜻한 브랜드 톤으로 작성하세요.)';
  return [
    "당신은 카페 브랜드 '라운지엑스(LOUNGE'X)'의 매장 운영자입니다. 고객 리뷰에 직접 답글을 답니다.",
    '아래는 실제로 우리가 남겨온 답글 예시입니다. 이 말투·톤·구성을 그대로 따라 새 리뷰에 답글을 작성하세요.',
    '',
    exBlock,
    '',
    '작성 규칙:',
    "- '안녕하세요 :)' 같은 인사로 시작하고, 리뷰 내용을 구체적으로 언급하며 감사를 전하고, 재방문을 부드럽게 유도하며 마무리합니다.",
    '- 2~4문장, 자연스러운 한국어. 과장·이모지 남발 금지. 부정 리뷰에는 사과와 개선 의지를 진심 있게 담습니다.',
    '- 답글 본문만 출력하세요. 따옴표나 머리말 없이.',
  ].join('\n');
}

async function generateReply(client, system, reviewText) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: `[고객 리뷰]\n${reviewText}\n\n[사장님 답글]` }],
  });
  return (res.content?.[0]?.text || '').trim();
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasKey = Boolean(apiKey && apiKey.startsWith('sk-'));
  const summary = await readJson(SUMMARY_PATH, null);
  if (!summary) {
    log('summary 없음 — 스킵');
    return;
  }
  const reviewsData = await readJson(REVIEWS_PATH, { reviews: [] });
  const cache = await readJson(CACHE_PATH, {});

  // 매장(플랫폼)별 실제 답글 예시 풀
  const examplesByStore = {};
  const toExample = (r) => ({ review: r.text.slice(0, 200), reply: r.ownerReply.slice(0, 220) });
  for (const r of reviewsData.reviews || []) {
    if (!r.ownerReply || !r.text) continue;
    (examplesByStore[r.storeId] ||= []).push(toExample(r));
  }
  // 브랜드 말투는 플랫폼 공통 → 현재 소스에 답글이 적으면 네이버 답글을 fallback 예시로
  let brandExamples = Object.values(examplesByStore).flat();
  if (SOURCE !== 'naver' && brandExamples.length < MAX_EXAMPLES) {
    const naver = await readJson(path.join(__dirname, '..', 'data', 'reviews.json'), { reviews: [] });
    const naverEx = (naver.reviews || []).filter((r) => r.ownerReply && r.text).map(toExample);
    brandExamples = [...brandExamples, ...naverEx];
  }
  const allExamples = brandExamples;
  const pickExamples = (storeId) => {
    const own = examplesByStore[storeId] || [];
    const pool = own.length >= 2 ? own : [...own, ...allExamples];
    return pool.slice(0, MAX_EXAMPLES);
  };

  // 모달에 노출되는 리뷰 수집 (최근 + 대표) — storeId 와 함께
  const targets = [];
  for (const [storeId, items] of Object.entries(summary.recentReviewsByStore || {})) {
    (items || []).forEach((it) => targets.push({ storeId, item: it }));
  }
  for (const [storeId, rep] of Object.entries(summary.representativeByStore || {})) {
    [...(rep.positive || []), ...(rep.negative || [])].forEach((it) => targets.push({ storeId, item: it }));
  }

  let client = null;
  if (hasKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey });
  } else {
    log('유효한 ANTHROPIC_API_KEY 없음 — 신규 생성 없이 기존 캐시만 적용');
  }

  let generated = 0;
  let cached = 0;
  for (const { storeId, item } of targets) {
    if (!item.text) continue;
    const k = keyOf(storeId, item.text);
    if (!cache[k] && client) {
      try {
        const system = buildSystemPrompt(pickExamples(storeId));
        cache[k] = await generateReply(client, system, item.text);
        generated++;
      } catch (e) {
        log(`생성 실패 (${storeId}): ${e.message}`);
        continue;
      }
    } else if (cache[k]) {
      cached++;
    }
    if (cache[k]) item.autoReply = cache[k]; // 캐시 있으면 항상 summary 에 반영
  }

  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  log(`완료: 신규 생성 ${generated}건, 캐시 적용 ${cached}건 → ${SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error('자동 답글 생성 오류:', err.message);
  process.exit(0); // 답글 생성 실패가 전체 파이프라인을 막지 않도록
});
