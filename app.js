// GAS WebアプリURLはリポジトリに含めない。初回のみ ?gas=<URL> で開くと localStorage に保存される。
const GAS_URL = (() => {
  const fromQuery = new URLSearchParams(location.search).get('gas');
  if (fromQuery) {
    localStorage.setItem('kakeibo_gas_url', fromQuery);
    history.replaceState(null, '', location.pathname);
  }
  return localStorage.getItem('kakeibo_gas_url') || '';
})();

const MAX_EDGE = 1800;   // レシートの文字が読める範囲でアップロードを軽く(速度・トークン節約)
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

// ---------- 中断復帰用の永続キュー(IndexedDB) ----------
// アプリ強制終了・カメラ起動中のプロセスkill・別アプリ移動でページが破棄されても、
// 選択済みの画像はここに残り、次回起動時に自動で続きから処理する。
// ※起動直後のinitから参照されるため、initより前に定義しておくこと
const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((ok, ng) => {
      const rq = indexedDB.open('kakeibo-queue', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('q', { keyPath: 'id' });
      rq.onsuccess = () => { this._db = rq.result; ok(this._db); };
      rq.onerror = () => ng(rq.error);
    });
  },
  async put(rec) {
    const db = await this.open();
    return new Promise((ok, ng) => {
      const tx = db.transaction('q', 'readwrite');
      tx.objectStore('q').put(rec);
      tx.oncomplete = ok; tx.onerror = () => ng(tx.error);
    });
  },
  async del(id) {
    const db = await this.open();
    return new Promise(ok => {
      const tx = db.transaction('q', 'readwrite');
      tx.objectStore('q').delete(id);
      tx.oncomplete = ok; tx.onerror = ok;
    });
  },
  async all() {
    const db = await this.open();
    return new Promise(ok => {
      const rq = db.transaction('q').objectStore('q').getAll();
      rq.onsuccess = () => ok(rq.result || []);
      rq.onerror = () => ok([]);
    });
  },
};

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
  // 前回中断した読み込みが残っていれば自動で再開(カメラ起動中のプロセスkill・強制終了対策)
  let resumed = false;
  try {
    const pend = await idb.all();
    if (pend.length) {
      resumed = true;
      startBatch(pend.map(r => ({ file: r.blob, fname: r.name, qid: r.id })), false);
    }
  } catch (e) { }

  // 自動でカメラを開く(ブラウザがユーザー操作を要求する場合はタップ待ち)
  if (!resumed) $('file').click();

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
  // 撮影直後に永続化(カメラ復帰時にページが破棄されても写真を失わない)
  if (singleQid) idb.del(singleQid).catch(() => { });
  singleQid = 's' + Date.now();
  try { await idb.put({ id: singleQid, name: file.name || 'photo.jpg', blob: file }); } catch (e) { }
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
let batchItems = []; // 1ファイル=1エントリ {file, fname, qid, rot, receipt, imageUrl, status, error, rowEl, phase}
let batchCtx = null; // 編集画面が一括のどの行から開かれたか(通常撮影ならnull)
let singleQid = null; // 通常撮影の永続キューID

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

$('files').addEventListener('change', () => {
  const files = [...($('files').files || [])];
  $('files').value = '';
  if (!files.length) return;
  startBatch(files.map((f, i) => ({ file: f, fname: f.name, qid: 'b' + Date.now() + '-' + i })), true);
});

/** 429(無料枠レート制限)の応答か */
function isQuota_(o) {
  const s = String((o && (o.detail || o.error)) || o || '');
  return s.indexOf('429') !== -1 || s.indexOf('無料枠') !== -1;
}

let quotaPauseUntil = 0; // 無料枠429を踏んだら全ワーカーがここまで待つ

async function startBatch(list, enqueue) {
  show('batch');
  $('batch-list').innerHTML = '';
  $('batch-done').hidden = true;
  batchItems = list.map(x => ({
    file: x.file, fname: x.fname || (x.file && x.file.name) || '画像', qid: x.qid,
    rot: 0, receipt: null, imageUrl: null, status: 'wait', error: null, rowEl: null,
  }));
  if (enqueue) {
    for (const it of batchItems) {
      try { await idb.put({ id: it.qid, name: it.fname, blob: it.file }); } catch (e) { }
    }
  }
  // 2並列で壁時間を半減(枠制限は quotaPauseUntil で全体停止するので安全)
  quotaPauseUntil = 0;
  let next = 0, done = 0;
  const stat = () => {
    $('batch-stat').textContent = done + ' / ' + batchItems.length + ' 完了' +
      (done < batchItems.length ? ' — 処理中…' : '');
  };
  stat();
  const worker = async () => {
    while (next < batchItems.length) {
      const i = next++;
      await processEntry_(batchItems[i]);
      done++;
      stat();
      if (navigator.vibrate) navigator.vibrate(15);
    }
  };
  await Promise.all([worker(), worker()]);
  finishBatch();
  if (navigator.vibrate) navigator.vibrate(80);
}

async function processEntry_(it) {
  makeRow(it, it.fname, null, 'working');
  const cell = it.rowEl.querySelector('.a'); // 金額セルにフェーズ+経過秒を表示
  const t0 = Date.now();
  let phaseTxt = '';
  const phase = txt => { phaseTxt = txt; cell.textContent = txt; };
  const tick = setInterval(() => {
    if (phaseTxt) cell.textContent = phaseTxt + ' ' + Math.round((Date.now() - t0) / 1000) + '秒';
  }, 1000);
  try {
    for (let attempt = 0; ; attempt++) {
      while (Date.now() < quotaPauseUntil) {
        phase('枠回復待ち ' + Math.ceil((quotaPauseUntil - Date.now()) / 1000) + '秒');
        await new Promise(r => setTimeout(r, 1000));
      }
      phase('圧縮中');
      const { base64 } = await resizeToJpeg(it.file, MAX_EDGE, it.rot);
      phase('AI読取+登録中');
      // auto: OCR→Notion登録までGAS側で一気に行う(往復1回分速い)
      const res = await postJson_({ mode: 'auto', image: base64, mime: 'image/jpeg' }, 90000);
      if (!res.ok && res.geminiFailed && isQuota_(res) && attempt === 0) {
        quotaPauseUntil = Date.now() + 60000; // 全ワーカー一時停止→同じ画像を再試行
        continue;
      }
      phaseTxt = '';
      if (res.ok && res.result) {
        it.receipt = res.receipt || null;
        it.imageUrl = res.imageUrl || null;
        it.status = res.result;
        makeRow(it, (res.receipt && res.receipt.store) || it.fname, res.receipt && res.receipt.total, it.status);
        idb.del(it.qid).catch(() => { });
      } else if (res.geminiFailed) {
        // AI読取失敗: ページは作られていない。行タップで手動入力
        it.imageUrl = res.imageUrl || null;
        it.status = 'review';
        it.error = res.error || null;
        const note = (res.error && res.error !== 'AI読取失敗') ? ' — ' + res.error : ' — タップで手動入力';
        makeRow(it, it.fname + note, null, 'review');
      } else {
        throw new Error(res.error || '不明なエラー');
      }
      break;
    }
  } catch (e) {
    phaseTxt = '';
    it.status = 'error';
    it.error = e.name === 'AbortError' ? '応答なし' : String(e);
    makeRow(it, it.fname + ' — タップで再試行', null, 'error');
  }
  clearInterval(tick);
}

/** 失敗=最初からやり直してから編集画面 / 要確認=AI再挑戦はせず空フォームで手動入力 */
async function editBatchRow(entry) {
  if (entry.status === 'error') {
    show('busy');
    $('retry').hidden = true; $('reshoot').hidden = true; $('backbatch').hidden = true;
    try {
      setBusy('画像を圧縮中…');
      const { base64, previewUrl } = await resizeToJpeg(entry.file, MAX_EDGE, entry.rot);
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

$('batch-done').addEventListener('click', () => {
  // 完了=残った要確認/失敗も含め意図的に閉じた扱い。永続キューを掃除(元画像はギャラリーにある)
  batchItems.forEach(it => { if (it.qid) idb.del(it.qid).catch(() => { }); });
  show('idle');
});
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
      makeRow(entry, receipt.store || entry.fname, receipt.total, entry.status);
      if (entry.qid) idb.del(entry.qid).catch(() => { });
    } catch (e) {
      entry.status = 'error';
      entry.error = String(e);
      makeRow(entry, entry.fname + ' — 登録失敗・タップで再試行', null, 'error');
    } finally {
      $('ok').disabled = false;
      document.body.style.background = '#111';
      finishBatch();
      show('batch');
      if (navigator.vibrate) navigator.vibrate(40);
    }
    return;
  }

  if (singleQid) { idb.del(singleQid).catch(() => { }); singleQid = null; }
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
  if (singleQid) { idb.del(singleQid).catch(() => { }); singleQid = null; } // 破棄=意図的な取消
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
  $('rimg-tools').hidden = !batchCtx; // 回転・再読取・書き起こしは元ファイルを持つ一括経由のみ
  $('ocr-text').hidden = true;
  if (url) { $('rimg').src = url; rz.reset(); }
}

// ---------- 編集画面ツール: 回転 / この向きでAI再読取 / 文字の書き起こし ----------
function showOcrText_(text) {
  const el = $('ocr-text');
  el.hidden = false;
  el.textContent = text;
}

$('rot-r').addEventListener('click', async () => {
  if (!batchCtx) return;
  batchCtx.rot = ((batchCtx.rot || 0) + 1) % 4;
  try {
    const { previewUrl } = await resizeToJpeg(batchCtx.file, 1600, batchCtx.rot);
    setEditImage(previewUrl);
  } catch (e) { }
});

$('reocr').addEventListener('click', async () => {
  if (!batchCtx) return;
  const btn = $('reocr');
  btn.disabled = true; btn.textContent = 'AI読取中…';
  try {
    const { base64 } = await resizeToJpeg(batchCtx.file, MAX_EDGE, batchCtx.rot);
    const ocr = await postJson_({ image: base64, mime: 'image/jpeg', skipFallback: true }, TIMEOUT_MS);
    if (ocr.ok && ocr.receipt) {
      batchCtx.receipt = fixPayment(ocr.receipt);
      batchCtx.imageUrl = ocr.imageUrl || batchCtx.imageUrl;
      renderEdit(batchCtx.receipt);
      showOcrText_('✓ 読み取れました。内容を確認してOKを押してください');
    } else {
      showOcrText_((ocr && ocr.error) || 'AI読取失敗');
    }
  } catch (e) {
    showOcrText_('読取失敗: ' + (e.name === 'AbortError' ? '応答なし' : e));
  }
  btn.disabled = false; btn.textContent = 'この向きでAI再読取';
});

$('transcribe').addEventListener('click', async () => {
  if (!batchCtx) return;
  const btn = $('transcribe');
  btn.disabled = true; btn.textContent = '書き起こし中…';
  try {
    const { base64 } = await resizeToJpeg(batchCtx.file, MAX_EDGE, batchCtx.rot);
    const r = await postJson_({ mode: 'transcribe', image: base64, mime: 'image/jpeg' }, TIMEOUT_MS);
    showOcrText_(r.ok
      ? ((r.lines || []).join('\n') || '(文字が見つかりませんでした)')
      : (r.error || '書き起こしに失敗しました'));
  } catch (e) {
    showOcrText_('書き起こし失敗: ' + (e.name === 'AbortError' ? '応答なし' : e));
  }
  btn.disabled = false; btn.textContent = '文字を書き起こす';
});

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

// ---------- 画像リサイズ(EXIF向き自動適用+90度単位の手動回転) ----------
async function resizeToJpeg(file, maxEdge, quarterTurns) {
  // imageOrientation:'from-image' でEXIFの回転情報を反映(横向き写真の自動補正)
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const img = bitmap || await loadImage(file);
  const w = img.width, h = img.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const sw = Math.round(w * scale), sh = Math.round(h * scale);
  const rot = ((quarterTurns || 0) % 4 + 4) % 4;
  const canvas = document.createElement('canvas');
  canvas.width = rot % 2 ? sh : sw;
  canvas.height = rot % 2 ? sw : sh;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rot * Math.PI / 2);
  ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
  const blob = await new Promise((ok, ng) =>
    canvas.toBlob(b => b ? ok(b) : ng(new Error('JPEG変換失敗')), 'image/jpeg', 0.82));
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
