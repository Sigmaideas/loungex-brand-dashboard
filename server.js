/**
 * 통합 서버: 정적 대시보드 + 업데이트 API
 *
 *  GET  /                     → /dashboard/index.html 으로 리다이렉트
 *  GET  /dashboard/...        → 정적 파일
 *  GET  /data/summary.json    → 정적 파일
 *  POST /api/update           → 백그라운드로 scrape + analyze 실행 (202)
 *  GET  /api/update/status    → 현재 작업 상태 + 최근 로그
 *
 * 동시 실행은 1건만 허용 (이미 실행 중이면 409).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let job = {
  running: false,
  source: null, // 'naver' | 'google'
  startedAt: null,
  finishedAt: null,
  ok: null,
  message: null,
  phase: null, // 'scrape' | 'analyze' | null
  log: [],
};

const log = (...a) => console.log(`[server ${new Date().toISOString().slice(11, 19)}]`, ...a);

function pushLog(line) {
  job.log.push(line);
  if (job.log.length > 200) job.log.shift();
}

function runStep(script, phase, extraEnv = {}) {
  return new Promise((resolve) => {
    job.phase = phase;
    pushLog(`▶ ${phase} 시작`);
    const child = spawn('node', [`scraper/${script}`], { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    child.stdout.on('data', (d) => d.toString().split(/\n/).filter(Boolean).forEach(pushLog));
    child.stderr.on('data', (d) => d.toString().split(/\n/).filter(Boolean).forEach((l) => pushLog('[err] ' + l)));
    child.on('close', (code) => resolve(code));
    child.on('error', (e) => {
      pushLog('[err] spawn 실패: ' + e.message);
      resolve(-1);
    });
  });
}

async function runUpdate(source) {
  job = {
    running: true,
    source,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    message: null,
    phase: 'scrape',
    log: [],
  };
  log(`업데이트 시작 (source=${source})`);

  const scrapeScript = source === 'google' ? 'scrape-google.js' : 'scrape.js';
  const analyzeEnv = source === 'google' ? { SOURCE: 'google' } : {};

  const scrapeCode = await runStep(scrapeScript, 'scrape');
  if (scrapeCode !== 0) {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    job.ok = false;
    job.message = `scrape 실패 (exit ${scrapeCode})`;
    job.phase = null;
    log(job.message);
    return;
  }
  const analyzeCode = await runStep('analyze.js', 'analyze', analyzeEnv);
  job.running = false;
  job.finishedAt = new Date().toISOString();
  job.ok = analyzeCode === 0;
  job.message = analyzeCode === 0 ? '완료' : `analyze 실패 (exit ${analyzeCode})`;
  job.phase = null;
  log(job.message);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/dashboard/';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const fullPath = path.normalize(path.join(ROOT, urlPath));
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found: ' + urlPath);
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/update') {
    if (job.running) return sendJson(res, 409, { error: '이미 실행 중입니다.' });
    const source = url.searchParams.get('source') === 'google' ? 'google' : 'naver';
    runUpdate(source);
    return sendJson(res, 202, { started: true, source });
  }
  if (req.method === 'GET' && url.pathname === '/api/update/status') {
    return sendJson(res, 200, {
      running: job.running,
      source: job.source,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      ok: job.ok,
      message: job.message,
      phase: job.phase,
      logTail: job.log.slice(-8),
    });
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  log(`Dashboard: http://localhost:${PORT}/dashboard/`);
});
