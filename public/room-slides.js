(() => {
  const root = document.querySelector('.slide');
  if (!root) return;

  let rooms = [];
  try {
    rooms = JSON.parse(root.dataset.rooms || '[]');
  } catch {
    rooms = [];
  }

  const serverNow = Number(root.dataset.serverNow || Date.now());
  const loadedAt = Date.now();
  const stage = document.querySelector('.stage');
  const clock = document.querySelector('.clock');
  const counter = document.querySelector('.counter strong');
  const progress = document.querySelector('.progress span');
  const seconds = 9;
  let current = -1;

  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const brasiliaNow = () => new Date(serverNow + (Date.now() - loadedAt));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

  function renderClock() {
    if (clock) clock.textContent = fmt.format(brasiliaNow());
  }

  function resetProgress() {
    if (!progress) return;
    progress.style.transition = 'none';
    progress.style.width = '0';
    requestAnimationFrame(() => {
      progress.style.transition = `width ${seconds}s linear`;
      progress.style.width = '100%';
    });
  }

  function render(index) {
    const room = rooms[index] || null;
    if (counter) counter.textContent = rooms.length ? `${index + 1}/${rooms.length}` : '0/0';
    if (!stage) return;

    stage.innerHTML = room
      ? `<section class="room-head"><h1 class="room-title">${escapeHtml(room.name)}</h1><div class="room-meta">${room.filled}/${room.planned} trabalhando</div></section><section class="roles">${room.roles.length ? room.roles.map(role => `<article class="role"><h2>${escapeHtml(role.name)}<span>${role.filled}/${role.planned}</span></h2><div class="names">${role.people.length ? role.people.map(person => `<div class="person" title="${escapeHtml(person.fullName)}">${escapeHtml(person.name)}</div>`).join('') : '<div class="empty">Sem colaborador</div>'}</div></article>`).join('') : '<div class="empty">Sala sem cargos definidos</div>'}</section>`
      : '<div class="empty">Nenhuma sala cadastrada</div>';

    resetProgress();
  }

  function tick() {
    if (!rooms.length) {
      render(0);
      return;
    }
    current = (current + 1) % rooms.length;
    render(current);
  }

  renderClock();
  tick();
  setInterval(renderClock, 1000);
  setInterval(tick, seconds * 1000);
})();
