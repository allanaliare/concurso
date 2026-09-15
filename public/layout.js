(() => {
  const key = 'ponto.sidebar.collapsed';
  const body = document.body;
  const toggle = document.querySelector('[data-sidebar-toggle]');
  if (!toggle) return;

  if (localStorage.getItem(key) === '1') body.classList.add('sidebar-collapsed');

  toggle.addEventListener('click', () => {
    body.classList.toggle('sidebar-collapsed');
    localStorage.setItem(key, body.classList.contains('sidebar-collapsed') ? '1' : '0');
  });
})();
