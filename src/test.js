// 송신기의 QR 인코더를 버전 1~40 전부 만들어 보고 jsQR(패치본)로 다시 읽어서 확인한다.
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'send.html'), 'utf8');
const core = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('// ── UI ──')[0];
const { qr, cap, b45, A } = new Function(core + ';return{qr,cap,b45,A}')();

const src = fs.readFileSync(require.resolve('jsqr/dist/jsQR.js'), 'utf8')
  .replace('alignmentPatternCenters: [6, 30, 54, 74, 102]', 'alignmentPatternCenters: [6, 30, 54, 78, 102]');
const m = { exports: {} }; new Function('module', 'exports', src)(m, m.exports);
const jsQR = m.exports.default || m.exports;

function render([M, n], k = 4) {
  const w = (n + 8) * k, d = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y * n + x])
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) { const p = ((y + 4) * k + a) * w + (x + 4) * k + b; d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 0; }
  return { d, w };
}
let ok = 0, fail = 0;
for (let v = 1; v <= 40; v++) for (const L of [cap(v), (cap(v) >> 1) + 1]) {
  let s = ''; for (let i = 0; i < L; i++) s += A[Math.random() * 45 | 0];
  const { d, w } = render(qr(s, v)), r = jsQR(d, w, w);
  if (r && r.data === s && r.version === v) ok++; else { fail++; console.log('실패: 버전', v, '길이', L); }
}
const t = x => b45(new TextEncoder().encode(x));
const rfc = t('AB') === 'BB8' && t('Hello!!') === '%69 VD92EX0' && t('base-45') === 'UJCLQE7W581';
console.log('QR 버전 1~40:', ok, '성공,', fail, '실패 / Base45 RFC 9285:', rfc ? '통과' : '실패');
process.exit(fail || !rfc ? 1 : 0);
