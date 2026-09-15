(() => {
  const form = document.querySelector('[data-receipt-picker]');
  if (!form) return;

  const search = document.getElementById('receipt-search');
  const available = document.getElementById('receipt-available');
  const chosen = document.getElementById('receipt-chosen');
  const count = document.getElementById('receipt-count');
  const empty = document.getElementById('receipt-empty');
  const all = document.getElementById('receipt-all');
  const normalize = value => (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const cards = () => [...form.querySelectorAll('.receipt-person')];

  function sync() {
    let selected = 0;
    cards().forEach(card => {
      const checked = card.querySelector('input').checked;
      if (checked && card.parentElement !== chosen) chosen.appendChild(card);
      if (!checked && card.parentElement !== available) available.appendChild(card);
      if (checked) selected += 1;
    });
    count.textContent = `${selected} selecionado${selected === 1 ? '' : 's'}`;
    all.checked = selected > 0 && selected === cards().length;
    all.indeterminate = selected > 0 && selected < cards().length;
    if (empty) empty.hidden = selected > 0;
  }

  function filter() {
    const query = normalize(search.value);
    cards().forEach(card => {
      card.hidden = query && !normalize(card.dataset.name).includes(query);
    });
  }

  form.addEventListener('change', event => {
    if (event.target.name === 'selected') {
      sync();
      filter();
    }
  });
  search.addEventListener('input', filter);
  all.addEventListener('change', () => {
    cards().forEach(card => {
      card.querySelector('input').checked = all.checked;
    });
    sync();
    filter();
  });
  form.addEventListener('submit', event => {
    if (!form.querySelector('input[name=selected]:checked')) {
      event.preventDefault();
      if (empty) empty.hidden = false;
    }
  });

  sync();
})();
