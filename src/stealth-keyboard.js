'use strict';

const fs = require('fs');
const path = require('path');

class StealthKeyboardManager {
  constructor(getMainWindow, options = {}) {
    this.getMainWindow = getMainWindow;
    this.platform = options.platform || process.platform;
    this.addon = options.addon || null;
    this.active = false;
    this.lastError = null;

    if (!options.addon) {
      this._init(options.addonPath);
    }
  }

  _findAddonPath(customPath) {
    if (customPath) {
      return customPath;
    }
    const candidates = [];
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'stealth-keyboard', 'prebuilt', 'win32-x64', 'stealth_keyboard.node'),
        path.join(process.resourcesPath, 'native', 'stealth-keyboard', 'prebuilt', 'win32-x64', 'stealth_keyboard.node'),
        path.join(process.resourcesPath, 'native', 'stealth-keyboard', 'stealth_keyboard.node')
      );
    }
    candidates.push(
      path.join(__dirname, '..', 'native', 'stealth-keyboard', 'prebuilt', 'win32-x64', 'stealth_keyboard.node'),
      path.join(__dirname, '..', 'native', 'stealth-keyboard', 'stealth_keyboard.node')
    );

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // ignore and continue
      }
    }
    return null;
  }

  _init(customPath) {
    if (this.platform !== 'win32') {
      this.lastError = 'Stealth keyboard is only supported on Windows';
      return;
    }

    const addonPath = this._findAddonPath(customPath);
    if (!addonPath) {
      this.lastError = 'Native stealth keyboard addon binary not found';
      return;
    }

    try {
      this.addon = require(addonPath);
      this.lastError = null;
    } catch (err) {
      this.lastError = err ? err.message : 'Failed to load stealth keyboard addon';
      this.addon = null;
    }
  }

  isAvailable() {
    return Boolean(
      this.addon &&
      typeof this.addon.startTyping === 'function' &&
      typeof this.addon.stopTyping === 'function'
    );
  }

  isActive() {
    return this.active === true;
  }

  getLastError() {
    return this.lastError;
  }

  start() {
    if (!this.isAvailable()) {
      return false;
    }
    if (this.active) {
      return true;
    }

    try {
      this.addon.startTyping((ev) => {
        try {
          const win = typeof this.getMainWindow === 'function' ? this.getMainWindow() : null;
          if (win && !win.isDestroyed() && win.webContents) {
            win.webContents.send('stealth-key', ev);
          }
        } catch (dispatchErr) {
          console.error('[cue:stealth-keyboard] failed to dispatch key event:', dispatchErr);
        }
      });
      this.active = true;
      return true;
    } catch (err) {
      this.lastError = err ? err.message : 'Failed to start stealth typing';
      this.active = false;
      return false;
    }
  }

  stop() {
    if (!this.isAvailable()) {
      this.active = false;
      return false;
    }
    if (!this.active) {
      return true;
    }

    try {
      this.addon.stopTyping();
      this.active = false;
      return true;
    } catch (err) {
      this.lastError = err ? err.message : 'Failed to stop stealth typing';
      this.active = false;
      return false;
    }
  }
}

module.exports = {
  StealthKeyboardManager,
};
