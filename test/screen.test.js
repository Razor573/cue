const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

// screen.js requires electron at load time; stub it the way llm.test.js stubs
// the openai SDK so the encoder can be exercised without a display.
const originalModuleLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') return { desktopCapturer: {}, screen: {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { encodeScreenshot, isBlackFrame, MAX_LONG_EDGE_PX, JPEG_QUALITY, MAX_DATA_URL_BYTES, BLACK_CHANNEL_MAX, BLACK_FRACTION_MIN } = require('../src/screen');
Module._load = originalModuleLoad;

// A stand-in for Electron's NativeImage. The JPEG size is modelled as a fixed
// number of bytes per pixel so that the *only* thing that can bring a large
// capture under the cap is the resize step this test is guarding.
const FAKE_JPEG_BYTES_PER_PIXEL = 0.5;
function fakeImage(width, height, log = []) {
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    resize(opts) {
      log.push({ resize: opts });
      const aspect = width / height;
      const w = opts.width != null ? opts.width : Math.round(opts.height * aspect);
      const h = opts.height != null ? opts.height : Math.round(opts.width / aspect);
      return fakeImage(w, h, log);
    },
    toJPEG(quality) {
      log.push({ toJPEG: quality });
      return Buffer.alloc(Math.round(width * height * FAKE_JPEG_BYTES_PER_PIXEL), 1);
    }
  };
}

test('a 4K capture is resized to the 1568 px long edge and encoded as JPEG q70 under 3 MB', () => {
  const log = [];
  const url = encodeScreenshot(fakeImage(3840, 2160, log));

  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(log[0], { resize: { width: MAX_LONG_EDGE_PX } });
  assert.deepEqual(log[1], { toJPEG: JPEG_QUALITY });
  assert.ok(Buffer.byteLength(url) < MAX_DATA_URL_BYTES, `data URL is ${Buffer.byteLength(url)} bytes`);
  assert.equal(MAX_LONG_EDGE_PX, 1568);
  assert.equal(JPEG_QUALITY, 70);
});

test('the unresized 4K capture would NOT fit — proves the resize is load-bearing', () => {
  const raw = fakeImage(3840, 2160);
  const url = `data:image/jpeg;base64,${raw.toJPEG(70).toString('base64')}`;
  assert.ok(Buffer.byteLength(url) > MAX_DATA_URL_BYTES);
});

test('a portrait capture is resized by its height', () => {
  const log = [];
  encodeScreenshot(fakeImage(1200, 2600, log));
  assert.deepEqual(log[0], { resize: { height: MAX_LONG_EDGE_PX } });
});

test('a small capture is never upscaled', () => {
  const log = [];
  encodeScreenshot(fakeImage(1280, 800, log));
  assert.deepEqual(log, [{ toJPEG: JPEG_QUALITY }]);
});

// ── Black-frame detection ──────────────────────────────────────────────────
// A stand-in for Electron's NativeImage with real pixel bytes. isBlackFrame
// only uses the max of the first three bytes, so BGRA and RGBA both work.
function fakeBitmapImage(width, height, pixel) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      buf[off] = b; buf[off + 1] = g; buf[off + 2] = r; buf[off + 3] = 255;
    }
  }
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    toBitmap: () => buf,
  };
}

test('black-frame thresholds are what the detector documents', () => {
  assert.equal(BLACK_CHANNEL_MAX, 16);
  assert.equal(BLACK_FRACTION_MIN, 0.995);
});

test('an all-black frame is black', () => {
  assert.equal(isBlackFrame(fakeBitmapImage(64, 64, () => [0, 0, 0])), true);
});

test('an all-white frame is not black', () => {
  assert.equal(isBlackFrame(fakeBitmapImage(64, 64, () => [255, 255, 255])), false);
});

test('dark gray above the channel threshold is not black', () => {
  assert.equal(isBlackFrame(fakeBitmapImage(64, 64, () => [30, 30, 30])), false);
});

// 40x40 = 1600 pixels, under the 2048 sample cap, so every pixel is sampled
// and the fractions below are exact, not sampling artefacts.
test('a frame with 1% bright pixels is not black (below the 99.5% bar)', () => {
  let n = 0;
  const img = fakeBitmapImage(40, 40, () => (n++ < 16 ? [255, 255, 255] : [0, 0, 0]));
  assert.equal(isBlackFrame(img), false);
});

test('a frame with 0.375% bright pixels is black (above the 99.5% bar)', () => {
  let n = 0;
  const img = fakeBitmapImage(40, 40, () => (n++ < 6 ? [255, 255, 255] : [0, 0, 0]));
  assert.equal(isBlackFrame(img), true);
});

test('an image without pixel access fails open (not black)', () => {
  assert.equal(isBlackFrame({ getSize: () => ({ width: 64, height: 64 }), isEmpty: () => false }), false);
  assert.equal(isBlackFrame(null), false);
});
