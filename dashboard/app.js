const PALETTE = ['#4263eb', '#1f2329', '#7950f2', '#f59f00', '#2f9e44', '#e8590c', '#15aabf', '#e64980', '#5c7cfa', '#fab005'];
const SENTIMENT_LABEL = { positive: '긍정', negative: '부정', neutral: '중립' };

let summary = null;
let sortKey = 'monthlyActivity';
let sortDir = 'desc';
let donutChart = null;
let monthlyChart = null;
let keywordsChart = null;
let selectedYear = null;
let currentSource = 'naver';

const SOURCE_LABEL = { naver: '네이버 플레이스', google: '구글' };
const SOURCE_SUMMARY_FILE = { naver: 'summary.json', google: 'summary-google.json' };

const $ = (s) => document.querySelector(s);
const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;
const fmtDateTime = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '-');
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function emptySummary() {
  return {
    lastUpdated: null,
    totalStores: 0,
    totalReviews: 0,
    avgReviewsPerStore: 0,
    monthlyActivity: 0,
    stores: [],
    recentReviewsByStore: {},
    representativeByStore: {},
    monthlySentimentByYear: {},
    availableYears: [],
    keywordFrequency: [],
  };
}

async function load() {
  const file = SOURCE_SUMMARY_FILE[currentSource];
  const res = await fetch(`../data/${file}`, { cache: 'no-store' });
  if (res.status === 404) {
    summary = emptySummary();
    render();
    showEmptyState();
    return;
  }
  if (!res.ok) throw new Error(`${file} 로드 실패 (${res.status})`);
  summary = await res.json();
  hideEmptyState();
  render();
}

function showEmptyState() {
  let banner = document.querySelector('#emptyBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'emptyBanner';
    banner.className = 'empty-banner';
    document.querySelector('main').prepend(banner);
  }
  if (currentSource === 'google') {
    banner.innerHTML = `
      <strong>구글 리뷰 데이터가 아직 없습니다.</strong>
      <p>다음 단계로 시작하세요:</p>
      <ol>
        <li><code>.env</code> 에 <code>GOOGLE_PLACES_API_KEY</code> 추가</li>
        <li>터미널에서 <code>npm run find:google</code> 실행 (매장 → place_id 자동 매칭, 1회만)</li>
        <li>우상단 <b>데이터 업데이트</b> 버튼 클릭 또는 <code>npm run update:google</code></li>
      </ol>
    `;
  } else {
    banner.innerHTML = `<strong>${SOURCE_LABEL[currentSource]} 데이터가 없습니다.</strong> 데이터 업데이트 버튼을 눌러주세요.`;
  }
}

function hideEmptyState() {
  document.querySelector('#emptyBanner')?.remove();
}

function render() {
  $('#lastUpdated').textContent = fmtDateTime(summary.lastUpdated);
  $('#kpiStores').textContent = summary.totalStores.toLocaleString();
  $('#kpiReviews').textContent = summary.totalReviews.toLocaleString();
  $('#kpiAvg').textContent = summary.avgReviewsPerStore.toFixed(1);
  $('#kpiMonthly').textContent = summary.monthlyActivity.toLocaleString();
  drawDonut();
  drawTable();
  setupYearSelector();
  drawMonthly();
  drawKeywords();
}

const KEYWORD_COLOR = { positive: '#2f9e44', negative: '#e03131', neutral: '#4263eb' };

function drawKeywords() {
  const ctx = $('#keywords');
  if (keywordsChart) keywordsChart.destroy();
  const items = summary.keywordFrequency || [];
  if (items.length === 0) {
    keywordsChart = null;
    ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
    return;
  }
  keywordsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: items.map((k) => k.word),
      datasets: [
        {
          data: items.map((k) => k.count),
          backgroundColor: items.map((k) => KEYWORD_COLOR[k.sentiment] || KEYWORD_COLOR.neutral),
          borderRadius: 6,
          borderSkipped: false,
          barThickness: 'flex',
          maxBarThickness: 22,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1f2329',
          padding: 10,
          titleFont: { family: 'Pretendard, sans-serif', size: 12, weight: '600' },
          bodyFont: { family: 'Pretendard, sans-serif', size: 12 },
          callbacks: { label: (c) => `${c.parsed.x.toLocaleString()}개 리뷰에서 언급` },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { color: '#9a9fa8', font: { family: 'Pretendard, sans-serif', size: 11 }, precision: 0 },
          grid: { color: '#f0f0f4' },
          border: { display: false },
        },
        y: {
          ticks: { color: '#495057', font: { family: 'Pretendard, sans-serif', size: 12, weight: '500' } },
          grid: { display: false },
          border: { color: '#ececf1' },
        },
      },
    },
  });
}

function setupYearSelector() {
  const select = $('#yearSelect');
  const years = (summary.availableYears && summary.availableYears.length)
    ? summary.availableYears
    : [new Date().getFullYear()];
  if (!selectedYear || !years.includes(selectedYear)) selectedYear = years[0];
  select.innerHTML = years.map((y) => `<option value="${y}" ${y === selectedYear ? 'selected' : ''}>${y}년</option>`).join('');
  select.onchange = () => {
    selectedYear = Number(select.value);
    drawMonthly();
  };
}

function drawMonthly() {
  const ctx = $('#monthly');
  if (monthlyChart) monthlyChart.destroy();
  const byYear = summary.monthlySentimentByYear || {};
  const months = byYear[selectedYear] || Array.from({ length: 12 }, () => ({ positive: 0, negative: 0, neutral: 0 }));
  const labels = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);
  monthlyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '긍정',
          data: months.map((m) => m.positive),
          borderColor: '#2f9e44',
          backgroundColor: 'rgba(47, 158, 68, 0.08)',
          borderWidth: 2.5,
          tension: 0.35,
          pointRadius: 3.5,
          pointHoverRadius: 6,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#2f9e44',
          pointBorderWidth: 2,
          fill: true,
        },
        {
          label: '부정',
          data: months.map((m) => m.negative),
          borderColor: '#e03131',
          backgroundColor: 'rgba(224, 49, 49, 0.08)',
          borderWidth: 2.5,
          tension: 0.35,
          pointRadius: 3.5,
          pointHoverRadius: 6,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#e03131',
          pointBorderWidth: 2,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: '#495057',
            boxWidth: 10,
            boxHeight: 10,
            padding: 14,
            font: { family: 'Pretendard, sans-serif', size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          backgroundColor: '#1f2329',
          padding: 10,
          titleFont: { family: 'Pretendard, sans-serif', size: 12, weight: '600' },
          bodyFont: { family: 'Pretendard, sans-serif', size: 12 },
          callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toLocaleString()}건` },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#9a9fa8', font: { family: 'Pretendard, sans-serif', size: 11 } },
          border: { color: '#ececf1' },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: '#9a9fa8',
            font: { family: 'Pretendard, sans-serif', size: 11 },
            precision: 0,
            stepSize: 1,
          },
          grid: { color: '#f0f0f4' },
          border: { display: false },
        },
      },
    },
  });
}

function drawDonut() {
  const ctx = $('#donut');
  if (donutChart) donutChart.destroy();
  const stores = summary.stores;
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: stores.map((s) => s.name),
      datasets: [
        {
          data: stores.map((s) => s.reviewCount),
          backgroundColor: stores.map((_, i) => PALETTE[i % PALETTE.length]),
          borderColor: '#ffffff',
          borderWidth: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#495057',
            boxWidth: 12,
            boxHeight: 12,
            padding: 14,
            font: { family: 'Pretendard, sans-serif', size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          backgroundColor: '#1f2329',
          padding: 10,
          titleFont: { family: 'Pretendard, sans-serif', size: 12, weight: '600' },
          bodyFont: { family: 'Pretendard, sans-serif', size: 12 },
          callbacks: { label: (c) => `${c.label}: ${c.parsed.toLocaleString()}건` },
        },
      },
    },
  });
}

function drawTable() {
  const tbody = $('#storeTable tbody');
  const rows = [...summary.stores].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  tbody.innerHTML = rows
    .map(
      (s) => `
    <tr>
      <td><span class="store-link" data-store="${s.id}">${escapeHtml(s.name)}</span>${s.newReviewCount > 0 ? `<span class="new-badge" title="이번 업데이트에서 새로 추가된 리뷰 ${s.newReviewCount}건">NEW${s.newReviewCount > 1 ? ` ${s.newReviewCount}` : ''}</span>` : ''}</td>
      <td>${s.reviewCount.toLocaleString()}</td>
      <td>${barCell(s.positiveRatio, 'positive')}</td>
      <td>${barCell(s.negativeRatio, 'negative')}</td>
      <td>${s.monthlyActivity.toLocaleString()}</td>
      <td>${s.latestReviewDate || '-'}</td>
    </tr>`
    )
    .join('');
  tbody.querySelectorAll('.store-link').forEach((el) => {
    el.addEventListener('click', () => openStore(el.dataset.store));
  });
}

function barCell(v, cls) {
  const w = (v * 100).toFixed(1);
  return `<div class="bar"><div class="bar-track"><div class="bar-fill ${cls}" style="width:${w}%"></div></div><span class="bar-value">${fmtPct(v)}</span></div>`;
}

function renderReviewList(items, emptyMsg) {
  if (!items || items.length === 0) return `<p class="empty-msg">${emptyMsg}</p>`;
  return items
    .map(
      (r) => `
      <div class="review-item">
        <div class="review-meta">
          ${r.isNew ? '<span class="new-badge">NEW</span>' : ''}
          <span>${escapeHtml(r.date || '')}</span>
          ${r.rating ? `<span>★ ${r.rating}</span>` : ''}
          <span class="sentiment-tag ${r.sentiment || 'neutral'}">${SENTIMENT_LABEL[r.sentiment || 'neutral']}</span>
        </div>
        <div class="review-text">${escapeHtml(r.text)}</div>
      </div>`
    )
    .join('');
}

function openStore(id) {
  const store = summary.stores.find((s) => s.id === id);
  const recent = (summary.recentReviewsByStore || {})[id] || [];
  const rep = (summary.representativeByStore || {})[id] || { positive: [], negative: [] };
  $('#modalTitle').textContent = `${store?.name ?? id} · 리뷰 상세`;
  $('#modalBody').innerHTML = `
    <section class="review-section">
      <h4 class="review-section-title">최근 리뷰 ${recent.length}건</h4>
      ${renderReviewList(recent, '표시할 리뷰가 없습니다.')}
    </section>
    <section class="review-section">
      <h4 class="review-section-title positive">★ 긍정 대표 ${rep.positive.length}건</h4>
      ${renderReviewList(rep.positive, '기준(글자수 30+, 키워드 2개+)에 맞는 긍정 리뷰가 없습니다.')}
    </section>
    <section class="review-section">
      <h4 class="review-section-title negative">☆ 부정 대표 ${rep.negative.length}건</h4>
      ${renderReviewList(rep.negative, '기준에 맞는 부정 리뷰가 없습니다.')}
    </section>
  `;
  $('#modal').hidden = false;
}

document.querySelectorAll('thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else {
      sortKey = k;
      sortDir = 'desc';
    }
    drawTable();
  });
});

document.querySelectorAll('[data-close]').forEach((el) => {
  el.addEventListener('click', () => {
    $('#modal').hidden = true;
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#modal').hidden = true;
});

function showToast(msg, ms = 2400) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), ms);
}

const HAS_BACKEND = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const PHASE_LABEL = { scrape: '리뷰 수집 중', analyze: '감성 분석 중' };

// 백엔드 없는 환경 (GitHub Pages 등) 에서는 버튼 라벨/툴팁을 조정
if (!HAS_BACKEND) {
  document.addEventListener('DOMContentLoaded', () => {
    const label = document.getElementById('refreshLabel');
    const btn = document.getElementById('refreshBtn');
    if (label) label.textContent = '데이터 새로고침';
    if (btn) {
      btn.title =
        '대시보드 데이터를 다시 불러옵니다.\n' +
        '실제 리뷰 수집은 매일 03:00 KST 에 GitHub Actions 가 자동 실행합니다.';
    }
  });
}

async function pollUpdate(startMs) {
  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch('/api/update/status', { cache: 'no-store' });
    const s = await res.json();
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    if (s.running) {
      const phase = PHASE_LABEL[s.phase] || '실행 중';
      $('#refreshLabel').textContent = `${phase} ${elapsed}s`;
      const tail = (s.logTail || []).filter((l) => !l.startsWith('[err]')).slice(-1)[0];
      if (tail) showToast(tail.replace(/^\[[^\]]+\]\s*/, ''), 3000);
    } else {
      return { ...s, elapsed };
    }
  }
}

$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  const label = $('#refreshLabel');
  const originalText = label.textContent;
  btn.disabled = true;
  btn.classList.add('spinning');
  const start = Date.now();

  // GitHub Pages 등 백엔드가 없는 환경: 단순히 summary.json 만 다시 불러옴
  if (!HAS_BACKEND) {
    label.textContent = '불러오는 중...';
    try {
      await load();
      showToast('데이터 새로고침 완료 (실제 수집은 로컬 npm run update 필요)', 3500);
    } catch (e) {
      showToast(`로드 실패: ${e.message}`, 4000);
    } finally {
      label.textContent = originalText;
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
    return;
  }

  // 로컬 Node 서버 환경: 실제 스크래퍼 실행
  label.textContent = '시작 중...';
  try {
    const res = await fetch(`/api/update?source=${currentSource}`, { method: 'POST' });
    if (res.status === 409) {
      showToast('이미 업데이트가 진행 중입니다', 3000);
    } else if (!res.ok) {
      throw new Error(`서버 응답 ${res.status}`);
    } else {
      showToast('네이버에서 최신 리뷰 가져오는 중... (1~2분)', 4000);
    }
    const final = await pollUpdate(start);
    if (final.ok) {
      await load();
      showToast(`업데이트 완료 · ${final.elapsed}초 소요`, 3000);
    } else {
      showToast(`업데이트 실패: ${final.message || '알 수 없는 오류'}`, 5000);
    }
  } catch (e) {
    showToast(`오류: ${e.message}`, 5000);
  } finally {
    label.textContent = originalText;
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
});

function switchSource(source) {
  if (source === currentSource) return;
  currentSource = source;
  document.querySelectorAll('.nav-item[data-source]').forEach((el) => {
    el.classList.toggle('active', el.dataset.source === source);
  });
  $('#pageTitle').textContent = source === 'google' ? '구글 리뷰 모니터링' : '네이버 플레이스 리뷰 모니터링';
  load().catch((err) => showToast(`로드 실패: ${err.message}`, 4000));
}

document.querySelectorAll('.nav-item[data-source]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    switchSource(el.dataset.source);
  });
});

if (window.lucide) window.lucide.createIcons();

load().catch((err) => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="error-banner">데이터 로드 실패: ${escapeHtml(err.message)}<br>먼저 <code>npm run update</code>를 실행해 <code>data/summary.json</code>을 생성하세요.</div>`
  );
});
