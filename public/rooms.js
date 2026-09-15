(() => {
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-open-dialog]');
    if (open) {
      const dialog = document.getElementById(open.dataset.openDialog);
      if (!dialog) return;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      return;
    }

    const close = event.target.closest('[data-close-dialog]');
    if (close) {
      const dialog = close.closest('dialog');
      if (!dialog) return;
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      return;
    }

    const copy = event.target.closest('[data-copy-room-message]');
    if (copy) {
      const textarea = document.getElementById('room-message');
      if (!textarea) return;
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      navigator.clipboard?.writeText(textarea.value).then(() => {
        copy.textContent = 'Copiado';
        setTimeout(() => { copy.textContent = 'Copiar mensagem'; }, 1400);
      }).catch(() => document.execCommand('copy'));
    }
  });
})();
