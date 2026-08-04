// GAS WebアプリURLはリポジトリに含めない(Publicリポジトリのため)。
// 初回に「https://<pages>/?gas=<WebアプリURL>」を開くと localStorage に保存され、以後は不要。
const GAS_URL = (() => {
  const fromQuery = new URLSearchParams(location.search).get('gas');
  if (fromQuery) {
    localStorage.setItem('kakeibo_gas_url', fromQuery);
    history.replaceState(null, '', location.pathname);
  }
  return localStorage.getItem('kakeibo_gas_url') || '';
})();

const MAX_EDGE = 2560;       // 送信画像の長辺(OCRに十分・通信量を抑える)
const TIMEOUT_MS = 90000;    // これを超えたら明示的にエラー表示する

const fileInput = document.getElementById('file');
const shootBtn = document.getElementById('shoot');
const retryBtn = document.getElementById('retry');
const statusEl = document.getElementById('status');
const thumbEl = document.getElementById('thumb');

let lastPayload = null;  // 再送信用
let timerId = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function startElapsedTimer(prefix) {
  const t0 = Date.now();
  stopElapsedTimer();
  timerId = setInterval(() => {
    setStatus(prefix + '\n' + Math.round((Date.now() - t0) / 1000) + '秒経過');
  }, 1000);
}

function stopElapsedTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

shootBtn.addEventListener('click', () => {
  if (!GAS_URL) {
    setStatus('未設定: ?gas=<WebアプリURL> 付きのリンクで一度開いてください', 'err');
    return;
  }
  fileInput.click(); // 標準カメラアプリが開く(フォーカス・ライト・ズーム自由)
});

retryBtn.addEventListener('click', () => {
  if (lastPayload) send(lastPayload);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = ''; // 同じ写真の再選択でもchangeが発火するように
  if (!file) return;

  try {
    setStatus('画像を処理中…');
    const { base64, previewUrl } = await resizeToJpeg(file, MAX_EDGE);
    thumbEl.src = previewUrl;
    thumbEl.style.display = 'block';
    lastPayload = JSON.stringify({ image: base64, mime: 'image/jpeg', filename: 'receipt' });
    await send(lastPayload);
  } catch (e) {
    setStatus('画像処理に失敗: ' + e, 'err');
  }
});

async function send(payload) {
  retryBtn.hidden = true;
  shootBtn.hidden = true;
  startElapsedTimer('送信中…(AI読取に10〜30秒かかります)');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // CORSプリフライト回避
      body: payload,
      signal: controller.signal,
      redirect: 'follow',
    });
    const json = await res.json();
    stopElapsedTimer();

    if (json.ok && !json.needsReview) {
      const detail = (json.store ? json.store : '') + (json.total ? ' ¥' + json.total : '') +
        (json.items != null ? '\n明細 ' + json.items + '件' : '');
      setStatus('✅ 登録完了\n' + detail + '\n閉じてOK', 'ok');
      if (navigator.vibrate) navigator.vibrate(80);
    } else if (json.ok && json.needsReview) {
      setStatus('⚠️ 読取に失敗したため画像のみ登録しました\nNotionの【要確認】を後で修正してください', 'ok');
    } else {
      throw new Error(json.error || '不明なエラー');
    }
    shootBtn.textContent = '📷 次のレシートを撮影';
    shootBtn.hidden = false;
  } catch (e) {
    stopElapsedTimer();
    const msg = (e.name === 'AbortError')
      ? '90秒応答がありません。電波の良い場所で「再送信」を押してください'
      : String(e) + '\n(Braveの場合はシールドをOFFにするか、Chromeをお試しください)';
    setStatus('❌ 送信失敗\n' + msg, 'err');
    retryBtn.hidden = false;
    shootBtn.textContent = '📷 撮り直す';
    shootBtn.hidden = false;
  } finally {
    clearTimeout(timeout);
  }
}

/** 長辺maxEdgeにリサイズしてJPEG base64を返す(EXIF回転はブラウザが補正) */
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
