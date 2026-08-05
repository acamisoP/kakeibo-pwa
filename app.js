// GAS WebアプリURLはリポジトリに含めない。初回のみ ?gas=<URL> で開くと localStorage に保存される。
const GAS_URL = (() => {
  const fromQuery = new URLSearchParams(location.search).get('gas');
  if (fromQuery) {
    localStorage.setItem('kakeibo_gas_url', fromQuery);
    history.replaceState(null, '', location.pathname);
  }
  return localStorage.getItem('kakeibo_gas_url') || '';
})();

const MAX_EDGE = 2560;
const TIMEOUT_MS = 60000;
const GENRES = ['食費', '嗜好品', 'タバコ', '外食費', '防衛費', '車両費', '交通費', '旅費', '日用品', '医療・健康', 'サブスク(固定費)', '仕事(経費)', 'その他', '給与', '副収入'];
const PAYMENTS = ['楽天ペイ', 'Sonyデビット', 'PayPay', 'd払い', 'dポイント', 'PayPal', '現金', 'その他'];
const STORE_TYPES = ['スーパー', 'コンビニ', 'EC', '実店舗その他'];

const $ = id => document.getElementById(id);
const screens = { idle: $('scr-idle'), busy: $('scr-busy'), edit: $('scr-edit'), batch: $('scr-batch') };
let ocrResult = null;   // {receipt, imageUrl}
let lastPayload = null; // 再送信用
let timerId = null;

function show(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function setBusy(text, cls) {
  $('busy-status').textContent = text;
  $('busy-status').className = cls || '';
}

function startTimer(prefix) {
  const t0 = Date.now();
  stopTimer();
  timerId = setInterval(() =>
    setBusy(prefix + '\n' + Math.round((Date.now() - t0) / 1000) + '秒経過'), 1000);
}
function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

// ---------- 起動: 今月サマリー取得(接続チェック兼用) + 即カメラ ----------
(async function init() {
  if (!GAS_URL) {
    $('summary-amount').textContent = '未設定';
    $('summary-sub').textContent = '?gas=<WebアプリURL> 付きリンクで一度開いてください';
    $('conn').className = 'err';
    return;
  }
  // 自動でカメラを開く(ブラウザがユーザー操作を要求する場合はタップ待ち)
  $('file').click();

  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 15000);
    const r = await fetch(GAS_URL + '?summary=1', { method: 'GET', signal: c.signal, redirect: 'follow' });
    const j = await r.json();
    if (j.ok) {
      $('summary-amount').textContent = '¥' + Number(j.total || 0).toLocaleString('ja-JP');
      $('summary-sub').textContent = j.month + '月 / ' + j.count + '件の取引' +
        (j.gemini != null ? ' ・ AI読取 今日' + j.gemini + '回' : '');
      $('conn').textContent = '✓ サーバー接続OK';
      $('conn').className = 'ok';
    } else throw new Error(j.error || 'unexpected');
  } catch (e) {
    $('summary-amount').textContent = '—';
    $('summary-sub').textContent = 'サマリー取得失敗';
    $('conn').textContent = '✗ サーバーに届きません(' + (e.name === 'AbortError' ? '15秒無応答' : e) + ')。BraveはシールドOFF、またはChromeで';
    $('conn').className = 'err';
  }
})();

// カード単位のハンドラ(フォルダカードと競合するため全画面タップは廃止)
$('capture-card').addEventListener('click', () => { if (GAS_URL) $('file').click(); });
$('folder-card').addEventListener('click', () => { if (GAS_URL) $('files').click(); });
$('reshoot').addEventListener('click', () => $('file').click());
$('retry').addEventListener('click', () => { if (lastPayload) sendOcr(lastPayload); });

// ---------- 撮影 → リサイズ → OCR ----------
$('file').addEventListener('change', async () => {
  const file = $('file').files && $('file').files[0];
  $('file').value = '';
  if (!file) return;
  show('busy');
  $('retry').hidden = true; $('reshoot').hidden = true; $('backbatch').hidden = true;
  try {
    setBusy('画像を圧縮中…');
    const { base64, previewUrl } = await resizeToJpeg(file, MAX_EDGE);
    $('thumb').src = previewUrl;
    lastPayload = JSON.stringify({ image: base64, mime: 'image/jpeg' });
    await sendOcr(lastPayload);
  } catch (e) {
    setBusy('画像処理に失敗: ' + e, 'err');
    $('reshoot').hidden = false;
  }
});

// ---------- フォルダ一括読み込み(全自動登録: OCR→即commit、編集画面なし) ----------
async function postJson_(bodyObj, timeoutMs) {
  const c = new AbortController();
  const to = setTimeout(() => c.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(bodyObj), signal: c.signal, redirect: 'follow',
    });
    return await res.json();
  } finally { clearTimeout(to); }
}

const BATCH_BADGE = {
  created: '新規', merged: 'マージ', duplicate: '重複スキップ',
  review: '要確認', error: '失敗', working: '処理中',
};
let batchItems = []; // 1ファイル=1エントリ {file, receipt, imageUrl, status, error, rowEl, phase}
let batchCtx = null; // 編集画面が一括のどの行から開かれたか(通常撮影ならnull)

const fixPayment = r => Object.assign({}, r, r.payment === '不明' ? { payment: 'その他' } : null);
function blankReceipt() {
  return {
    store: '', date: new Date().toISOString().slice(0, 10), total: 0,
    payment: 'その他', store_type: '実店舗その他', kind: '支出', items: [],
  };
}

/** 結果行を作成/更新する。失敗・要確認はタップで編集へ */
function makeRow(entry, name, amount, kind) {
  if (!entry.rowEl) {
    entry.rowEl = document.createElement('div');
    entry.rowEl.className = 'b-row';
    entry.rowEl.innerHTML = '<div class="n"></div><div class="a"></div><span class="badge"></span>';
    $('batch-list').appendChild(entry.rowEl);
    entry.rowEl.addEventListener('click', () => {
      if (entry.status === 'error' || entry.status === 'review') editBatchRow(entry);
    });
  }
  entry.rowEl.querySelector('.n').textContent = name;
  entry.rowEl.querySelector('.a').textContent =
    amount != null ? '¥' + Number(amount).toLocaleString('ja-JP') : '';
  const b = entry.rowEl.querySelector('.badge');
  b.className = 'badge ' + kind;
  b.textContent = BATCH_BADGE[kind] || kind;
  entry.rowEl.classList.toggle('editable', kind === 'error' || kind === 'review');
}

function finishBatch() {
  const counts = { created: 0, merged: 0, duplicate: 0, review: 0, error: 0 };
  batchItems.forEach(it => { if (counts[it.status] != null) counts[it.status]++; });
  const remain = counts.review + counts.error;
  $('batch-stat').textContent = batchItems.length + '件完了 — 新規' + counts.created +
    ' / マージ' + counts.merged + ' / 重複' + counts.duplicate +
    (counts.review ? ' / 要確認' + counts.review : '') +
    (counts.error ? ' / 失敗' + counts.error : '') +
    (remain ? ' (行タップで修正)' : '');
  $('batch-done').hidden = false;
}

$('files').addEventListener('change', async () => {
  const files = [...($('files').files || [])];
  $('files').value = '';
  if (!files.length) return;

  show('batch');
  $('batch-list').innerHTML = '';
  $('batch-done').hidden = true;
  batchItems = files.map(f => ({ file: f, receipt: null, imageUrl: null, status: 'wait', rowEl: null, phase: null }));

  for (let i = 0; i < batchItems.length; i++) {
    const it = batchItems[i];
    makeRow(it, it.file.name, null, 'working');
    const t0 = Date.now();
    const phase = txt => {
      it.phase = txt;
      $('batch-stat').textContent = (i + 1) + ' / ' + batchItems.length + ' ' + txt;
    };
    // 何が起きているか見えるように、フェーズ+経過秒を1秒毎に更新
    const tick = setInterval(() => {
      if (it.phase) $('batch-stat').textContent =
        (i + 1) + ' / ' + batchItems.length + ' ' + it.phase + ' ' + Math.round((Date.now() - t0) / 1000) + '秒';
    }, 1000);
    try {
      phase('画像を圧縮中…');
      const { base64 } = await resizeToJpeg(it.file, MAX_EDGE);
      phase('AI読取中…');
      const ocr = await postJson_({ image: base64, mime: 'image/jpeg', skipFallback: true }, TIMEOUT_MS);
      if (ocr.ok && ocr.receipt) {
        it.receipt = fixPayment(ocr.receipt);
        it.imageUrl = ocr.imageUrl || null;
        phase('Notionへ登録中…');
        const commit = await postJson_({ mode: 'commit', receipt: it.receipt, imageUrl: it.imageUrl }, TIMEOUT_MS);
        if (!commit.ok) throw new Error(commit.error || 'commit失敗');
        it.status = commit.result || 'created';
        makeRow(it, it.receipt.store || it.file.name, it.receipt.total, it.status);
      } else if (ocr.geminiFailed || (ocr.ok && ocr.needsReview)) {
        // AI読取失敗: ページは作られていない(skipFallback)。行タップで手動入力
        it.imageUrl = ocr.imageUrl || null;
        it.status = 'review';
        makeRow(it, it.file.name + ' — タップで手動入力', null, 'review');
      } else {
        throw new Error(ocr.error || '不明なエラー');
      }
    } catch (e) {
      it.status = 'error';
      it.error = e.name === 'AbortError' ? '応答なし' : String(e);
      makeRow(it, it.file.name + ' — タップで再試行', null, 'error');
    }
    clearInterval(tick);
    it.phase = null;
    if (navigator.vibrate) navigator.vibrate(15);
  }
  finishBatch();
  if (navigator.vibrate) navigator.vibrate(80);
});

/** 失敗=最初からやり直してから編集画面 / 要確認=AI再挑戦はせず空フォームで手動入力 */
async function editBatchRow(entry) {
  if (entry.status === 'error') {
    show('busy');
    $('retry').hidden = true; $('reshoot').hidden = true; $('backbatch').hidden = true;
    try {
      setBusy('画像を圧縮中…');
      const { base64, previewUrl } = await resizeToJpeg(entry.file, MAX_EDGE);
      $('thumb').src = previewUrl;
      startTimer('AI読取中…(10〜20秒)');
      const ocr = await postJson_({ image: base64, mime: 'image/jpeg', skipFallback: true }, TIMEOUT_MS);
      stopTimer();
      if (ocr.ok && ocr.receipt) {
        entry.receipt = fixPayment(ocr.receipt);
        entry.imageUrl = ocr.imageUrl || null;
      } else if (ocr.geminiFailed) {
        entry.imageUrl = ocr.imageUrl || entry.imageUrl;
        entry.receipt = null; // AIが読めない画像 → 手動入力へ
      } else {
        throw new Error(ocr.error || '不明なエラー');
      }
    } catch (e) {
      stopTimer();
      setBusy('✗ 再試行も失敗\n' + (e.name === 'AbortError' ? '60秒応答なし。電波を確認してください' : String(e)), 'err');
      $('backbatch').hidden = false;
      return;
    }
  }
  if (!entry.receipt) entry.receipt = blankReceipt();
  batchCtx = entry;
  ocrResult = { receipt: entry.receipt, imageUrl: entry.imageUrl };
  renderEdit(entry.receipt);
  setEditImage(URL.createObjectURL(entry.file)); // 元画像を見ながら入力できるように
  show('edit');
}

$('batch-done').addEventListener('click', () => { show('idle'); });
$('backbatch').addEventListener('click', () => { show('batch'); });

async function sendOcr(payload) {
  show('busy');
  $('retry').hidden = true; $('reshoot').hidden = true; $('backbatch').hidden = true;
  startTimer('AI読取中…(10〜20秒)');
  const c = new AbortController();
  const to = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload, signal: c.signal, redirect: 'follow',
    });
    const json = await res.json();
    stopTimer();
    if (json.ok && json.receipt) {
      ocrResult = json;
      renderEdit(json.receipt);
      setEditImage($('thumb').src || null); // 撮影プレビューを編集画面でも表示
      show('edit');
      if (navigator.vibrate) navigator.vibrate(50);
    } else if (json.ok && json.needsReview) {
      setBusy('! AI読取失敗。画像だけNotionに登録済み\n(【要確認】ページを後で修正してください)');
      $('reshoot').hidden = false;
    } else {
      throw new Error(json.error || '不明なエラー');
    }
  } catch (e) {
    stopTimer();
    setBusy('✗ 送信失敗\n' + (e.name === 'AbortError'
      ? '60秒応答なし。電波の良い場所で再送信してください'
      : String(e)), 'err');
    $('retry').hidden = false;
    $('reshoot').hidden = false;
  } finally { clearTimeout(to); }
}

// ---------- 編集画面 ----------
/** ブランドカラー背景+ロゴ(faviconベストエフォート)。不明時は素通し */
function applyBrand(r) {
  const brand = $('brand');
  const logo = $('brand-logo');
  const name = $('brand-name');
  const color = /^#[0-9a-fA-F]{6}$/.test(r.brand_color || '') ? r.brand_color : null;

  document.body.style.background = color
    ? `linear-gradient(180deg, ${color}55 0%, #111 45%)`
    : '#111';

  if (color || r.brand_domain) {
    brand.style.display = 'flex';
    name.textContent = r.store || '';
    if (r.brand_domain) {
      logo.style.display = '';
      logo.onerror = () => { logo.style.display = 'none'; };
      logo.src = 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(r.brand_domain);
    } else {
      logo.style.display = 'none';
    }
  } else {
    brand.style.display = 'none';
  }
}

function fillSelect(sel, options, value) {
  sel.innerHTML = '';
  options.forEach(o => {
    const el = document.createElement('option');
    el.textContent = o;
    if (o === value) el.selected = true;
    sel.appendChild(el);
  });
}

function renderEdit(r) {
  applyBrand(r);
  $('f-store').value = r.store || '';
  $('f-date').value = r.date || new Date().toISOString().slice(0, 10);
  $('f-total').value = r.total || 0;
  fillSelect($('f-payment'), PAYMENTS, r.payment === '不明' ? 'その他' : r.payment);
  fillSelect($('f-storetype'), STORE_TYPES, r.store_type);
  $('f-kind').value = r.kind || '支出';

  const wrap = $('items');
  wrap.innerHTML = '';
  (r.items || []).forEach(it => wrap.appendChild(makeItemRow(it)));
}

function makeItemRow(it) {
  const div = document.createElement('div');
  div.className = 'item';
  const name = document.createElement('input');
  name.value = it.normalized_name || it.raw_name || '';
  name.dataset.raw = it.raw_name || '';
  const r2 = document.createElement('div');
  r2.className = 'r2';
  const price = document.createElement('input');
  price.type = 'number'; price.inputMode = 'numeric'; price.value = it.price || 0;
  const genre = document.createElement('select');
  fillSelect(genre, GENRES, it.genre);
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '✕';
  del.onclick = () => div.remove();
  r2.append(price, genre, del);
  div.append(name, r2);
  div.dataset.qty = it.quantity || 1;
  return div;
}

// 手動入力用(AI読取失敗時は明細ゼロから始まるため)
$('add-item').addEventListener('click', () => {
  const row = makeItemRow({ raw_name: '', normalized_name: '', price: 0, quantity: 1, genre: 'その他' });
  $('items').appendChild(row);
  row.querySelector('input').focus();
});

function collectReceipt() {
  const items = [...$('items').children].map(div => {
    const [name] = div.getElementsByTagName('input');
    const price = div.querySelector('input[type=number]');
    const genre = div.querySelector('select');
    return {
      raw_name: name.dataset.raw || name.value,
      normalized_name: name.value,
      price: Number(price.value) || 0,
      quantity: Number(div.dataset.qty) || 1,
      genre: genre.value,
    };
  });
  return {
    kind: $('f-kind').value,
    store: $('f-store').value || '不明',
    store_type: $('f-storetype').value,
    date: $('f-date').value,
    total: Number($('f-total').value) || 0,
    payment: $('f-payment').value,
    items: items,
  };
}

// OK: 通常撮影=sendBeaconで送信して即クローズ / 一括の修正=応答を待って結果一覧を更新
$('ok').addEventListener('click', async () => {
  const receipt = collectReceipt();
  const imageUrl = (batchCtx ? batchCtx.imageUrl : (ocrResult && ocrResult.imageUrl)) || null;

  if (batchCtx) {
    const entry = batchCtx;
    batchCtx = null;
    $('ok').disabled = true;
    try {
      const commit = await postJson_({ mode: 'commit', receipt, imageUrl }, TIMEOUT_MS);
      if (!commit.ok) throw new Error(commit.error || 'commit失敗');
      entry.receipt = receipt;
      entry.status = commit.result || 'created';
      makeRow(entry, receipt.store || entry.file.name, receipt.total, entry.status);
    } catch (e) {
      entry.status = 'error';
      entry.error = String(e);
      makeRow(entry, entry.file.name + ' — 登録失敗・タップで再試行', null, 'error');
    } finally {
      $('ok').disabled = false;
      document.body.style.background = '#111';
      finishBatch();
      show('batch');
      if (navigator.vibrate) navigator.vibrate(40);
    }
    return;
  }

  const body = JSON.stringify({ mode: 'commit', receipt, imageUrl });
  const sent = navigator.sendBeacon(GAS_URL, new Blob([body], { type: 'text/plain;charset=utf-8' }));
  if (!sent) { // beacon不可なら通常fetch(待たずに閉じる)
    fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, keepalive: true }).catch(() => {});
  }
  if (navigator.vibrate) navigator.vibrate(80);
  window.close(); // ホーム画面から起動したPWAなら閉じられる。タブの場合は完了表示へ
  setTimeout(() => {
    document.body.style.background = '#111';
    show('idle');
    $('conn').textContent = '✓ 登録を送信しました(閉じてOK)';
    $('conn').className = 'ok';
  }, 300);
});

$('cancel').addEventListener('click', () => {
  ocrResult = null;
  document.body.style.background = '#111';
  if (batchCtx) { batchCtx = null; show('batch'); return; }
  show('idle');
});

// ---------- 編集画面のレシート画像(ピンチ拡大・パン・ダブルタップ) ----------
let rimgUrl = null;
function setEditImage(url) {
  if (rimgUrl && rimgUrl !== url && rimgUrl.indexOf('blob:') === 0) {
    try { URL.revokeObjectURL(rimgUrl); } catch (e) { }
  }
  rimgUrl = url || null;
  $('rimg-sec').hidden = !url;
  if (url) { $('rimg').src = url; rz.reset(); }
}

const rz = (() => {
  const img = $('rimg');
  const wrap = $('rimg-wrap');
  let s = 1, tx = 0, ty = 0;          // scale / 平行移動(px)
  const ptrs = new Map();             // pointerId -> {x, y}
  let pinch = null;                   // {d0, m0:{x,y}, s0, tx0, ty0}
  let pan = null;                     // {x, y, tx0, ty0}
  let lastTap = 0;

  const apply = () => {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
  };
  const clamp = () => {
    s = Math.min(Math.max(s, 1), 6);
    const w = wrap.clientWidth, h = img.offsetHeight;
    tx = Math.min(0, Math.max(tx, w - w * s));
    ty = Math.min(0, Math.max(ty, h - h * s));
    if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
  };
  const local = e => {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  wrap.addEventListener('pointerdown', e => {
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { }
    ptrs.set(e.pointerId, local(e));
    const pts = [...ptrs.values()];
    if (pts.length === 2) {
      pinch = {
        d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        m0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        s0: s, tx0: tx, ty0: ty,
      };
      pan = null;
    } else if (pts.length === 1) {
      pan = { x: pts[0].x, y: pts[0].y, tx0: tx, ty0: ty, moved: false };
    }
  });
  wrap.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, local(e));
    const pts = [...ptrs.values()];
    if (pinch && pts.length === 2) {
      const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const m1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      s = pinch.s0 * d1 / pinch.d0;
      // ピンチ中点の直下にある画像上の点を固定する
      tx = m1.x - (pinch.m0.x - pinch.tx0) / pinch.s0 * s;
      ty = m1.y - (pinch.m0.y - pinch.ty0) / pinch.s0 * s;
      clamp(); apply();
    } else if (pan && pts.length === 1 && s > 1) {
      const dx = pts[0].x - pan.x, dy = pts[0].y - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
      tx = pan.tx0 + dx; ty = pan.ty0 + dy;
      clamp(); apply();
    }
  });
  const up = e => {
    if (!ptrs.has(e.pointerId)) return;
    const wasPinch = !!pinch;
    const tapCandidate = pan && !pan.moved && !wasPinch;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (ptrs.size === 0) {
      if (tapCandidate) {
        const now = Date.now();
        if (now - lastTap < 320) { // ダブルタップ: 2.5倍 ↔ 等倍
          const p = local(e);
          if (s > 1) { s = 1; tx = 0; ty = 0; }
          else { const z = 2.5; tx = p.x - p.x * z; ty = p.y - p.y * z; s = z; }
          clamp(); apply();
          lastTap = 0;
        } else lastTap = now;
      }
      pan = null;
    }
  };
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);

  return { reset() { s = 1; tx = 0; ty = 0; ptrs.clear(); pinch = null; pan = null; apply(); } };
})();

// ---------- 画像リサイズ ----------
async function resizeToJpeg(file, maxEdge) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  const img = bitmap || await loadImage(file);
  const w = img.width, h = img.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((ok, ng) =>
    canvas.toBlob(b => b ? ok(b) : ng(new Error('JPEG変換失敗')), 'image/jpeg', 0.85));
  const base64 = await new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = ng;
    r.readAsDataURL(blob);
  });
  return { base64, previewUrl: URL.createObjectURL(blob) };
}

function loadImage(file) {
  return new Promise((ok, ng) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = ng;
    img.src = URL.createObjectURL(file);
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
