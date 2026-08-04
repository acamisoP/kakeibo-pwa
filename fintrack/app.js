'use strict';
// FinTrack — 明細DB閲覧専用PWA(編集機能なし)
// GAS WebアプリURLはリポジトリに含めない。?gas=<URL> で一度開くか、
// カメラ版kakeiboと同一オリジンのため設定済みならそのまま引き継がれる。

const GAS_URL = (() => {
  const q = new URLSearchParams(location.search).get('gas');
  if (q) { localStorage.setItem('kakeibo_gas_url', q); history.replaceState(null, '', location.pathname); }
  return localStorage.getItem('kakeibo_gas_url') || '';
})();

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = id => document.getElementById(id);
const vib = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { } };
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ジャンル → [色, 絵文字](色はOne UIブルー系を軸にした落ち着いたパレット)
const GENRE_META = {
  '食費': ['#0381fe', '🍚'], '外食費': ['#3ea8ff', '🍜'], '嗜好品': ['#8e7bff', '🍫'],
  'タバコ': ['#b18cff', '🚬'], '日用品': ['#23c562', '🧻'], '医療・健康': ['#2ed3b7', '💊'],
  '車両費': ['#ffb74d', '🚗'], '交通費': ['#ffd54f', '🚃'], '旅費': ['#ff8a65', '✈️'],
  'サブスク(固定費)': ['#f06292', '📺'], '防衛費': ['#90a4ae', '🛡️'], '仕事(経費)': ['#4dd0e1', '💼'],
  'その他': ['#7f8c9b', '📦'], '給与': ['#23c562', '💰'], '副収入': ['#66d98a', '💸'],
  '未分類': ['#565f6b', '❔'],
};
const gMeta = g => GENRE_META[g] || GENRE_META['その他'];
const PAY_ICON = {
  '楽天ペイ': '📱', 'PayPay': '📱', 'd払い': '📱', 'Sonyデビット': '💳', '楽天カード': '💳',
  '現金': '💵', '楽天ポイント': '🅿️', 'dポイント': '🅿️', 'PayPal': '🌐',
};
const payIcon = p => PAY_ICON[p] || '💳';

// ---------- 状態 ----------
const _now = new Date();
const curM = _now.getFullYear() + '-' + String(_now.getMonth() + 1).padStart(2, '0');
const state = {
  view: 'home',
  m: curM,          // ページャ月(取引・分析)
  filter: 'all',
  q: '',
  overview: null,
  month: {},        // 'YYYY-MM' → APIペイロード
  seen: {},         // カスケード初回判定 'view:month' → true
  err: {},          // 'm<YYYY-MM>'/'ov' → 直近の取得エラー(キャッシュ無し時の再試行カード用)
};
const VIEW_ORDER = ['home', 'tx', 'an'];

// ---------- データ層(stale-while-revalidate) ----------
async function api(params, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs || 45000);
  try {
    const r = await fetch(GAS_URL + '?' + params, { signal: c.signal, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'サーバーエラー');
    return j;
  } finally { clearTimeout(t); }
}

const store = {
  get(k) { try { const v = JSON.parse(localStorage.getItem(k)); return v && v.data ? v : null; } catch (e) { return null; } },
  set(k, data) {
    try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), data })); pruneMonths_(); } catch (e) { }
  },
};
function pruneMonths_() { // 月キャッシュは直近アクセス24ヶ月分まで
  const keys = Object.keys(localStorage).filter(k => k.indexOf('ft_m_') === 0);
  if (keys.length <= 24) return;
  keys.map(k => [k, (store.get(k) || { t: 0 }).t]).sort((a, b) => a[1] - b[1])
    .slice(0, keys.length - 24).forEach(kv => localStorage.removeItem(kv[0]));
}

let syncCount = 0;
function syncOn() { syncCount++; $('sync').textContent = '更新中…'; $('sync').className = 'on'; }
function syncOff(okFlash) {
  if (--syncCount > 0) return;
  if (okFlash) {
    $('sync').textContent = '✓ 最新';
    $('sync').className = 'on done';
    setTimeout(() => { if (!syncCount) $('sync').className = ''; }, 1500);
  } else $('sync').className = '';
}

const inflight = {};
function loadOverview(force) {
  const c = store.get('ft_ov');
  if (c && !state.overview) { state.overview = c.data; rerender(); } // キャッシュ即描画(SWR)
  if (!force && c && Date.now() - c.t < 60000) return Promise.resolve();
  if (inflight.ov) return inflight.ov;
  inflight.ov = (async () => {
    syncOn();
    try {
      const j = await api('ft=overview', 60000);
      state.overview = j; store.set('ft_ov', j);
      delete state.err.ov;
      rerender();
      syncOff(true);
    } catch (e) { state.err.ov = errMsg(e); syncOff(false); onError(e, !state.overview); }
    finally { delete inflight.ov; }
  })();
  return inflight.ov;
}
function loadMonth(m, force) {
  const key = 'ft_m_' + m;
  const c = store.get(key);
  if (c && !state.month[m]) { state.month[m] = c.data; rerender(); } // キャッシュ即描画(SWR)
  if (!force && c && Date.now() - c.t < 60000) return Promise.resolve();
  if (inflight[key]) return inflight[key];
  inflight[key] = (async () => {
    syncOn();
    try {
      const j = await api('ft=month&m=' + m, 60000);
      state.month[m] = j; store.set(key, j);
      delete state.err['m' + m];
      rerender();
      syncOff(true);
    } catch (e) { state.err['m' + m] = errMsg(e); syncOff(false); onError(e, !state.month[m]); }
    finally { delete inflight[key]; }
  })();
  return inflight[key];
}

function errMsg(e) {
  return e && e.name === 'AbortError' ? 'サーバー応答なし(電波を確認)' : String(e && e.message || e);
}
function errCard(msg) {
  return '<div class="card" style="margin-top:6px;text-align:center;padding:34px 20px">' +
    '<div style="font-size:36px;margin-bottom:12px">📡</div>' +
    '<div style="font-weight:800;margin-bottom:6px">データを取得できません</div>' +
    '<div class="sub" style="margin-bottom:18px">' + esc(msg) + '</div>' +
    '<button class="sh-btn pri retry-btn" style="display:block;max-width:220px;margin:0 auto">再試行</button></div>';
}
document.addEventListener('click', e => {
  if (!e.target.closest('.retry-btn')) return;
  vib(8);
  state.err = {};
  rerender();
  loadOverview(true);
  loadMonth(state.view === 'home' ? curM : state.m, true);
});

let toastId = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastId);
  toastId = setTimeout(() => el.classList.remove('on'), 2600);
}
function onError(e, fatal) {
  const msg = e && e.name === 'AbortError' ? 'サーバー応答なし(電波を確認)' : String(e && e.message || e);
  if (fatal) rerender(); // 各ビューがエラーカードを描く
  toast('⚠️ ' + msg);
}

// ---------- 集計 ----------
function calc(m) {
  const data = state.month[m];
  if (!data) return null;
  const txById = {}, itemsByTx = {}, byPay = {}, byGenre = {};
  let expense = 0, income = 0, genreSum = 0;
  data.tx.forEach(t => { txById[t.i] = t; });
  data.tx.forEach(t => {
    if (t.k === '収入') income += t.a;
    else { expense += t.a; const p = t.p || 'その他'; byPay[p] = (byPay[p] || 0) + t.a; }
  });
  data.items.forEach(it => {
    (itemsByTx[it.t] = itemsByTx[it.t] || []).push(it);
    const parent = txById[it.t];
    if (parent && parent.k !== '収入' && it.p > 0) { byGenre[it.g] = (byGenre[it.g] || 0) + it.p; genreSum += it.p; }
  });
  const rest = expense - genreSum;
  if (rest > 0) byGenre['未分類'] = (byGenre['未分類'] || 0) + rest;
  const sortDesc = o => Object.keys(o).map(k => [k, o[k]]).sort((a, b) => b[1] - a[1]);
  return {
    tx: data.tx, expense, income, count: data.tx.length,
    byPay: sortDesc(byPay), byGenre: sortDesc(byGenre), itemsByTx, txById,
  };
}
function ovMonth(m) {
  if (!state.overview) return null;
  return state.overview.months.find(x => x.m === m) || null;
}
function prevM(m) {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7);
  return mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0');
}
function nextM(m) {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7);
  return mo === 12 ? (y + 1) + '-01' : y + '-' + String(mo + 1).padStart(2, '0');
}
function minMonth() {
  return state.overview && state.overview.months.length ? state.overview.months[0].m : '2016-01';
}
// 取引のジャンル(明細の最高額ジャンル)
function txGenre(t, d) {
  const its = d.itemsByTx[t.i];
  if (!its || !its.length) return t.k === '収入' ? '給与' : 'その他';
  let best = its[0];
  its.forEach(it => { if (it.p > best.p) best = it; });
  return best.g;
}

// ---------- アニメーションヘルパー ----------
function countUp(el, to, format) {
  const fmt = format || yen;
  const from = el._v || 0;
  el._v = to;
  if (RM || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 600;
  const tick = t => {
    const p = Math.min(1, (t - t0) / dur);
    const e2 = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e2);
    if (p < 1 && el._v === to) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // 非表示タブ等でrAFが止まっても最終値は必ず確定させる
  setTimeout(() => { if (el._v === to) el.textContent = fmt(to); }, dur + 150);
}
function cascade(nodes) {
  if (RM) return;
  let i = 0;
  nodes.forEach(n => {
    n.classList.add('pop');
    n.style.animationDelay = Math.min(i++, 14) * 30 + 'ms';
  });
}
function growLater(sel, root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    (root || document).querySelectorAll(sel).forEach(el => el.classList.add('grow'));
  }));
}

// ---------- ホーム ----------
function renderHome() {
  const v = $('view-home');
  const d = calc(curM);
  if (!d) { v.innerHTML = state.err['m' + curM] ? errCard(state.err['m' + curM]) : skeletonHome(); return; }
  const firstTime = !state.seen['home'];
  state.seen['home'] = true;

  const pm = ovMonth(prevM(curM));
  const mo = +curM.slice(5, 7);

  let html = '<div class="hero card"><div class="label">今月の支出</div>' +
    '<div id="hero-amount" class="hero-amount">¥0</div>' +
    '<div class="sub">' + mo + '月 / ' + d.count + '件の取引</div></div>';

  if (pm && pm.e > 0) {
    const diff = pm.e - d.expense;
    const pct = Math.min(d.expense / pm.e, 1);
    const C = 2 * Math.PI * 30;
    const good = diff >= 0;
    html += '<div class="wd card"><div class="wd-body">' +
      '<div class="wd-title">' + (good ? 'いい調子！' : 'ペース注意') + '</div>' +
      '<div class="wd-sub">先月より<br><b style="color:' + (good ? 'var(--ok)' : 'var(--err)') + '">' +
      yen(Math.abs(diff)) + ' ' + (good ? '少ない' : '多い') + '</b>支出です</div></div>' +
      '<div class="wd-ring"><svg viewBox="0 0 74 74">' +
      '<circle class="bgc" cx="37" cy="37" r="30"/>' +
      '<circle class="fgc" cx="37" cy="37" r="30" style="stroke:' + (good ? 'var(--accent)' : 'var(--err)') +
      ';stroke-dasharray:' + C + ';stroke-dashoffset:' + C + '" data-off="' + C * (1 - pct) + '"/>' +
      '</svg><div class="pct">' + Math.round(pct * 100) + '%</div></div></div>';
  }

  html += '<div class="row-label">支払方法(今月)</div><div class="paycards">';
  if (d.byPay.length === 0) html += '<div class="sub" style="padding:6px 8px">まだ支出がありません</div>';
  d.byPay.forEach(pv => {
    html += '<div class="paycard"><div class="ic">' + payIcon(pv[0]) + '</div>' +
      '<div class="nm">' + esc(pv[0]) + '</div><div class="amt">' + yen(pv[1]) + '</div></div>';
  });
  html += '</div><div class="row-label">最近の取引<button id="seeall">すべて見る ›</button></div>' +
    '<div class="tgroup"><div class="card" id="recent"></div></div>';

  v.innerHTML = html;
  countUp($('hero-amount'), d.expense);
  const ring = v.querySelector('.fgc');
  if (ring) requestAnimationFrame(() => requestAnimationFrame(() =>
    ring.style.strokeDashoffset = ring.dataset.off));

  const recent = $('recent');
  d.tx.slice(0, 5).forEach(t => recent.appendChild(txRow(t, d, true)));
  if (!d.tx.length) recent.innerHTML = '<div class="empty"><div class="big">🪷</div>今月の取引はまだありません</div>';
  if (firstTime) cascade(v.querySelectorAll('.card, .paycard'));
  $('seeall').onclick = () => { vib(8); navTo('tx'); };
}
function skeletonHome() {
  return '<div class="card" style="margin-top:6px"><div class="sk" style="height:14px;width:90px"></div>' +
    '<div class="sk" style="height:44px;width:220px;margin:14px 0 8px"></div>' +
    '<div class="sk" style="height:12px;width:140px"></div></div>' +
    '<div class="card" style="margin-top:12px;display:flex;gap:16px;align-items:center">' +
    '<div style="flex:1"><div class="sk" style="height:16px;width:110px"></div>' +
    '<div class="sk" style="height:12px;width:170px;margin-top:10px"></div></div>' +
    '<div class="sk" style="width:74px;height:74px;border-radius:50%"></div></div>' +
    '<div style="display:flex;gap:10px;margin-top:22px">' +
    '<div class="sk" style="height:104px;flex:1;border-radius:22px"></div>' +
    '<div class="sk" style="height:104px;flex:1;border-radius:22px"></div>' +
    '<div class="sk" style="height:104px;flex:1;border-radius:22px"></div></div>' +
    '<div class="sk" style="height:260px;margin-top:22px;border-radius:26px"></div>';
}

// ---------- 取引 ----------
function renderTx() {
  const v = $('view-tx');
  const d = calc(state.m);
  const shellNeeded = !v.querySelector('.pills');
  if (shellNeeded) {
    v.innerHTML =
      '<div class="pills"><div id="pill-ind"></div>' +
      '<button data-f="all" class="on">すべて</button>' +
      '<button data-f="支出">支出</button>' +
      '<button data-f="収入">収入</button></div>' +
      '<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round">' +
      '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>' +
      '<input id="q" placeholder="店名・支払方法・商品名で検索" autocomplete="off"></div>' +
      '<div id="txgroups"></div>';
    v.querySelectorAll('.pills button').forEach((b, i) => b.onclick = () => {
      if (state.filter === b.dataset.f) return;
      state.filter = b.dataset.f; vib(8);
      v.querySelectorAll('.pills button').forEach(x => x.classList.toggle('on', x === b));
      $('pill-ind').style.transform = 'translateX(' + i * 100 + '%)';
      delete state.seen['tx:' + state.m];
      renderTxList();
    });
    $('q').oninput = () => { state.q = $('q').value.trim(); renderTxList(); };
  }
  $('q').value = state.q;
  renderTxList();
}
function renderTxList() {
  const wrap = $('txgroups');
  const d = calc(state.m);
  if (!d) {
    wrap.innerHTML = state.err['m' + state.m] ? errCard(state.err['m' + state.m]) :
      '<div class="sk" style="height:120px;margin-top:18px;border-radius:26px"></div>' +
      '<div class="sk" style="height:200px;margin-top:14px;border-radius:26px"></div>';
    return;
  }
  const q = state.q.toLowerCase();
  const match = t => {
    if (state.filter !== 'all' && t.k !== state.filter) return false;
    if (!q) return true;
    if ((t.n + ' ' + t.p + ' ' + t.st).toLowerCase().indexOf(q) !== -1) return true;
    const its = d.itemsByTx[t.i] || [];
    return its.some(it => it.n.toLowerCase().indexOf(q) !== -1);
  };
  const list = d.tx.filter(match);
  if (!list.length) {
    wrap.innerHTML = '<div class="empty"><div class="big">' + (q ? '🔍' : '📭') + '</div>' +
      (q ? '「' + esc(state.q) + '」に一致する取引はありません' : 'この月の取引はありません') + '</div>';
    return;
  }
  // 日付グループ化(APIは日付降順ソート済み)
  const groups = [];
  list.forEach(t => {
    const g = groups[groups.length - 1];
    if (g && g.d === t.d) g.tx.push(t);
    else groups.push({ d: t.d, tx: [t] });
  });
  wrap.innerHTML = '';
  const firstKey = 'tx:' + state.m;
  const firstTime = !state.seen[firstKey];
  state.seen[firstKey] = true;
  groups.forEach(g => {
    const dt = new Date(g.d + 'T00:00:00');
    const total = g.tx.reduce((s, t) => s + (t.k === '収入' ? 0 : t.a), 0);
    const div = document.createElement('div');
    div.className = 'tgroup';
    div.innerHTML = '<div class="tgroup-h"><span class="d">' +
      (dt.getMonth() + 1) + '月' + dt.getDate() + '日(' + WD[dt.getDay()] + ')</span>' +
      (total ? '<span class="t">' + yen(total) + '</span>' : '') + '</div>';
    const card = document.createElement('div');
    card.className = 'card';
    g.tx.forEach(t => card.appendChild(txRow(t, d)));
    div.appendChild(card);
    wrap.appendChild(div);
  });
  if (firstTime) cascade(wrap.querySelectorAll('.tgroup'));
}
function txRow(t, d, compact) {
  const g = txGenre(t, d);
  const inc = t.k === '収入';
  const row = document.createElement('div');
  row.className = 'trow';
  const dt = new Date(t.d + 'T00:00:00');
  const sub = compact
    ? (dt.getMonth() + 1) + '/' + dt.getDate() + (t.p ? '・' + esc(t.p) : '')
    : esc(t.p || t.st || t.s) + (t.st && t.p ? '・' + esc(t.st) : '');
  row.innerHTML = '<div class="ic">' + gMeta(g)[1] + '</div>' +
    '<div class="mid"><div class="nm">' + esc(t.n) + '</div><div class="dt">' + sub + '</div></div>' +
    '<div class="amt' + (inc ? ' inc' : '') + '">' + (inc ? '+' : '') + yen(t.a) + '</div>';
  row.onclick = () => { vib(6); openSheet(t, d); };
  return row;
}

// ---------- 分析 ----------
function renderAn() {
  const v = $('view-an');
  const d = calc(state.m);
  if (!d) {
    v.innerHTML = state.err['m' + state.m] ? errCard(state.err['m' + state.m]) :
      '<div class="sk" style="height:340px;margin-top:6px;border-radius:26px"></div>' +
      '<div class="sk" style="height:230px;margin-top:12px;border-radius:26px"></div>';
    return;
  }
  const mo = +state.m.slice(5, 7);

  // ジャンル別: 上位7+残りは「その他」へ合算(実ジャンル「その他」と重複させない)
  let segs = d.byGenre.map(x => x.slice());
  if (segs.length > 8) {
    const head = segs.slice(0, 7);
    const rest = segs.slice(7).reduce((s, x) => s + x[1], 0);
    const other = head.find(x => x[0] === 'その他');
    if (other) { other[1] += rest; head.sort((a, b) => b[1] - a[1]); }
    else head.push(['その他', rest]);
    segs = head;
  }
  const segSum = segs.reduce((s, x) => s + x[1], 0);

  let html = '<div class="card"><div class="label">ジャンル別支出</div>' +
    '<div class="donut-wrap"><svg id="donut" viewBox="0 0 200 200"></svg>' +
    '<div class="donut-c"><div class="v" id="donut-total">¥0</div>' +
    '<div class="sub">' + mo + '月の支出</div></div></div><div class="legend" id="legend"></div></div>';

  // 月次推移(表示月を右端に12ヶ月)
  html += '<div class="card"><div class="label">月次推移</div><div class="trend" id="trend"></div></div>';

  // 収入・支出カード(前月比)
  const pm = ovMonth(prevM(state.m));
  const dPct = (cur, prev) => {
    if (!prev) return ['—', 'flat'];
    const p = ((cur - prev) / prev) * 100;
    if (Math.abs(p) < 0.5) return ['±0%', 'flat'];
    return [(p > 0 ? '▲ +' : '▼ ') + p.toFixed(0) + '%', p > 0 ? 'up' : 'down'];
  };
  const de = dPct(d.expense, pm && pm.e), di = dPct(d.income, pm && pm.i);
  html += '<div class="duo">' +
    '<div class="card"><div class="label">支出</div><div class="v" id="an-exp">¥0</div>' +
    '<div class="d ' + de[1] + '">' + de[0] + ' <span class="sub">前月比</span></div></div>' +
    '<div class="card"><div class="label">収入</div><div class="v" id="an-inc" style="color:var(--ok)">¥0</div>' +
    '<div class="d ' + (di[1] === 'up' ? 'down' : di[1] === 'down' ? 'up' : 'flat') + '">' + di[0] +
    ' <span class="sub">前月比</span></div></div></div>';

  v.innerHTML = html;
  countUp($('donut-total'), d.expense);
  countUp($('an-exp'), d.expense);
  countUp($('an-inc'), d.income);
  buildDonut($('donut'), segs, segSum);
  buildLegend($('legend'), segs, segSum);
  buildTrend($('trend'));
}
function buildDonut(svg, segs, total) {
  const C = 2 * Math.PI * 74;
  let html = '<circle cx="100" cy="100" r="74" fill="none" stroke="var(--card2)" stroke-width="26"/>';
  svg.innerHTML = html;
  if (!total) return;
  let acc = 0;
  segs.forEach((s, i) => {
    const frac = s[1] / total;
    const len = Math.max(frac * C - 3, 0.5);
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('class', 'seg');
    el.setAttribute('cx', '100'); el.setAttribute('cy', '100'); el.setAttribute('r', '74');
    el.setAttribute('stroke', gMeta(s[0])[0]);
    el.setAttribute('stroke-dasharray', RM ? len + ' ' + (C - len) : '0 ' + C);
    el.setAttribute('stroke-dashoffset', String(C * 0.25 - acc * C));
    svg.appendChild(el);
    if (!RM) setTimeout(() => el.setAttribute('stroke-dasharray', len + ' ' + (C - len)), 60 * i + 80);
    acc += frac;
  });
}
function buildLegend(wrap, segs, total) {
  const top = segs.length ? segs[0][1] : 1;
  wrap.innerHTML = segs.map((s, i) =>
    '<div class="lg-row"><div class="top">' +
    '<span class="dot" style="background:' + gMeta(s[0])[0] + '"></span>' +
    '<span class="g">' + gMeta(s[0])[1] + ' ' + esc(s[0]) + '</span>' +
    '<span class="p">' + (total ? Math.round(s[1] / total * 100) : 0) + '%</span>' +
    '<span class="v">' + yen(s[1]) + '</span></div>' +
    '<div class="bar"><i style="background:' + gMeta(s[0])[0] + ';width:' +
    Math.max(s[1] / top * 100, 2) + '%;transition-delay:' + (i * 40 + 150) + 'ms"></i></div></div>'
  ).join('') || '<div class="empty" style="padding:20px 0"><div class="big">🪷</div>この月の支出はありません</div>';
  growLater('.lg-row .bar i', wrap);
}
function buildTrend(wrap) {
  const months = [];
  let m = state.m;
  for (let i = 0; i < 12; i++) { months.unshift(m); m = prevM(m); }
  const ovs = months.map(x => ovMonth(x));
  const max = Math.max.apply(null, ovs.map(o => o ? o.e : 0).concat([1]));
  wrap.innerHTML = months.map((x, i) => {
    const e = ovs[i] ? ovs[i].e : 0;
    const h = Math.max(Math.round(e / max * 100), e > 0 ? 4 : 2);
    const cur = x === state.m;
    return '<div class="tbar' + (cur ? ' cur' : '') + '" data-m="' + x + '">' +
      '<div class="v">' + (cur && e ? '¥' + Math.round(e / 1000) + 'k' : '') + '</div>' +
      '<div class="col" style="height:' + h + '%;transition-delay:' + i * 40 + 'ms"></div>' +
      '<div class="m">' + (+x.slice(5, 7)) + '月</div></div>';
  }).join('');
  growLater('.tbar .col', wrap);
  wrap.querySelectorAll('.tbar').forEach(b => b.onclick = () => {
    if (b.dataset.m !== state.m) { vib(8); setMonth(b.dataset.m); }
  });
}

// ---------- ボトムシート ----------
let sheetOpen = false;
function openSheet(t, d) {
  const its = d.itemsByTx[t.i] || [];
  const g = txGenre(t, d);
  const inc = t.k === '収入';
  const dt = new Date(t.d + 'T00:00:00');
  const single = its.length === 1 && its[0].n === t.n && its[0].p === t.a;
  let html = '<div class="sh-title">' + esc(t.n) + '</div>' +
    '<div class="sh-amt' + (inc ? ' inc' : '') + '">' + (inc ? '+' : '') + yen(t.a) + '</div>' +
    '<div class="chips">' +
    '<span class="chip">📅 ' + dt.getFullYear() + '/' + (dt.getMonth() + 1) + '/' + dt.getDate() +
    '(' + WD[dt.getDay()] + ')</span>' +
    (t.p ? '<span class="chip">' + payIcon(t.p) + ' ' + esc(t.p) + '</span>' : '') +
    (t.st ? '<span class="chip">🏪 ' + esc(t.st) + '</span>' : '') +
    (t.s ? '<span class="chip">📥 ' + esc(t.s) + '</span>' : '') +
    '<span class="chip g" style="background:' + gMeta(g)[0] + '55">' + gMeta(g)[1] + ' ' + esc(g) + '</span>' +
    '</div>';
  if (its.length && !single) {
    html += '<div class="sh-items">' + its.map(it =>
      '<div class="sh-item"><span class="nm">' + esc(it.n) + '</span>' +
      (it.q > 1 ? '<span class="q">×' + it.q + '</span>' : '') +
      '<span class="pr">' + yen(it.p) + '</span></div>').join('') +
      '<div class="sh-item total"><span class="nm">合計</span><span class="pr">' + yen(t.a) + '</span></div>' +
      '</div>';
  }
  html += '<div class="sh-actions">' +
    '<button class="sh-btn pri" id="sh-notion">Notionで開く</button>' +
    ((t.s === 'レシート' || t.s === 'スクショ') ?
      '<button class="sh-btn sec" id="sh-img">レシート画像</button>' : '') +
    '</div>';
  $('sheet-body').innerHTML = html;
  $('sh-notion').onclick = () => {
    vib(8);
    window.open('https://www.notion.so/' + t.i.replace(/-/g, ''), '_blank');
  };
  const imgBtn = $('sh-img');
  if (imgBtn) imgBtn.onclick = async () => {
    vib(8);
    imgBtn.disabled = true; imgBtn.textContent = '取得中…';
    try {
      const r = await api('ft=receipt&id=' + t.i, 30000);
      if (r.images && r.images.length) {
        imgBtn.textContent = 'レシート画像';
        window.open(r.images[0], '_blank');
      } else imgBtn.textContent = '画像なし';
    } catch (e) { imgBtn.textContent = '取得失敗'; }
    finally { imgBtn.disabled = false; }
  };
  $('sheet-back').classList.add('on');
  $('sheet').classList.add('on');
  $('sheet-body').scrollTop = 0;
  sheetOpen = true;
  history.pushState({ sheet: 1 }, '');
}
function closeSheet(fromPop) {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('sheet').classList.remove('on');
  $('sheet').style.transform = '';
  $('sheet-back').classList.remove('on');
  if (!fromPop && history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => { if (sheetOpen) closeSheet(true); });
$('sheet-back').addEventListener('click', () => closeSheet());
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// シートの下スワイプで閉じる(タッチ追従)
(() => {
  const sheet = $('sheet');
  let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', e => {
    if ($('sheet-body').scrollTop > 0) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) {
      sheet.classList.add('drag');
      sheet.style.transform = 'translateY(' + dy + 'px)';
      e.cancelable && e.preventDefault();
    }
  }, { passive: false });
  sheet.addEventListener('touchend', () => {
    sheet.classList.remove('drag');
    if (dy > 110) closeSheet();
    else sheet.style.transform = '';
    y0 = null; dy = 0;
  });
})();

// ---------- ナビゲーション ----------
function navTo(view) {
  if (state.view === view) return;
  const dir = VIEW_ORDER.indexOf(view) > VIEW_ORDER.indexOf(state.view) ? 'in-r' : 'in-l';
  state.view = view;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  document.querySelectorAll('.view').forEach(s => {
    s.classList.remove('active', 'in-l', 'in-r');
  });
  const el = $('view-' + view);
  el.classList.add('active');
  if (!RM) { void el.offsetWidth; el.classList.add(dir); }
  $('pager').classList.toggle('show', view !== 'home');
  $('main').scrollTop = 0;
  rerenderView(view);
  if (view !== 'home') loadMonth(state.m);
}
document.querySelectorAll('.nav-btn').forEach(b =>
  b.addEventListener('click', () => { vib(8); navTo(b.dataset.v); }));

// ---------- 月ページャ ----------
function pgLabel(m) { return (+m.slice(0, 4)) + '年' + (+m.slice(5, 7)) + '月'; }
function setMonth(m, dirHint) {
  if (m > curM || m < minMonth()) return;
  const dir = dirHint || (m > state.m ? 'up' : 'down');
  const old = state.m;
  state.m = m;
  const clip = document.querySelector('.pg-clip');
  const lbl = $('pg-label');
  if (!RM && old !== m) {
    const ghost = lbl.cloneNode(true);
    ghost.classList.add('abs', dir === 'up' ? 'pg-out-up' : 'pg-out-down');
    ghost.removeAttribute('id');
    clip.appendChild(ghost);
    setTimeout(() => ghost.remove(), 260);
    lbl.textContent = pgLabel(m);
    lbl.classList.remove('pg-in-up', 'pg-in-down');
    void lbl.offsetWidth;
    lbl.classList.add(dir === 'up' ? 'pg-in-up' : 'pg-in-down');
  } else lbl.textContent = pgLabel(m);
  $('pg-prev').disabled = m <= minMonth();
  $('pg-next').disabled = m >= curM;
  loadMonth(m);
  rerenderView(state.view);
}
$('pg-prev').addEventListener('click', () => { vib(8); setMonth(prevM(state.m), 'down'); });
$('pg-next').addEventListener('click', () => { vib(8); setMonth(nextM(state.m), 'up'); });

// ---------- プルリフレッシュ ----------
(() => {
  const main = $('main'), ptr = $('ptr');
  let y0 = null, pull = 0, busy = false;
  main.addEventListener('touchstart', e => {
    if (busy || sheetOpen || main.scrollTop > 0) { y0 = null; return; }
    y0 = e.touches[0].clientY; pull = 0;
  }, { passive: true });
  main.addEventListener('touchmove', e => {
    if (y0 == null || busy) return;
    pull = e.touches[0].clientY - y0;
    if (pull > 6 && main.scrollTop <= 0) {
      const p = Math.min(pull * 0.42, 86);
      ptr.classList.remove('settle');
      ptr.style.opacity = Math.min(p / 46, 1);
      ptr.style.transform = 'translateY(' + (p - 56) + 'px) rotate(' + pull * 1.4 + 'deg)';
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  main.addEventListener('touchend', async () => {
    if (y0 == null || busy) return;
    const fired = pull * 0.42 >= 62;
    y0 = null;
    ptr.classList.add('settle');
    if (!fired) { ptr.style.opacity = 0; ptr.style.transform = ''; return; }
    busy = true;
    ptr.classList.add('spin');
    ptr.style.transform = 'translateY(14px)';
    vib(12);
    try {
      await Promise.all([loadOverview(true), loadMonth(state.view === 'home' ? curM : state.m, true)]);
    } finally {
      ptr.classList.remove('spin');
      ptr.style.opacity = 0; ptr.style.transform = '';
      busy = false;
    }
  });
})();

// ---------- 再描画 ----------
function rerenderView(view) {
  if (view === 'home') renderHome();
  else if (view === 'tx') renderTx();
  else renderAn();
}
function rerender() { rerenderView(state.view); }

// ---------- 起動 ----------
(function init() {
  if (!GAS_URL) { $('setup').classList.add('on'); return; }
  $('pg-label').textContent = pgLabel(state.m);
  $('pg-next').disabled = true;
  rerender();
  loadOverview();
  loadMonth(curM);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
