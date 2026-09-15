export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const date = value => value ? esc(value.replace('T',' às ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1')) : 'A definir';
export const money = value => Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export const csrf = token => `<input type="hidden" name="_csrf" value="${esc(token)}">`;
export function layout(title, body, {admin=false, user=null, token='', error=''} = {}) {
  const icons={
    menu:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    users:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    groups:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M7 12h7M5 20l-3 2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7z"/></svg>',
    clock:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"/></svg>',
    shield:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>',
    history:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6M12 7v5l3 2"/></svg>',
    message:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
    external:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
    logout:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
  };
  const brand='ponto de prova';
  const links=[['/admin','Visão geral','home'],['/admin/registrations','Colaboradores','users'],['/admin/groups','Grupos','groups'],['/admin/reminders','Lembretes','clock'],...(user?.role==='admin'?[['/admin/users','Usuários','shield'],['/admin/history','Histórico','history'],['/admin/messages','WhatsApp','message']]:[])];
  const notice=error?`<div role="alert" class="alert">${esc(error)}</div>`:'';
  const header=admin?`<header class="bo-header"><a class="brand" href="/admin">${brand}<span class="brand-label">BACK-OFFICE</span></a><div class="account-info"><strong>${esc(user?.name)}</strong><span>${user?.role==='admin'?'Administrador':'Gestor de concursos'}</span></div></header>`:`<header><a class="brand" href="/"><span class="mark">P</span>${brand}<span class="brand-label">CONCURSOS</span></a><nav><a href="/">Concursos</a><a href="/login">Área do organizador ↗</a></nav></header>`;
  const navigation=admin?`<aside class="bo-sidebar"><button class="sidebar-toggle" type="button" data-sidebar-toggle aria-label="Ocultar ou mostrar menu">${icons.menu}</button><nav aria-label="Back-office">${links.map(([href,label,icon])=>`<a href="${href}" title="${label}">${icons[icon]}<span>${label}</span></a>`).join('')}<a href="/" target="_blank" rel="noopener" title="Portal público">${icons.external}<span>Portal público</span></a></nav><form method="post" action="/logout">${csrf(token)}<button class="secondary" title="Sair da conta">${icons.logout}<span>Sair</span></button></form></aside>`:'';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Ponto de Prova</title><link rel="stylesheet" href="/style.css"></head><body class="${admin?'backoffice':'public-site'}">${header}<div class="${admin?'bo-layout':''}">${navigation}<main>${notice}${body}</main></div>${admin?'<script src="/layout.js" defer></script>':''}</body></html>`;
}
export function input(label,name,value='',type='text',extra='') {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required ${extra}></label>`;
}
export function contestForm(c={},token='') {
  return `<div class="heading"><div><p class="eyebrow">ORGANIZAÇÃO</p><h1>${c.id?'Editar':'Novo'} concurso</h1><p>Reúna as informações para quem vai trabalhar no concurso. O cadastro é gratuito.</p></div></div><form class="panel form-grid" method="post">${csrf(token)}${input('Nome do concurso','title',c.title)}${input('Banca / organizadora','organizer',c.organizer)}<p class="wide">${c.id?`<a href="/admin/contests/${esc(c.id)}/roles">Gerenciar cargos, períodos, valores e quantidades</a>`:'Após salvar o concurso, cadastre os cargos com seus períodos, valores e quantidades.'}</p>${input('Local da prova','location',c.location)}${input('Link de informações do concurso','official_url',c.official_url,'url')}${input('Fim dos cadastros','deadline',c.deadline,'datetime-local')}${input('Horário de chegada','arrival',c.arrival,'datetime-local')}${input('Início da prova','starts',c.starts,'datetime-local')}${input('Término da prova','ends',c.ends,'datetime-local')}<label class="wide">Documentos, requisitos e orientações<textarea name="notes" rows="5">${esc(c.notes)}</textarea></label><p class="wide muted">Datas e horários no fuso de Brasília. Caso a banca ainda não tenha definido o local, informe “A definir”.</p><div class="wide"><button>Salvar concurso</button> <a class="button secondary" href="/admin">Cancelar</a></div></form>`;
}
export function cards(contests,admin=false) {
  return contests.length?`<div class="cards">${contests.map(c=>`<article class="panel contest-card"><div class="card-top"><span class="badge">${c.active?'Cadastros abertos':'Cadastros finalizados'}</span></div><p class="eyebrow">${esc(c.organizer)}</p><h2>${esc(c.title)}</h2><p class="contest-roles">${esc(c.role)||'Cargos em definição'}</p><div class="facts"><div><small>CADASTRO</small><strong>Gratuito</strong></div><div><small>VAGAS PREVISTAS</small><strong>${c.vacancies}</strong></div></div><p class="muted">⌖ ${esc(c.location)}</p><p class="muted">Cadastros até ${date(c.deadline)}</p><a class="card-link" href="${admin?'/admin/contests/':'/concursos/'}${c.id}">${admin?'Gerenciar concurso':'Ver informações e cadastrar'} <span>↗</span></a></article>`).join('')}</div>`:'<div class="panel empty"><h2>Nenhum concurso por aqui ainda</h2><p>Os concursos cadastrados aparecerão neste espaço.</p></div>';
}
export function table(headers,rows,empty='Nenhum registro encontrado.') {
  return rows.length?`<div class="table-wrap"><table><thead><tr>${headers.map(x=>`<th scope="col">${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((x,i)=>`<td data-label="${esc(headers[i])}">${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:`<div class="empty muted">${empty}</div>`;
}
