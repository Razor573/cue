const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const Module = require('node:module');

// screen.js requires electron at load time; stub it the way llm.test.js stubs
// the openai SDK so the encoder can be exercised without a display.
const originalModuleLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') return { desktopCapturer: {}, screen: {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  encodeScreenshot,
  resizeAndEncode,
  captureScreen,
  captureScreenWithFallback,
  acquireScreenshotForTurn,
  waitForPendingCapture,
  createPendingScreenshots,
  isBlackFrame,
  isLikelyBlackBitmap,
  SCREENSHOT_PROFILES,
  resolveScreenshotProfile,
  hashPreparedJpeg,
  getScreenshotCacheStats,
  clearScreenshotCache,
  getLastPreparedScreenshot,
  selectWinningScreenshot,
  isReplacedChatStream,
  isStaleDesktopChatEvent,
  createChatStreamGuard,
  MAX_LONG_EDGE_PX,
  MAX_DIMENSION,
  JPEG_QUALITY,
  MAX_DATA_URL_BYTES,
  BLACK_CHANNEL_MAX,
  BLACK_FRACTION_MIN,
} = require('../src/screen');
Module._load = originalModuleLoad;

// A stand-in for Electron's NativeImage. The JPEG size is modelled as a fixed
// number of bytes per pixel so that the *only* thing that can bring a large
// capture under the cap is the resize step this test is guarding.
const FAKE_JPEG_BYTES_PER_PIXEL = 0.5;
function fakeImage(width, height, log = [], fillByte = 1) {
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    resize(opts) {
      log.push({ resize: opts });
      const aspect = width / height;
      const w = opts.width != null ? opts.width : Math.round(opts.height * aspect);
      const h = opts.height != null ? opts.height : Math.round(opts.width / aspect);
      return fakeImage(w, h, log, fillByte);
    },
    toJPEG(quality) {
      log.push({ toJPEG: quality });
      return Buffer.alloc(Math.round(width * height * FAKE_JPEG_BYTES_PER_PIXEL), fillByte);
    },
  };
}

test('a 4K capture is resized to the 1568 px long edge and encoded as JPEG q70 under 3 MB', () => {
  clearScreenshotCache();
  const log = [];
  const url = encodeScreenshot(fakeImage(3840, 2160, log));

  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(log[0], { resize: { width: MAX_LONG_EDGE_PX } });
  assert.deepEqual(log[1], { toJPEG: JPEG_QUALITY });
  assert.ok(Buffer.byteLength(url) < MAX_DATA_URL_BYTES, `data URL is ${Buffer.byteLength(url)} bytes`);
  assert.equal(MAX_LONG_EDGE_PX, 1568);
  assert.equal(MAX_DIMENSION, 1568);
  assert.equal(JPEG_QUALITY, 70);
});

test('the unresized 4K capture would NOT fit — proves the resize is load-bearing', () => {
  const raw = fakeImage(3840, 2160);
  const url = `data:image/jpeg;base64,${raw.toJPEG(70).toString('base64')}`;
  assert.ok(Buffer.byteLength(url) > MAX_DATA_URL_BYTES);
});

test('a portrait capture is resized by its height', () => {
  clearScreenshotCache();
  const log = [];
  encodeScreenshot(fakeImage(1200, 2600, log));
  assert.deepEqual(log[0], { resize: { height: MAX_LONG_EDGE_PX } });
});

test('a small capture is never upscaled', () => {
  clearScreenshotCache();
  const log = [];
  encodeScreenshot(fakeImage(1280, 800, log));
  assert.deepEqual(log, [{ toJPEG: JPEG_QUALITY }]);
});

// ── Two Image Profiles (Never Upscale) ──────────────────────────────────────

test('SCREENSHOT_PROFILES defines default (1568px / q70) and technical (1920px / q85)', () => {
  assert.deepEqual(SCREENSHOT_PROFILES.default, { maxEdge: 1568, quality: 70 });
  assert.deepEqual(SCREENSHOT_PROFILES.technical, { maxEdge: 1920, quality: 85 });
});

test('resolveScreenshotProfile maps leetcode, coding, solve-code, and technical to technical profile', () => {
  assert.equal(resolveScreenshotProfile('technical'), 'technical');
  assert.equal(resolveScreenshotProfile('leetcode'), 'technical');
  assert.equal(resolveScreenshotProfile('coding'), 'technical');
  assert.equal(resolveScreenshotProfile('solve-code'), 'technical');
  assert.equal(resolveScreenshotProfile({ profile: 'technical' }), 'technical');
  assert.equal(resolveScreenshotProfile({ mode: 'leetcode' }), 'technical');
  assert.equal(resolveScreenshotProfile({ mode: 'coding' }), 'technical');
  assert.equal(resolveScreenshotProfile({ feature: 'solve-code' }), 'technical');
  assert.equal(resolveScreenshotProfile('default'), 'default');
  assert.equal(resolveScreenshotProfile('behavioral'), 'default');
  assert.equal(resolveScreenshotProfile({ mode: 'general' }), 'default');
  assert.equal(resolveScreenshotProfile(null), 'default');
  assert.equal(resolveScreenshotProfile(undefined), 'default');
});

test('technical profile downscales 4K to 1920px at JPEG quality 85 and never upscales 1920x1080 or smaller', () => {
  clearScreenshotCache();
  const log4k = [];
  const res4k = resizeAndEncode(fakeImage(3840, 2160, log4k, 2), { mode: 'leetcode' });
  assert.equal(res4k.profile, 'technical');
  assert.equal(res4k.width, 1920);
  assert.equal(res4k.height, 1080);
  assert.deepEqual(log4k[0], { resize: { width: 1920 } });
  assert.deepEqual(log4k[1], { toJPEG: 85 });

  // 1920x1080 screen on technical profile: neither edge > 1920, so no resize occurs
  const log1080p = [];
  const res1080p = resizeAndEncode(fakeImage(1920, 1080, log1080p, 3), { mode: 'coding' });
  assert.equal(res1080p.profile, 'technical');
  assert.equal(res1080p.width, 1920);
  assert.equal(res1080p.height, 1080);
  assert.deepEqual(log1080p, [{ toJPEG: 85 }]);

  // Smaller 1366x768 screen on technical profile: never upscaled
  const logSmall = [];
  const resSmall = resizeAndEncode(fakeImage(1366, 768, logSmall, 4), 'technical');
  assert.equal(resSmall.width, 1366);
  assert.equal(resSmall.height, 768);
  assert.deepEqual(logSmall, [{ toJPEG: 85 }]);
});

// ── Black-frame detection & Companion Fallback ─────────────────────────────
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
  assert.equal(isLikelyBlackBitmap, isBlackFrame);
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

test('captureScreenWithFallback checks black frame on raw pixels BEFORE JPEG encoding and uses companion fallback', async () => {
  clearScreenshotCache();
  let jpegCalledOnBlack = false;
  const blackImg = {
    ...fakeBitmapImage(64, 64, () => [0, 0, 0]),
    toJPEG() {
      jpegCalledOnBlack = true;
      return Buffer.from('should-not-encode');
    },
  };
  const companionImg = fakeImage(1280, 720, [], 42);
  let companionCalled = 0;
  const companion = {
    captureScreenshot: async () => {
      companionCalled++;
      return companionImg;
    },
  };

  const result = await captureScreenWithFallback(companion, {
    profile: 'default',
    captureImage: async () => blackImg,
  });

  assert.equal(jpegCalledOnBlack, false, 'black frame must be rejected before JPEG encoding');
  assert.equal(companionCalled, 1);
  assert.ok(result);
  assert.equal(result.fallback, true);
  assert.equal(result.source, 'companion');
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
});

// ── SHA-256 Cache & New-Screenshot-Wins Rule ────────────────────────────────

test('SHA-256 cache reuses the exact prepared screenshot across hotkey, typed chat, and quick-action turns when screen is unchanged', async () => {
  clearScreenshotCache();
  const screenBytesFill = 17;
  const makeUnchangedScreen = () => fakeImage(1920, 1080, [], screenBytesFill);

  // 1. Hotkey turn captures screen
  const hotkeyShot = await acquireScreenshotForTurn({
    profile: 'default',
    captureImage: async () => makeUnchangedScreen(),
  });
  const expectedJpeg = fakeImage(1568, 882, [], screenBytesFill).toJPEG(70);
  const expectedHash = crypto.createHash('sha256').update(expectedJpeg).digest('hex');
  assert.equal(hotkeyShot.hash, expectedHash);
  assert.equal(hashPreparedJpeg(expectedJpeg), expectedHash);

  // 2. Typed chat turn with unchanged screen
  const typedChatShot = await acquireScreenshotForTurn({
    profile: 'default',
    captureImage: async () => makeUnchangedScreen(),
  });

  // 3. Quick-action turn with unchanged screen
  const quickActionShot = await acquireScreenshotForTurn({
    profile: 'default',
    captureImage: async () => makeUnchangedScreen(),
  });

  assert.equal(hotkeyShot, typedChatShot, 'typed chat reuses the exact cached object');
  assert.equal(typedChatShot, quickActionShot, 'quick action reuses the exact cached object');

  const stats = getScreenshotCacheStats();
  assert.equal(stats.size, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 2);
});

test('new-screenshot-wins: when the screen changes, the new screenshot has a different sha256 hash and wins over the old cached one', async () => {
  clearScreenshotCache();

  const oldShot = await acquireScreenshotForTurn({
    mode: 'leetcode',
    captureImage: async () => fakeImage(1920, 1080, [], 10),
  });
  assert.equal(oldShot.profile, 'technical');
  assert.equal(getLastPreparedScreenshot('technical'), oldShot);

  // Screen changes (different pixel/JPEG content -> different sha256)
  const newShot = await acquireScreenshotForTurn({
    mode: 'leetcode',
    previousScreenshot: oldShot,
    captureImage: async () => fakeImage(1920, 1080, [], 99),
  });

  assert.notEqual(newShot.hash, oldShot.hash);
  assert.notEqual(newShot, oldShot);
  assert.equal(getLastPreparedScreenshot('technical'), newShot, 'latest prepared entry for profile is updated to the new screenshot');
  assert.equal(selectWinningScreenshot(oldShot, newShot), newShot, 'new screenshot wins over old cached screenshot');
  assert.equal(selectWinningScreenshot(oldShot, { ...oldShot }), oldShot, 'unchanged hash preserves cached reference');
});

// ── Pending-Capture Wait (Never-Drop Capture) ───────────────────────────────

test('pending-capture wait: hotkey, typed chat, and quick-action turns wait for an in-flight capture and never drop or send without an image', async () => {
  clearScreenshotCache();
  let releaseCapture;
  const gate = new Promise((r) => { releaseCapture = r; });
  let rawCaptureCount = 0;

  // Start an in-flight capture (e.g. triggered by Ctrl+H / background capture)
  const inFlightPromise = captureScreen({
    mode: 'coding',
    captureImage: async () => {
      rawCaptureCount++;
      await gate;
      return fakeImage(1920, 1080, [], 55);
    },
  });

  // While the capture is still in flight, hotkey, typed chat, and quick-action turns arrive
  const hotkeyWait = waitForPendingCapture('coding');
  const typedChatTurn = acquireScreenshotForTurn({ mode: 'coding' });
  const quickActionTurn = captureScreen({ mode: 'coding' });

  // Release the in-flight capture
  releaseCapture();

  const [initial, fromHotkey, fromTypedChat, fromQuickAction] = await Promise.all([
    inFlightPromise,
    hotkeyWait,
    typedChatTurn,
    quickActionTurn,
  ]);

  assert.ok(initial, 'capture resolved with a prepared screenshot');
  assert.equal(rawCaptureCount, 1, 'coalesced onto the single in-flight capture');
  assert.equal(fromHotkey, initial);
  assert.equal(fromTypedChat, initial);
  assert.equal(fromQuickAction, initial);
  assert.equal(initial.profile, 'technical');
});

test('createPendingScreenshots tracks in-flight captures, claims them during settle, and never rejects on failure', async () => {
  const pending = createPendingScreenshots();
  assert.equal(pending.inFlight(), false);
  assert.deepEqual(await pending.settle(100), []);

  let sawClaimInCaptureContinuation = null;
  const slowShot = new Promise((r) => setTimeout(() => r({ path: '/tmp/shot-1.jpg', hash: 'abc123' }), 25));

  const captureHandler = (async () => {
    const shot = await pending.track(slowShot);
    sawClaimInCaptureContinuation = pending.claimed(shot.path);
  })();

  assert.equal(pending.inFlight(), true);
  const settled = await pending.settle(1000);
  await captureHandler;

  assert.equal(settled.length, 1);
  assert.equal(settled[0].path, '/tmp/shot-1.jpg');
  assert.equal(sawClaimInCaptureContinuation, true, 'claimed before capture continuation runs');
  assert.equal(pending.inFlight(), false);

  // Failed or null captures resolve cleanly to empty
  pending.track(Promise.reject(new Error('capture failed')));
  pending.track(Promise.resolve(null));
  assert.deepEqual(await pending.settle(200), []);
});

// ── Stale-Stream Guard ──────────────────────────────────────────────────────

test('isReplacedChatStream and isStaleDesktopChatEvent detect replaced streams and pre-start events', () => {
  // Object signature
  assert.equal(isReplacedChatStream({ streamId: 1, activeStreamId: 2 }), true);
  assert.equal(isReplacedChatStream({ streamId: 2, activeStreamId: 2 }), false);
  assert.equal(isReplacedChatStream({ streamId: undefined, activeStreamId: 2 }), false);

  // Stale desktop chat event before llm:stream-start arrives
  assert.equal(
    isStaleDesktopChatEvent({ awaitingStreamStart: true, streamId: 1, replacedStreamFloor: 0 }),
    true,
    'events arriving while awaitingStreamStart is true must be dropped',
  );
  // Stale desktop chat event after stream-start when streamId <= replacedStreamFloor
  assert.equal(
    isStaleDesktopChatEvent({ awaitingStreamStart: false, streamId: 3, replacedStreamFloor: 3 }),
    true,
  );
  assert.equal(
    isStaleDesktopChatEvent({ awaitingStreamStart: false, streamId: 2, replacedStreamFloor: 3 }),
    true,
  );
  // Active stream above floor is accepted
  assert.equal(
    isStaleDesktopChatEvent({ awaitingStreamStart: false, streamId: 4, replacedStreamFloor: 3 }),
    false,
  );
});

test('createChatStreamGuard names the new stream before tokens arrive, drops stale events, and lets replaced streams end quietly', () => {
  const guard = createChatStreamGuard();

  // Stream 1 starts
  const s1 = guard.beginStream();
  assert.equal(s1.streamId, 1);
  assert.equal(guard.activeStreamId, 1);
  assert.equal(guard.awaitingStreamStart, true);

  // Stream 1 is named via stream-start before its tokens arrive
  guard.onStreamStart({ streamId: s1.streamId });
  assert.equal(guard.awaitingStreamStart, false);
  assert.equal(guard.shouldDropEvent({ streamId: 1 }), false);
  assert.equal(guard.isReplaced(1), false);

  // User sends Question 2 while Stream 1 is still streaming / thinking
  const s2 = guard.beginStream();
  assert.equal(s2.streamId, 2);
  assert.equal(guard.activeStreamId, 2);
  assert.equal(guard.replacedStreamFloor, 1);
  assert.equal(guard.awaitingStreamStart, true);

  // Stream 1 detects it was replaced so it can end quietly with no legacy re-run
  assert.equal(guard.isReplaced(s1.streamId), true);
  assert.equal(guard.isReplaced(s2.streamId), false);

  // Late token from Stream 1 before Stream 2's stream-start is dropped
  assert.equal(guard.shouldDropEvent({ streamId: 1 }), true);

  // Stream 2 is named via stream-start
  guard.onStreamStart({ streamId: s2.streamId });
  assert.equal(guard.awaitingStreamStart, false);
  assert.equal(guard.replacedStreamFloor, 1);

  // Late token/done/error from Stream 1 (streamId <= replacedStreamFloor) is still dropped
  assert.equal(guard.shouldDropEvent({ streamId: 1 }), true);
  // Stream 2's tokens are accepted
  assert.equal(guard.shouldDropEvent({ streamId: 2 }), false);
});
