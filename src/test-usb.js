// 실제 수신 페이지를 실행하고 Android USB bridge/카메라 이벤트를 재현한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = [...fs.readFileSync(path.join(__dirname, 'recv.html'), 'utf8')
  .matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
const device = { id: 'usb:/dev/bus/usb/001/002', label: 'USB Video (USB 캡쳐보드/카메라)' };

async function setup({ bridge = true, mediaError = false, getUserMedia } = {}) {
  const calls = [], images = [], elements = new Map(), storage = new Map();
  let devices = [device];
  class Element {
    constructor() {
      this.options = []; this.selectedIndex = -1; this.style = {}; this.textContent = '';
      const classes = new Set();
      this.classList = { add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x),
        toggle: (x, on) => on ? classes.add(x) : classes.delete(x) };
    }
    set innerHTML(value) { this.options = []; this.selectedIndex = -1; }
    get value() { return this.options[this.selectedIndex]?.value || ''; }
    set value(value) { this.selectedIndex = this.options.findIndex(o => o.value === value); }
    add(option) { this.options.push(option); if (this.selectedIndex < 0) this.selectedIndex = 0; }
    getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }; }
    addEventListener() {}
    querySelector() { return { style: {} }; }
    play() { return Promise.resolve(); }
    requestVideoFrameCallback() {}
  }
  const track = { stop: () => calls.push(['trackStop']), getSettings: () => ({ deviceId: 'phone', facingMode: 'environment' }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const context = {
    console, TextEncoder, TextDecoder, Uint8ClampedArray, performance, setTimeout,
    setInterval() {}, addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    Image: class { constructor() { images.push(this); } },
    document: { createElement: () => new Element(), getElementById: id => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    } },
    navigator: { mediaDevices: { enumerateDevices: async () => {
      if (mediaError) throw new Error('WebView does not expose cameras');
      return [{ kind: 'videoinput', deviceId: 'phone', label: '후면 카메라' }];
    }, getUserMedia: async constraints => {
      calls.push(['media', constraints]);
      return getUserMedia ? getUserMedia() : stream;
    }, addEventListener() {} } },
    jsQR: () => null
  };
  if (bridge) context.AndroidBridge = {
    listUsbCameras: () => JSON.stringify(devices),
    startUsbCamera: (...args) => calls.push(['start', ...args]),
    stopUsbCamera: () => calls.push(['stop']),
    usbFrameDone: (...args) => calls.push(['ack', ...args])
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  await tick();
  return { context, calls, images, elements, stream, setDevices: value => { devices = value; },
    run: script => vm.runInContext(script, context),
    start: async id => { context.selectedInput = id; await vm.runInContext('startCam(selectedInput)', context); } };
}

test('USB 목록은 WebView 카메라 열거/권한 없이도 표시된다', async () => {
  const app = await setup({ mediaError: true });
  assert.equal(app.elements.get('camSel').hidden, false);
  assert.ok(app.elements.get('camSel').options.some(o => o.value === device.id));
  assert.equal(app.calls.filter(c => c[0] === 'media').length, 0);
  await app.start(device.id);
  assert.equal(app.calls.at(-1)[0], 'start');
  assert.equal(app.calls.at(-1)[1], device.id);
});

test('권한 거부 후 재시도하며 이전 요청의 콜백을 무시한다', async () => {
  const app = await setup();
  await app.start(device.id);
  const old = app.calls.at(-1)[2];
  app.context.onUsbError(old, 'USB 접근 거부');
  assert.equal(app.elements.get('note').textContent, 'USB 접근 거부');
  assert.equal(app.elements.get('camBtn').textContent, '카메라 켜기');
  await app.start(device.id);
  const current = app.calls.at(-1)[2];
  app.context.onUsbStarted(old, 640, 480);
  assert.equal(app.elements.get('cam').classList.contains('on'), false);
  app.context.onUsbStarted(current, 1280, 720);
  assert.equal(app.elements.get('cam').classList.contains('usb'), true);
});

test('분리 시 닫고 다시 꽂은 장치를 재연결할 수 있다', async () => {
  const app = await setup();
  await app.start(device.id);
  app.context.onUsbStarted(app.calls.at(-1)[2], 1280, 720);
  app.setDevices([]);
  await app.context.onUsbDevicesChanged();
  assert.match(app.elements.get('note').textContent, /분리/);
  assert.equal(app.elements.get('cam').classList.contains('on'), false);
  const reattached = { ...device, id: 'usb:/dev/bus/usb/001/003' };
  app.setDevices([reattached]);
  await app.context.onUsbDevicesChanged();
  await app.start(reattached.id);
  assert.equal(app.calls.at(-1)[1], reattached.id);
});

test('백그라운드/취소 후 늦게 온 USB 영상은 재생하지 않는다', async () => {
  const app = await setup();
  await app.start(device.id);
  const session = app.calls.at(-1)[2];
  app.context.appPause();
  app.context.onUsbStarted(session, 1280, 720);
  assert.equal(app.context.onUsbFrame(session, 'frame', 1280, 720), false);
  assert.equal(app.elements.get('cam').classList.contains('on'), false);
});

test('프레임 인식 완료까지 추가 프레임을 받지 않고 완료를 통지한다', async () => {
  const app = await setup();
  await app.start(device.id);
  const session = app.calls.at(-1)[2];
  let complete;
  app.context.detector = { detect: () => new Promise(resolve => { complete = resolve; }) };
  app.run('det = detector');
  assert.equal(app.context.onUsbFrame(session, 'frame', 1280, 720), true);
  const processing = app.images.at(-1).onload();
  assert.equal(app.context.onUsbFrame(session, 'next', 1280, 720), false);
  assert.equal(app.calls.some(c => c[0] === 'ack'), false);
  complete([]);
  await processing;
  assert.deepEqual(app.calls.at(-1), ['ack', session]);
  assert.equal(app.context.onUsbFrame(session, 'next', 1280, 720), true);
  app.images.at(-1).onerror();
  assert.deepEqual(app.calls.at(-1), ['ack', session]);
});

test('늦게 열린 휴대폰 카메라가 USB 입력을 덮어쓰지 않는다', async () => {
  let resolve;
  const app = await setup({ getUserMedia: () => new Promise(done => { resolve = done; }) });
  const openingPhone = app.start('phone');
  await tick();
  await app.start(device.id);
  const session = app.calls.at(-1)[2];
  resolve(app.stream);
  await openingPhone;
  assert.ok(app.calls.some(c => c[0] === 'trackStop'));
  app.context.onUsbStarted(session, 1280, 720);
  assert.equal(app.elements.get('cam').classList.contains('usb'), true);
});

test('일반 브라우저의 카메라 입력도 유지된다', async () => {
  const app = await setup({ bridge: false });
  await app.start('phone');
  assert.ok(app.calls.some(c => c[0] === 'media'));
  assert.equal(app.elements.get('cam').classList.contains('on'), true);
  app.context.appPause();
  assert.ok(app.calls.some(c => c[0] === 'trackStop'));
});
