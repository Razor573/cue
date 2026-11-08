// Screenshot via native screencapture on macOS, falling back to desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen, nativeImage } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Vision models downscale anything larger than ~1568 px on the long edge
// anyway, and a gateway sitting on Vercel refuses request bodies over 4.5 MB
// before any route code runs (413, with no body the app can shape). A Retina
// PNG of a busy screen is commonly 5–15 MB, so every screenshot is resized to
// this long edge and encoded as JPEG before it is base64'd into the prompt.
const MAX_LONG_EDGE_PX = 1568;
const MAX_DIMENSION = MAX_LONG_EDGE_PX;
const JPEG_QUALITY = 70;
// What the encoded data URL must stay under so the whole request, prompt and
// all, fits in the gateway's 4 MB request rule with room to spare.
const MAX_DATA_URL_BYTES = 3 * 1024 * 1024;

// Two image profiles (never upscale):
// - default: 1568px max edge, JPEG quality 70 (normal turns)
// - technical: 1920px max edge, JPEG quality 85 (leetcode and coding turns)
const SCREENSHOT_PROFILES = Object.freeze({
  default: Object.freeze({ maxEdge: 1568, quality: 70 }),
  technical: Object.freeze({ maxEdge: 1920, quality: 85 }),
});

const TECHNICAL_PROFILE_HINTS = new Set([
  'technical',
  'leetcode',
  'coding',
  'solve-code',
  'code',
  'code-hint',
  'technical-interview',
]);

/**
 * Resolve a profile name or turn/mode/feature hint to 'technical' or 'default'.
 */
function resolveScreenshotProfile(profileOrHint) {
  if (!profileOrHint) return 'default';
  if (typeof profileOrHint === 'string') {
    const normalized = profileOrHint.trim().toLowerCase();
    return TECHNICAL_PROFILE_HINTS.has(normalized) ? 'technical' : 'default';
  }
  if (typeof profileOrHint === 'object') {
    const candidates = [
      profileOrHint.profile,
      profileOrHint.mode,
      profileOrHint.feature,
      profileOrHint.promptMode,
      profileOrHint.turnMode,
      profileOrHint.action,
      profileOrHint.type,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && TECHNICAL_PROFILE_HINTS.has(c.trim().toLowerCase())) {
        return 'technical';
      }
    }
  }
  return 'default';
}

function resolveEncodingOptions(options = {}) {
  const profile = resolveScreenshotProfile(options);
  const spec = SCREENSHOT_PROFILES[profile] || SCREENSHOT_PROFILES.default;
  if (typeof options === 'string' || !options || typeof options !== 'object') {
    return { profile, maxEdge: spec.maxEdge, quality: spec.quality };
  }
  const explicitEdge = options.maxEdge ?? options.maxLongEdge;
  const maxEdge = typeof explicitEdge === 'number' && Number.isFinite(explicitEdge) && explicitEdge > 0
    ? explicitEdge
    : spec.maxEdge;
  const quality = typeof options.quality === 'number' && Number.isFinite(options.quality) && options.quality > 0
    ? options.quality
    : spec.quality;
  return { profile, maxEdge, quality };
}

// ── SHA-256 Prepared Screenshot Cache ────────────────────────────────────────

const MAX_CACHE_ENTRIES = 32;
const cacheByProfileAndHash = new Map();
const cacheByHash = new Map();
const lastPreparedByProfile = new Map();
let lastPreparedOverall = null;
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Compute SHA-256 hex digest of prepared JPEG bytes.
 */
function hashPreparedJpeg(bufferOrData) {
  if (!bufferOrData) return '';
  let buf = bufferOrData;
  if (typeof bufferOrData === 'string') {
    const raw = bufferOrData.replace(/^data:image\/[^;]+;base64,/i, '');
    buf = Buffer.from(raw, 'base64');
  }
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cachePreparedEntry(entry) {
  const key = `${entry.profile}:${entry.hash}`;
  if (cacheByProfileAndHash.has(key)) {
    const existing = cacheByProfileAndHash.get(key);
    cacheByProfileAndHash.delete(key);
    cacheByProfileAndHash.set(key, existing);
    lastPreparedByProfile.set(entry.profile, existing);
    lastPreparedOverall = existing;
    cacheHits++;
    return existing;
  }
  cacheMisses++;
  cacheByProfileAndHash.set(key, entry);
  cacheByHash.set(entry.hash, entry);
  while (cacheByProfileAndHash.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cacheByProfileAndHash.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cacheByProfileAndHash.get(oldestKey);
    cacheByProfileAndHash.delete(oldestKey);
    if (oldest && cacheByHash.get(oldest.hash) === oldest) {
      cacheByHash.delete(oldest.hash);
    }
  }
  lastPreparedByProfile.set(entry.profile, entry);
  lastPreparedOverall = entry;
  return entry;
}

function getScreenshotCacheStats() {
  return {
    size: cacheByProfileAndHash.size,
    hits: cacheHits,
    misses: cacheMisses,
    entries: [...cacheByProfileAndHash.values()],
    byProfile: {
      default: lastPreparedByProfile.get('default') || null,
      technical: lastPreparedByProfile.get('technical') || null,
    },
  };
}

function getLastPreparedScreenshot(profile) {
  if (profile !== undefined && profile !== null) {
    const resolved = resolveScreenshotProfile(profile);
    return lastPreparedByProfile.get(resolved) || null;
  }
  return lastPreparedOverall
    || lastPreparedByProfile.get('default')
    || lastPreparedByProfile.get('technical')
    || null;
}

/**
 * New-screenshot-wins rule:
 * - When the screen is unchanged (same sha256 hash for that profile), reuse the
 *   existing cached prepared screenshot object reference.
 * - When the screen has changed (different sha256 hash), the new screenshot
 *   always wins over the old cached one.
 */
function selectWinningScreenshot(previous, current) {
  if (!current) return previous || null;
  if (!previous) return current;
  const prevHash = previous.hash || previous.sha256;
  const currHash = current.hash || current.sha256;
  const prevProfile = previous.profile || 'default';
  const currProfile = current.profile || prevProfile;
  if (prevHash && currHash && prevHash === currHash && prevProfile === currProfile) {
    return previous;
  }
  return current;
}

/**
 * Downscale a NativeImage to the profile's long-edge cap (never upscale),
 * encode as JPEG, hash with SHA-256, and cache/reuse the prepared screenshot.
 */
function resizeAndEncode(img, options = {}) {
  const { profile, maxEdge, quality } = resolveEncodingOptions(options);
  const { width, height } = img.getSize();
  let out = img;
  if (width > maxEdge || height > maxEdge) {
    out = width >= height ? img.resize({ width: maxEdge }) : img.resize({ height: maxEdge });
  }
  const finalSize = typeof out.getSize === 'function' ? out.getSize() : { width, height };
  const jpegBuffer = out.toJPEG(quality);
  const hash = hashPreparedJpeg(jpegBuffer);
  const key = `${profile}:${hash}`;
  if (cacheByProfileAndHash.has(key)) {
    return cachePreparedEntry({ profile, hash });
  }
  const base64 = jpegBuffer.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;
  const entry = {
    base64,
    dataUrl,
    mimeType: 'image/jpeg',
    width: finalSize.width,
    height: finalSize.height,
    hash,
    sha256: hash,
    profile,
    maxEdge,
    quality,
    black: false,
    fallback: false,
    source: 'screen',
    capturedAt: Date.now(),
  };
  return cachePreparedEntry(entry);
}

/**
 * Downscale a NativeImage to the long-edge cap (never upscale) and encode it as
 * a JPEG data URL. Pure with respect to Electron: the image is duck-typed
 * (getSize / resize / toJPEG), so it is unit-testable without a display.
 */
function encodeScreenshot(img, options = {}) {
  return resizeAndEncode(img, options).dataUrl;
}

/**
 * Capture full-resolution screen on macOS using /usr/sbin/screencapture.
 * Bypasses ScreenCaptureKit/desktopCapturer empty thumbnail issues on macOS
 * and returns a NativeImage, or null if capture failed.
 */
function captureMacNative() {
  return new Promise((resolve) => {
    const tmpPath = path.join(os.tmpdir(), `cue_capture_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'png', tmpPath], (err) => {
      if (err) return resolve(null);
      try {
        if (!fs.existsSync(tmpPath)) return resolve(null);
        const img = nativeImage && nativeImage.createFromPath ? nativeImage.createFromPath(tmpPath) : null;
        if (!img || img.isEmpty()) return resolve(null);
        resolve(img);
      } catch (_) {
        resolve(null);
      } finally {
        // The PNG is a full-resolution picture of the user's screen: never leave it behind.
        fs.unlink(tmpPath, () => {});
      }
    });
  });
}

// A frame that Windows Display Affinity (WDA_EXCLUDEFROMCAPTURE) or DRM
// blacked out is pure black, not empty: isEmpty() stays false, so without
// this check a black image was sent to the model silently. Detection runs on
// the raw pixels before JPEG encoding, so compression artefacts can't fake
// or hide it. Fail-open: if pixels can't be read, the frame is NOT black
// (never block a capture we can't inspect).
// Channel order doesn't matter: BGRA and RGBA both put alpha last, so the
// max over the first three bytes is the same either way.
// Limit: this catches a (near-)fully black frame, i.e. the "nothing is
// visible" case. A single blacked-out window on an otherwise normal screen
// won't trip it; for browser tabs the companion DOM capture covers that.
const BLACK_CHANNEL_MAX = 16;
const BLACK_FRACTION_MIN = 0.995;
const BLACK_SAMPLE_MAX = 2048;

function isLikelyBlackBitmap(imgOrBuf, maybeWidth, maybeHeight) {
  try {
    if (!imgOrBuf) return false;
    let buf = null;
    let width = 0;
    let height = 0;

    if (Buffer.isBuffer(imgOrBuf) || imgOrBuf instanceof Uint8Array) {
      buf = imgOrBuf;
      if (typeof maybeWidth === 'number' && typeof maybeHeight === 'number') {
        width = maybeWidth;
        height = maybeHeight;
      } else if (maybeWidth && typeof maybeWidth === 'object') {
        width = maybeWidth.width || 0;
        height = maybeWidth.height || 0;
      } else {
        const totalPixels = Math.floor(buf.length / 4);
        width = totalPixels;
        height = totalPixels > 0 ? 1 : 0;
      }
    } else if (typeof imgOrBuf.getSize === 'function' && typeof imgOrBuf.toBitmap === 'function') {
      const size = imgOrBuf.getSize();
      width = size.width;
      height = size.height;
      if (!width || !height) return false;
      buf = imgOrBuf.toBitmap();
    } else {
      return false;
    }

    if (!width || !height) return false;
    if (!buf || buf.length < width * height * 4) return false;
    const total = width * height;
    const step = Math.max(1, Math.floor(Math.sqrt(total / BLACK_SAMPLE_MAX)));
    let sampled = 0;
    let black = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const off = (y * width + x) * 4;
        const brightest = Math.max(buf[off], buf[off + 1], buf[off + 2]);
        if (brightest <= BLACK_CHANNEL_MAX) black++;
        sampled++;
      }
    }
    return sampled > 0 && (black / sampled) >= BLACK_FRACTION_MIN;
  } catch (_) {
    return false;
  }
}

const isBlackFrame = isLikelyBlackBitmap;

// ── Pending-Capture Wait (Never-Drop Capture) ────────────────────────────────

const PENDING_SHOT_WAIT_MS = 2500;

function extractShotKey(shotOrKey) {
  if (!shotOrKey) return null;
  if (typeof shotOrKey === 'string') return shotOrKey;
  if (typeof shotOrKey === 'object') {
    return shotOrKey.path || shotOrKey.hash || shotOrKey.sha256 || shotOrKey.dataUrl || shotOrKey.base64 || null;
  }
  return null;
}

function isValidCapturedShot(shot) {
  if (!shot || typeof shot !== 'object') return false;
  return Boolean(shot.path || shot.hash || shot.sha256 || shot.base64 || shot.dataUrl);
}

/**
 * Tracks in-flight screenshots so a hotkey, typed send, or quick action pressed
 * while a capture is still running waits for it and claims the result instead
 * of dropping the turn or sending without an image.
 */
function createPendingScreenshots() {
  const flying = new Set();
  const taken = new Set();
  const waiting = new Set();

  return {
    track(capture) {
      const p = Promise.resolve(capture).then(
        (shot) => {
          const done = isValidCapturedShot(shot) ? shot : null;
          const key = extractShotKey(done);
          const send = waiting.values().next().value;
          if (done && key && send && !taken.has(key)) {
            taken.add(key);
            send.push(done);
          }
          return done;
        },
        () => null,
      );
      flying.add(p);
      p.finally(() => flying.delete(p));
      return p;
    },

    inFlight() {
      return flying.size > 0;
    },

    async settle(timeoutMs = PENDING_SHOT_WAIT_MS) {
      if (flying.size === 0) return [];
      const pending = [...flying];
      const shots = [];
      waiting.add(shots);
      let timer;
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise((r) => { timer = setTimeout(r, timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
        waiting.delete(shots);
      }
      return shots;
    },

    claimed(pathOrShot) {
      const key = extractShotKey(pathOrShot);
      return Boolean(key && taken.has(key));
    },

    clear() {
      flying.clear();
      taken.clear();
      waiting.clear();
    },
  };
}

const defaultPendingScreenshots = createPendingScreenshots();
const inFlightByProfile = new Map();

function clearScreenshotCache() {
  cacheByProfileAndHash.clear();
  cacheByHash.clear();
  lastPreparedByProfile.clear();
  lastPreparedOverall = null;
  cacheHits = 0;
  cacheMisses = 0;
  inFlightByProfile.clear();
  defaultPendingScreenshots.clear();
}

async function captureDesktopSourceImage() {
  if (!screen || typeof screen.getPrimaryDisplay !== 'function') return null;
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') return null;
  const primary = screen.getPrimaryDisplay();
  if (!primary || !primary.size) return null;
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) },
  });
  if (!Array.isArray(sources) || !sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src && src.thumbnail;
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) return null;
  return img;
}

async function captureRawNativeImage(options = {}) {
  if (options && typeof options.captureImage === 'function') {
    return options.captureImage(options);
  }
  if (process.platform === 'darwin') {
    const macImg = await captureMacNative();
    if (macImg) return macImg;
    return captureDesktopSourceImage();
  }
  return captureDesktopSourceImage();
}

async function executeCaptureDetailed(options = {}) {
  const img = await captureRawNativeImage(options);
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) {
    return { dataUrl: null, base64: null, black: false, screenshot: null };
  }
  // Black-frame check MUST run on raw pixels before JPEG encoding.
  if (isLikelyBlackBitmap(img)) {
    return { dataUrl: null, base64: null, black: true, screenshot: null };
  }
  const prepared = resizeAndEncode(img, options);
  return {
    dataUrl: prepared.dataUrl,
    base64: prepared.base64,
    mimeType: prepared.mimeType,
    width: prepared.width,
    height: prepared.height,
    hash: prepared.hash,
    sha256: prepared.hash,
    profile: prepared.profile,
    capturedAt: prepared.capturedAt,
    black: false,
    fallback: false,
    source: 'screen',
    screenshot: prepared,
  };
}

function startTrackedCaptureDetailed(options = {}) {
  const { profile } = resolveEncodingOptions(options);
  const forceFresh = Boolean(options && typeof options === 'object' && options.forceFresh);
  if (!forceFresh && inFlightByProfile.has(profile)) {
    return inFlightByProfile.get(profile);
  }
  let job;
  job = Promise.resolve()
    .then(() => executeCaptureDetailed(options))
    .finally(() => {
      if (inFlightByProfile.get(profile) === job) {
        inFlightByProfile.delete(profile);
      }
    });
  inFlightByProfile.set(profile, job);
  defaultPendingScreenshots.track(job.then((res) => res && res.screenshot));
  return job;
}

/**
 * Wait for any in-flight capture (for the given profile, or any profile) to
 * settle and return the prepared screenshot, or null if none is in flight.
 */
async function waitForPendingCapture(profileOrOptions) {
  if (profileOrOptions !== undefined && profileOrOptions !== null) {
    const profile = resolveScreenshotProfile(profileOrOptions);
    if (inFlightByProfile.has(profile)) {
      let currentJob = inFlightByProfile.get(profile);
      let detail = await currentJob;
      while (inFlightByProfile.has(profile) && inFlightByProfile.get(profile) !== currentJob) {
        currentJob = inFlightByProfile.get(profile);
        detail = await currentJob;
      }
      return detail && detail.screenshot ? detail.screenshot : null;
    }
  } else if (inFlightByProfile.size > 0) {
    const jobs = [...inFlightByProfile.values()];
    const results = await Promise.all(jobs);
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i] && results[i].screenshot) return results[i].screenshot;
    }
  }
  if (defaultPendingScreenshots.inFlight()) {
    const settled = await defaultPendingScreenshots.settle();
    if (settled.length > 0) return settled[settled.length - 1];
  }
  return null;
}

async function normalizeCompanionFallbackResult(companionResult, options = {}, wasBlack = false) {
  if (!companionResult) return null;
  const { profile, maxEdge, quality } = resolveEncodingOptions(options);
  if (typeof companionResult.getSize === 'function' && typeof companionResult.toJPEG === 'function') {
    if (isLikelyBlackBitmap(companionResult)) return null;
    const prepared = resizeAndEncode(companionResult, options);
    return {
      ...prepared,
      black: false,
      fallback: true,
      source: 'companion',
    };
  }
  if (Buffer.isBuffer(companionResult)) {
    const hash = hashPreparedJpeg(companionResult);
    const base64 = companionResult.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64}`;
    const entry = cachePreparedEntry({
      base64,
      dataUrl,
      mimeType: 'image/jpeg',
      width: maxEdge,
      height: maxEdge,
      hash,
      sha256: hash,
      profile,
      maxEdge,
      quality,
      black: wasBlack,
      fallback: true,
      source: 'companion',
      capturedAt: Date.now(),
    });
    return { ...entry, black: wasBlack, fallback: true, source: 'companion' };
  }
  if (typeof companionResult === 'string') {
    const isDataUrl = companionResult.startsWith('data:image/');
    const base64 = isDataUrl
      ? companionResult.replace(/^data:image\/[^;]+;base64,/i, '')
      : companionResult;
    const dataUrl = isDataUrl ? companionResult : `data:image/jpeg;base64,${base64}`;
    const hash = hashPreparedJpeg(base64);
    const entry = cachePreparedEntry({
      base64,
      dataUrl,
      mimeType: 'image/jpeg',
      width: maxEdge,
      height: maxEdge,
      hash,
      sha256: hash,
      profile,
      maxEdge,
      quality,
      black: wasBlack,
      fallback: true,
      source: 'companion',
      capturedAt: Date.now(),
    });
    return { ...entry, black: wasBlack, fallback: true, source: 'companion' };
  }
  if (typeof companionResult === 'object') {
    if (companionResult.image && typeof companionResult.image.getSize === 'function') {
      return normalizeCompanionFallbackResult(companionResult.image, options, wasBlack);
    }
    if (companionResult.img && typeof companionResult.img.getSize === 'function') {
      return normalizeCompanionFallbackResult(companionResult.img, options, wasBlack);
    }
    if (typeof companionResult.dataUrl === 'string' || typeof companionResult.base64 === 'string') {
      const raw = companionResult.dataUrl || companionResult.base64;
      const normalized = await normalizeCompanionFallbackResult(raw, options, wasBlack);
      return {
        ...normalized,
        ...(companionResult.domContext ? { domContext: companionResult.domContext } : {}),
        ...(companionResult.text ? { text: companionResult.text } : {}),
      };
    }
    if (companionResult.domContext || companionResult.text) {
      return {
        dataUrl: null,
        base64: null,
        mimeType: null,
        hash: null,
        profile,
        black: wasBlack,
        fallback: true,
        source: 'companion',
        domContext: companionResult.domContext || companionResult.text,
        text: companionResult.text || companionResult.domContext,
      };
    }
  }
  return null;
}

/**
 * Capture screen with black-frame detection on raw pixels before JPEG encoding,
 * falling back to the companion when the frame is black or unavailable.
 * Never runs a describe prepass.
 */
async function captureScreenWithFallback(companion, options = {}) {
  let actualCompanion = companion;
  let actualOptions = options;
  if (
    companion &&
    typeof companion === 'object' &&
    typeof companion.capture !== 'function' &&
    typeof companion.captureScreenshot !== 'function' &&
    typeof companion.getScreenshot !== 'function' &&
    typeof companion.getContext !== 'function' &&
    typeof companion.getSize !== 'function' &&
    !companion.dataUrl &&
    !companion.base64 &&
    !companion.domContext &&
    !companion.text &&
    (companion.profile || companion.mode || companion.feature || companion.maxEdge || companion.quality || companion.captureImage || companion.companion)
  ) {
    actualOptions = companion;
    actualCompanion = companion.companion || null;
  }

  const detailed = await startTrackedCaptureDetailed(actualOptions);
  if (detailed && detailed.screenshot) {
    return detailed.screenshot;
  }

  const wasBlack = Boolean(detailed && detailed.black);
  const comp = actualCompanion ?? (actualOptions && actualOptions.companion);
  if (!comp) return null;

  try {
    let rawFallback = null;
    if (typeof comp === 'function') {
      rawFallback = await comp(actualOptions, { black: wasBlack });
    } else if (typeof comp.captureScreenshot === 'function') {
      rawFallback = await comp.captureScreenshot(actualOptions);
    } else if (typeof comp.capture === 'function') {
      rawFallback = await comp.capture(actualOptions);
    } else if (typeof comp.getScreenshot === 'function') {
      rawFallback = await comp.getScreenshot(actualOptions);
    } else if (typeof comp.getContext === 'function') {
      rawFallback = await comp.getContext(actualOptions);
    } else {
      rawFallback = comp;
    }
    return await normalizeCompanionFallbackResult(rawFallback, actualOptions, wasBlack);
  } catch (_) {
    return null;
  }
}

/**
 * Capture screen and return the prepared screenshot object (cached by SHA-256),
 * coalescing/waiting if a capture for the requested profile is already in flight.
 */
async function captureScreen(options = {}) {
  if (options && typeof options === 'object' && options.companion) {
    return captureScreenWithFallback(options.companion, options);
  }
  const detailed = await startTrackedCaptureDetailed(options);
  return detailed && detailed.screenshot ? detailed.screenshot : null;
}

/**
 * Acquire the screenshot for a hotkey, typed chat, or quick-action turn:
 * 1. If a capture for the profile (or an explicit pendingCapture) is in flight,
 *    wait for it to settle so a turn never drops or goes out without an image.
 * 2. Otherwise capture (or reuse cached if screen is unchanged).
 * 3. Apply new-screenshot-wins over any previous cached screenshot.
 */
async function acquireScreenshotForTurn(options = {}) {
  const { profile } = resolveEncodingOptions(options);
  const previous = (options && typeof options === 'object' && (options.previousScreenshot || options.cachedScreenshot))
    || getLastPreparedScreenshot(profile);

  if (options && typeof options === 'object' && options.pendingCapture) {
    const settled = await Promise.resolve(options.pendingCapture).catch(() => null);
    if (settled) return selectWinningScreenshot(previous, settled);
  }

  const pending = await waitForPendingCapture(options);
  if (pending) {
    return selectWinningScreenshot(previous, pending);
  }

  if (options && typeof options === 'object' && options.captureIfMissing === false) {
    return previous || null;
  }

  const fresh = await captureScreenWithFallback(
    options && typeof options === 'object' ? options.companion : null,
    options,
  );
  return selectWinningScreenshot(previous, fresh);
}

async function captureScreenshotDetailed(options = {}) {
  const detailed = await startTrackedCaptureDetailed(options);
  if (!detailed || !detailed.screenshot) {
    return { dataUrl: null, black: Boolean(detailed && detailed.black) };
  }
  return {
    dataUrl: detailed.dataUrl,
    black: false,
    base64: detailed.base64,
    hash: detailed.hash,
    sha256: detailed.sha256,
    width: detailed.width,
    height: detailed.height,
    mimeType: detailed.mimeType,
    profile: detailed.profile,
    capturedAt: detailed.capturedAt,
    screenshot: detailed.screenshot,
  };
}

async function captureScreenshot(options = {}) {
  const { dataUrl } = await captureScreenshotDetailed(options);
  return dataUrl;
}

// ── Stale-Stream Guard ───────────────────────────────────────────────────────

function normalizeStreamSource(source) {
  return typeof source === 'string' && source ? source : 'desktop';
}

/**
 * Check whether a chat stream has been replaced by a newer stream.
 * Supports both `{ streamId, activeStreamId }` and positional `(floor, incomingId, incomingSource)`.
 */
function isReplacedChatStream(arg1, incomingId, incomingSource) {
  if (arg1 && typeof arg1 === 'object') {
    const {
      streamId,
      activeStreamId,
      replacedStreamFloor,
      floor,
      source,
    } = arg1;
    if (normalizeStreamSource(source) !== 'desktop') return false;
    if (activeStreamId !== undefined) {
      return Number.isInteger(streamId) && streamId !== activeStreamId;
    }
    const effectiveFloor = replacedStreamFloor !== undefined ? replacedStreamFloor : floor;
    return Number.isInteger(streamId) && Number.isInteger(effectiveFloor) && streamId <= effectiveFloor;
  }
  if (normalizeStreamSource(incomingSource) !== 'desktop') return false;
  return Number.isInteger(arg1) && Number.isInteger(incomingId) && incomingId <= arg1;
}

/**
 * Check whether a desktop chat event is stale (either arrived before the new
 * stream was named via `llm:stream-start` / `gemini-stream-started`, or belongs
 * to a stream with `streamId <= replacedStreamFloor`).
 * Supports both `{ awaitingStreamStart, streamId, replacedStreamFloor }` and
 * positional `(state, incomingId, incomingSource)`.
 */
function isStaleDesktopChatEvent(stateOrPayload, incomingId, incomingSource) {
  if (arguments.length >= 2) {
    if (normalizeStreamSource(incomingSource) !== 'desktop') return false;
    const awaiting = Boolean(stateOrPayload && (stateOrPayload.awaitingStreamStart || stateOrPayload.awaitingStart));
    if (awaiting) return true;
    const floor = stateOrPayload
      ? (stateOrPayload.replacedStreamFloor !== undefined ? stateOrPayload.replacedStreamFloor : stateOrPayload.floor)
      : null;
    return Number.isInteger(incomingId) && Number.isInteger(floor) && incomingId <= floor;
  }
  if (!stateOrPayload || typeof stateOrPayload !== 'object') return false;
  const {
    awaitingStreamStart,
    awaitingStart,
    streamId,
    replacedStreamFloor,
    floor,
    activeStreamId,
    source,
  } = stateOrPayload;
  if (normalizeStreamSource(source) !== 'desktop') return false;
  if (awaitingStreamStart || awaitingStart) return true;
  const effectiveFloor = replacedStreamFloor !== undefined ? replacedStreamFloor : floor;
  if (Number.isInteger(streamId) && Number.isInteger(effectiveFloor) && streamId <= effectiveFloor) {
    return true;
  }
  if (Number.isInteger(streamId) && Number.isInteger(activeStreamId) && streamId !== activeStreamId) {
    return true;
  }
  return false;
}

/**
 * Stateful chat stream guard tracking `activeStreamId`, `replacedStreamFloor`,
 * and `awaitingStreamStart` across main and renderer turns.
 */
function createChatStreamGuard() {
  let activeStreamId = null;
  let nextStreamId = 0;
  let replacedStreamFloor = null;
  let awaitingStreamStart = false;

  return {
    get activeStreamId() {
      return activeStreamId;
    },
    get replacedStreamFloor() {
      return replacedStreamFloor;
    },
    get awaitingStreamStart() {
      return awaitingStreamStart;
    },

    beginStream(meta = {}) {
      if (Number.isInteger(activeStreamId)) {
        replacedStreamFloor = activeStreamId;
      }
      const explicitId = meta && typeof meta === 'object' && Number.isInteger(meta.streamId)
        ? meta.streamId
        : null;
      const streamId = explicitId !== null ? explicitId : (++nextStreamId);
      if (streamId > nextStreamId) nextStreamId = streamId;
      activeStreamId = streamId;
      awaitingStreamStart = meta && typeof meta === 'object' && typeof meta.awaitingStreamStart === 'boolean'
        ? meta.awaitingStreamStart
        : true;
      return {
        ...(meta && typeof meta === 'object' ? meta : {}),
        streamId,
        activeStreamId,
        replacedStreamFloor,
        awaitingStreamStart,
      };
    },

    markAwaitingStart() {
      if (Number.isInteger(activeStreamId)) {
        replacedStreamFloor = activeStreamId;
      }
      awaitingStreamStart = true;
      return {
        activeStreamId,
        replacedStreamFloor,
        awaitingStreamStart,
      };
    },

    onStreamStart(payload = {}) {
      const streamId = typeof payload === 'number'
        ? payload
        : (payload && typeof payload === 'object' ? payload.streamId : undefined);
      if (Number.isInteger(streamId)) {
        const floorCandidate = streamId - 1;
        replacedStreamFloor = Number.isInteger(replacedStreamFloor)
          ? Math.max(replacedStreamFloor, floorCandidate)
          : floorCandidate;
        activeStreamId = streamId;
        if (streamId > nextStreamId) nextStreamId = streamId;
        awaitingStreamStart = false;
      }
      return {
        streamId: activeStreamId,
        activeStreamId,
        replacedStreamFloor,
        awaitingStreamStart,
      };
    },

    isReplaced(streamIdOrPayload) {
      const streamId = typeof streamIdOrPayload === 'object' && streamIdOrPayload !== null
        ? streamIdOrPayload.streamId
        : streamIdOrPayload;
      return isReplacedChatStream({ streamId, activeStreamId });
    },

    shouldDropEvent(payload = {}) {
      const streamId = typeof payload === 'number'
        ? payload
        : (payload && typeof payload === 'object' ? payload.streamId : undefined);
      const source = payload && typeof payload === 'object' ? payload.source : undefined;
      return isStaleDesktopChatEvent({
        awaitingStreamStart,
        streamId,
        replacedStreamFloor,
        activeStreamId,
        source,
      });
    },

    getState() {
      return {
        activeStreamId,
        replacedStreamFloor,
        awaitingStreamStart,
      };
    },
  };
}

module.exports = {
  captureScreenshot,
  captureScreenshotDetailed,
  captureScreen,
  captureScreenWithFallback,
  acquireScreenshotForTurn,
  waitForPendingCapture,
  createPendingScreenshots,
  isBlackFrame,
  isLikelyBlackBitmap,
  encodeScreenshot,
  resizeAndEncode,
  captureMacNative,
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
  BLACK_SAMPLE_MAX,
};
