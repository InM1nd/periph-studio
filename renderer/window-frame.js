(() => {
  'use strict';
  function render(state) {
    document.body.classList.toggle('window-inactive', !state.focused);
    document.body.classList.toggle('window-maximized', !!state.maximized);
    document.body.classList.toggle('window-fullscreen', !!state.fullscreen);
  }
  const api = window.windowFrame;
  if (!api) return;
  api.onState(render);
  api.getState().then(render).catch(() => {});
})();
