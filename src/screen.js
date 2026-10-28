// Screenshot via native screencapture on macOS, falling back to desktopCapturer (main process).
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Vision models downscale anything larger than ~1568 px on the long edge
// anyway, and a gateway sitting on Vercel refuses request bodies over 4.5 MB
// before any route code runs (413, with no body the app can shape). A Retina
// PNG of a busy screen is commonly 5–15 MB, so every screenshot is resized to
// this long edge and encoded as JPEG before it is base64'd into the prompt.
const MAX_LONG_EDGE_PX = 1568;
const JPEG_QUALITY = 70;
// What the encoded data URL must stay under so the whole request, prompt and
// all, fits in the gateway's 4 MB request rule with room to spare.
const MAX_DATA_URL_BYTES = 3 * 1024 * 1024;

/**
 * Downscale a NativeImage to the long-edge cap (never upscale) and encode it as
 * a JPEG data URL. Pure with respect to Electron: the image is duck-typed
 * (getSize / resize / toJPEG), so it is unit-testable without a display.
 */
function encodeScreenshot(img, { maxLongEdge = MAX_LONG_EDGE_PX, quality = JPEG_QUALITY } = {}) {
  const { width, height } = img.getSize();
  let out = img;
  if (width > maxLongEdge || height > maxLongEdge) {
    out = width >= height ? img.resize({ width: maxLongEdge }) : img.resize({ height: maxLongEdge });
  }
  const jpeg = out.toJPEG(quality);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
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

function isBlackFrame(img) {
  try {
    if (!img || typeof img.getSize !== 'function' || typeof img.toBitmap !== 'function') return false;
    const { width, height } = img.getSize();
    if (!width || !height) return false;
    const buf = img.toBitmap();
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

async function captureScreenshotDetailed() {
  if (process.platform === 'darwin') {
    const macImg = await captureMacNative();
    if (!macImg) return { dataUrl: null, black: false };
    if (isBlackFrame(macImg)) return { dataUrl: null, black: true };
    return { dataUrl: encodeScreenshot(macImg), black: false };
  }

  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return { dataUrl: null, black: false };
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return { dataUrl: null, black: false };
  if (isBlackFrame(img)) return { dataUrl: null, black: true };
  return { dataUrl: encodeScreenshot(img), black: false }; // data:image/jpeg;base64,...
}

async function captureScreenshot() {
  const { dataUrl } = await captureScreenshotDetailed();
  return dataUrl;
}

module.exports = { captureScreenshot, captureScreenshotDetailed, isBlackFrame, encodeScreenshot, captureMacNative, MAX_LONG_EDGE_PX, JPEG_QUALITY, MAX_DATA_URL_BYTES, BLACK_CHANNEL_MAX, BLACK_FRACTION_MIN, BLACK_SAMPLE_MAX };
