'use strict';

const TITLEBAR_HEIGHT = 44;
function frameOptions(platform = process.platform) {
  return {
    titleBarStyle: 'hidden',
    ...(platform === 'darwin' ? {} : { titleBarOverlay: { color: '#101011', symbolColor: '#b4b4bd', height: TITLEBAR_HEIGHT } }),
  };
}
function stateOf(win) {
  return { focused: win.isFocused(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
}
function watchFrame(win, send, platform = process.platform) {
  const update = () => {
    if (win.isDestroyed()) return;
    if (platform !== 'darwin') win.setTitleBarOverlay({ symbolColor: win.isFocused() ? '#b4b4bd' : '#72727c' });
    send(stateOf(win));
  };
  for (const event of ['focus', 'blur', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, update);
  win.webContents.on('did-finish-load', update);
}
module.exports = { frameOptions, stateOf, watchFrame, TITLEBAR_HEIGHT };
