// src/send.html, src/recv.html → web/qr-send.html, web/qr-recv.html
// 송신은 스크립트·CSS를 압축해서 최대한 가볍게, 수신은 jsQR을 파일 안에 넣어 오프라인으로 동작하게 만든다.
const fs = require('fs'), path = require('path'), { minify } = require('terser');
const here = f => path.join(__dirname, f), web = f => path.join(__dirname, '..', 'web', f);

// jsQR 1.4.0은 버전 23 QR의 정렬 패턴 좌표가 틀려 있어(74 → 78) 고쳐서 넣는다
function patchedJsQR() {
  const src = fs.readFileSync(require.resolve('jsqr/dist/jsQR.js'), 'utf8');
  const bad = 'alignmentPatternCenters: [6, 30, 54, 74, 102]';
  if (!src.includes(bad)) throw new Error('jsQR v23 패치 위치를 찾지 못했습니다');
  return src.replace(bad, 'alignmentPatternCenters: [6, 30, 54, 78, 102]');
}

(async () => {
  let s = fs.readFileSync(here('send.html'), 'utf8');
  const js = s.match(/<script>([\s\S]*?)<\/script>/)[1];
  const mj = (await minify(js, { ecma: 2020, toplevel: true, compress: { passes: 3 }, mangle: true })).code;
  s = s.replace(js, () => mj)
       .replace(/<style>([\s\S]*?)<\/style>/, (_, c) => '<style>' + c.replace(/\s*\n\s*/g, '').replace(/;}/g, '}') + '</style>')
       .replace(/>\s*\n\s*</g, '><');
  fs.writeFileSync(web('qr-send.html'), s);

  const q = (await minify(patchedJsQR(), { ecma: 2015, compress: true, mangle: true, format: { comments: false } })).code;
  if (/<\/script/i.test(q)) throw new Error('jsQR 안에 </script 문자열이 있습니다');
  const r = fs.readFileSync(here('recv.html'), 'utf8')
    .replace('/*JSQR*/', () => '/*! jsQR 1.4.0 (v23 정렬패턴 수정) | Apache-2.0 | github.com/cozmo/jsQR */\n' + q);
  fs.writeFileSync(web('qr-recv.html'), r);

  console.log('web/qr-send.html', Buffer.byteLength(s), 'B');
  console.log('web/qr-recv.html', Buffer.byteLength(r), 'B');
})().catch(e => { console.error(e); process.exit(1); });
