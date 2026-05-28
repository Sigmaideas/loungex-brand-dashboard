/**
 * loungex-update-trigger
 *
 * 정적 호스팅된 대시보드(GitHub Pages)에서 GitHub Actions 워크플로우를
 * 안전하게 트리거할 수 있게 해주는 Cloudflare Worker.
 *
 * - 환경 변수 GITHUB_TOKEN: fine-grained PAT (Actions: Read & Write 권한, 이 저장소 한정)
 * - 환경 변수 ALLOWED_ORIGIN: 호출 허용할 출처 (예: https://sigmaideas.github.io)
 * - 환경 변수 REPO: "owner/name" (예: Sigmaideas/loungex-brand-dashboard)
 * - 환경 변수 WORKFLOW: 워크플로우 파일명 (예: update.yml)
 */

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  });

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const origin = request.headers.get('origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(allowedOrigin) });
    }

    // origin 검증 (정확히 일치)
    if (allowedOrigin !== '*' && origin !== allowedOrigin) {
      return json({ error: 'origin not allowed', origin }, 403, allowedOrigin);
    }

    const url = new URL(request.url);
    const repo = env.REPO;
    const workflow = env.WORKFLOW || 'update.yml';
    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'loungex-dashboard-worker',
    };

    // POST /trigger → 워크플로우 실행 요청
    if (request.method === 'POST' && url.pathname === '/trigger') {
      const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
      const r = await fetch(dispatchUrl, {
        method: 'POST',
        headers: { ...ghHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'main' }),
      });
      if (r.status === 204) return json({ ok: true }, 200, origin);
      const body = await r.text();
      return json({ ok: false, status: r.status, body: body.slice(0, 500) }, r.status, origin);
    }

    // GET /status → 가장 최근 실행 상태
    if (request.method === 'GET' && url.pathname === '/status') {
      const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`;
      const r = await fetch(runsUrl, { headers: ghHeaders });
      if (!r.ok) return json({ error: 'github api', status: r.status }, r.status, origin);
      const data = await r.json();
      const run = data.workflow_runs?.[0];
      return json(
        {
          status: run?.status || 'unknown', // queued | in_progress | completed
          conclusion: run?.conclusion || null, // success | failure | cancelled | null
          createdAt: run?.created_at || null,
          updatedAt: run?.updated_at || null,
          htmlUrl: run?.html_url || null,
          runId: run?.id || null,
        },
        200,
        origin
      );
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
