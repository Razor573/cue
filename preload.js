const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('cue', {
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: (params) => ipcRenderer.invoke('models:list', params),
  testConnection: (params) => ipcRenderer.invoke('llm:test-connection', params),
  parseVertexServiceAccount: (raw) => ipcRenderer.invoke('vertex:parse-sa', raw),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[cue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  enableSafeClickThrough: () => ipcRenderer.invoke('mouse:click-through-enable'),
  restoreInteractiveMode: () => ipcRenderer.invoke('mouse:interactive-restore'),
  toggleInteractiveMode: () => ipcRenderer.invoke('mouse:interactive-toggle'),
  startStealthTyping: () => ipcRenderer.invoke('stealth:start'),
  stopStealthTyping: () => ipcRenderer.invoke('stealth:stop'),
  attachFiles: () => ipcRenderer.invoke('files:attach-dialog'),
  removeLastAttachedFile: () => ipcRenderer.invoke('files:remove-last'),
  checkUpdate: () => ipcRenderer.invoke('app:update-check'),
  windowDragStart: () => ipcRenderer.send('window:drag-start'),
  windowDragEnd: () => ipcRenderer.send('window:drag-end'),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  slidesList: () => ipcRenderer.invoke('slides:list'),
  slidesState: () => ipcRenderer.invoke('slides:state'),
  slidesClear: () => ipcRenderer.invoke('slides:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  publikState: () => ipcRenderer.invoke('publik:state'),
  publikAcceptDisclosure: () => ipcRenderer.invoke('publik:accept-disclosure'),
  publikReconnect: () => ipcRenderer.invoke('publik:reconnect'),
  publikRefresh: () => ipcRenderer.invoke('publik:refresh'),
  publikDisconnect: () => ipcRenderer.invoke('publik:disconnect'),
  publikCardSeen: () => ipcRenderer.invoke('publik:card-seen'),
  publikOpen: (url) => ipcRenderer.send('publik:open', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  testWhisperModel: (modelId) => ipcRenderer.invoke('whisper:test-model', modelId),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  clearSessionDirectives: () => ipcRenderer.invoke('session:directive-clear'),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = [
      'capture:state', 'llm:start', 'llm:thought', 'llm:token', 'llm:done', 'llm:error', 'status',
      'transcript', 'transcript:restore', 'stt:interim', 'stt:final', 'stt:status',
      'vad:state', 'applink:consent-request', 'hide:toggle', 'whisper:download-progress',
      'whisper:models-changed', 'publik:state', 'slides:update',
      'stealth-key', 'toggle-ask-input', 'open-settings', 'settings-unlock',
      'reset-view', 'response:scroll', 'code:scroll', 'history:nav',
      'transparency:toggle', 'interactive:state', 'attached-files', 'emergency:recover',
      'open-meeting-companion', 'session:directive'
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
