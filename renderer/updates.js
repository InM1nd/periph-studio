(() => {
  'use strict';
  const api = window.updates;
  const $ = (id) => document.getElementById(id);
  const message = $('updateMessage');
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  let pending = false;
  let state = null;
  function render(next = state) {
    if (!next) return;
    state = next;
    const checking = next.status === 'checking', downloading = next.status === 'downloading';
    const installing = ['preparing', 'installing'].includes(next.status);
    const busy = pending || checking || downloading || installing;
    $('currentVersion').textContent = 'Версия ' + next.currentVersion;
    document.querySelector('.app-version').textContent = 'Periph Studio · ' + next.currentVersion;
    message.textContent = next.message;
    message.classList.toggle('update-error', next.status === 'error' || (next.status === 'ready' && !!next.installError));
    $('updateCheck').disabled = busy;
    $('updateReleases').disabled = busy;
    $('updateReleases').hidden = next.status === 'ready' || installing;
    $('updateCheck').textContent = checking ? 'Проверяю…' : 'Проверить обновления';
    $('updateDownload').hidden = !next.canDownload;
    $('updateDownload').disabled = busy;
    $('updateDownload').textContent = `Скачать ${next.version || ''} · ${mb(next.total)} МБ`;
    $('updateCancel').hidden = !downloading;
    $('updateCancel').disabled = false;
    $('updateOpen').hidden = $('updateShowFile').hidden = next.status !== 'ready';
    $('updateOpen').disabled = $('updateShowFile').disabled = busy;
    $('updateInstall').hidden = !next.canInstall && !installing;
    $('updateInstall').disabled = busy;
    $('updateInstall').textContent = installing ? 'Подготавливаю обновление…' : 'Установить и перезапустить';
    $('updateProgressWrap').hidden = !downloading && next.status !== 'ready';
    $('updateProgress').value = next.progress;
    $('updateProgressText').textContent = `${next.progress}% · ${mb(next.received)} / ${mb(next.total)} МБ`;
    $('updateNotesWrap').hidden = !next.notes;
    $('updateNotes').textContent = next.notes || '';
  }
  async function action(method) {
    if (pending) return;
    pending = true; render();
    try {
      if (method === 'install' && window.prepareForUpdate && !await window.prepareForUpdate()) return;
      const result = await api[method]();
      if (result?.ok === false) throw new Error(result.error);
      const next = result?.data || result;
      if (next?.status) render(next);
    } catch (e) {
      message.textContent = e.message || 'Не удалось выполнить действие. Попробуйте ещё раз.';
      message.classList.add('update-error');
    } finally {
      pending = false;
      // Preserve action errors while restoring button availability.
      const text = message.textContent, failed = message.classList.contains('update-error');
      render();
      if (failed) { message.textContent = text; message.classList.add('update-error'); }
    }
  }
  if (!api) {
    message.textContent = 'Проверка обновлений доступна в приложении Periph Studio.';
    ['updateCheck', 'updateReleases'].forEach((id) => { $(id).disabled = true; });
    return;
  }
  ['Check', 'Download', 'Install', 'Open', 'ShowFile', 'Releases'].forEach((name) => {
    $('update' + name).addEventListener('click', () => action(name[0].toLowerCase() + name.slice(1)));
  });
  // Cancellation must stay available while the download invocation is pending.
  $('updateCancel').addEventListener('click', () => {
    api.cancel().catch(() => { message.textContent = 'Не удалось отменить загрузку. Повторите попытку.'; });
  });
  api.onState((next) => render(next));
  api.onShowSettings?.(() => document.querySelector('.nav-item[data-tab="settings"]').click());
  api.getState().then((next) => render(next)).catch(() => {
    message.textContent = 'Не удалось получить состояние обновлений. Попробуйте выполнить проверку.';
  });
})();
