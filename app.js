// GAS WebアプリURLはリポジトリに含めない(Publicリポジトリのため)。
// 初回に「https://<pages>/?gas=<WebアプリURL>」を開くと localStorage に保存され、以後は不要。
const GAS_URL = (() => {
  const fromQuery = new URLSearchParams(location.search).get('gas');
  if (fromQuery) {
    localStorage.setItem('kakeibo_gas_url', fromQuery);
    history.replaceState(null, '', location.pathname); // URLバーから消す
  }
  return localStorage.getItem('kakeibo_gas_url') || '';
})();

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const shutter = document.getElementById('shutter');
const statusEl = document.getElementById('status');

let stream = null;

function showStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

async function startCamera() {
  const constraintsList = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 } } },
    { video: { facingMode: 'environment', width: { ideal: 1920 } } },
    { video: true },
  ];
  let lastErr = null;
  for (const c of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!stream) {
    showStatus('カメラを起動できません: ' + lastErr, 'err');
    return;
  }
  video.srcObject = stream;

  // ライト自動点灯(対応端末のみ。非対応は静かにスキップ)
  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
    }
  } catch (e) { /* torch非対応・拒否は無視 */ }
}

async function captureAndSend() {
  if (!GAS_URL) {
    showStatus('未設定: ?gas=<WebアプリURL> 付きで一度開いてください', 'err');
    return;
  }
  if (!stream) return;
  shutter.disabled = true;
  showStatus('送信中…');

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  canvas.toBlob(async (blob) => {
    try {
      const base64 = await blobToBase64(blob);
      // Content-Typeをtext/plainにするとCORSプリフライトが発生せずGASで受けられる
      const res = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ image: base64, mime: 'image/jpeg', filename: 'receipt' }),
      });
      const json = await res.json();
      if (json.ok) {
        showStatus(json.needsReview ? '登録済(要確認扱い)。閉じてOK' : '登録完了。閉じてOK', 'ok');
      } else {
        showStatus('登録失敗: ' + (json.error || '不明'), 'err');
      }
    } catch (e) {
      showStatus('送信失敗: ' + e, 'err');
    } finally {
      shutter.disabled = false;
    }
  }, 'image/jpeg', 0.85);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

shutter.addEventListener('click', captureAndSend);
startCamera();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
