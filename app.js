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
const PAYMENTS = ['楽天ペイ', 'Sonyデビット', '現金', 'その他'];
const STORE_TYPES = ['スーパー', 'コンビニ', 'EC', '実店舗その他'];

const $ = id => document.getElementById(id);
const screens = { idle: $('scr-idle'), busy: $('scr-busy'), edit: $('scr-edit') };
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

// ---------- 起動: 接続チェック + 即カメラ ----------
(async function init() {
  if (!GAS_URL) {
    $('conn').textContent = '未設定: ?gas=<WebアプリURL> 付きリンクで一度開いてください';
    $('conn').className = 'err';
    return;
  }
  // 自動でカメラを開く(ブラウザがユーザー操作を要求する場合はタップ待ち)
  $('file').click();

  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 10000);
    const r = await fetch(GAS_URL, { method: 'GET', signal: c.signal, redirect: 'follow' });
    const j = await r.json();
    if (j.ok) { $('conn').textContent = '✓ サーバー接続OK'; $('conn').className = 'ok'; }
    else throw new Error('unexpected');
  } catch (e) {
    $('conn').textContent = '✗ サーバーに届きません(' + (e.name === 'AbortError' ? '10秒無応答' : e) + ')\nBraveはシールドOFF、またはChromeで開いてください';
    $('conn').className = 'err';
  }
})();

// 待機画面のどこをタップしてもカメラ起動
screens.idle.addEventListener('click', () => { if (GAS_URL) $('file').click(); });
$('reshoot').addEventListener('click', () => $('file').click());
$('retry').addEventListener('click', () => { if (lastPayload) sendOcr(lastPayload); });

// ---------- 撮影 → リサイズ → OCR ----------
$('file').addEventListener('change', async () => {
  const file = $('file').files && $('file').files[0];
  $('file').value = '';
  if (!file) return;
  show('busy');
  $('retry').hidden = true; $('reshoot').hidden = true;
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

async function sendOcr(payload) {
  show('busy');
  $('retry').hidden = true; $('reshoot').hidden = true;
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
      show('edit');
      if (navigator.vibrate) navigator.vibrate(50);
    } else if (json.ok && json.needsReview) {
      setBusy('⚠️ AI読取失敗。画像だけNotionに登録済み\n(【要確認】ページを後で修正してください)');
      $('reshoot').hidden = false;
    } else {
      throw new Error(json.error || '不明なエラー');
    }
  } catch (e) {
    stopTimer();
    setBusy('❌ 送信失敗\n' + (e.name === 'AbortError'
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
  (r.items || []).forEach(it => {
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
    wrap.appendChild(div);
  });
}

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

// OK: sendBeaconで登録を送信(ページを閉じても送信が完了する)→ 即クローズ
$('ok').addEventListener('click', () => {
  const body = JSON.stringify({
    mode: 'commit',
    receipt: collectReceipt(),
    imageUrl: ocrResult && ocrResult.imageUrl,
  });
  const sent = navigator.sendBeacon(GAS_URL, new Blob([body], { type: 'text/plain;charset=utf-8' }));
  if (!sent) { // beacon不可なら通常fetch(待たずに閉じる)
    fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, keepalive: true }).catch(() => {});
  }
  if (navigator.vibrate) navigator.vibrate(80);
  window.close(); // ホーム画面から起動したPWAなら閉じられる。タブの場合は完了表示へ
  setTimeout(() => {
    document.body.style.background = '#111';
    show('idle');
    $('conn').textContent = '✅ 登録を送信しました(閉じてOK)';
    $('conn').className = 'ok';
  }, 300);
});

$('cancel').addEventListener('click', () => {
  ocrResult = null;
  document.body.style.background = '#111';
  show('idle');
});

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
