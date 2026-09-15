import { esc, input, csrf, table, money } from './views.js';
import { periods, roleIds } from './staffing.js';

export function roleSummary(roles) {
  return roles.length ? roles.map(r=>`${esc(r.name)} · ${periods[r.period]||'Período a definir'} · ${r.amount_cents===null?'Valor a definir':money(r.amount_cents/100)}`).join('<br>') : 'Aguardando definição dos cargos';
}

export function publicRoles(roles) {
  const ready=roles.filter(r=>r.period&&r.amount_cents!==null);
  return `<section class="role-section"><div class="section-heading"><h3>Cargos e vagas</h3><span class="muted">${ready.length} ${ready.length===1?'cargo':'cargos'}</span></div>
    <div class="role-list">${ready.length?ready.map(r=>`<article class="role-card"><div class="role-card-heading"><h4>${esc(r.name)}</h4><span class="period-badge">${periods[r.period]}</span></div><div class="role-card-facts"><div><span>Valor pelo trabalho</span><strong>${money(r.amount_cents/100)}</strong></div><div><span>Vagas previstas</span><strong>${r.quantity}</strong></div></div></article>`).join(''):'<p class="muted">O organizador ainda está definindo os cargos.</p>'}</div>
    <p class="role-note">O organizador atribuirá os cargos aos colaboradores após o cadastro.</p></section>`;
}

export function rolesPage(contest,roles,token,draft=null) {
  const periodSelect=r=>`<select name="period" required><option value="">Selecione</option>${Object.entries(periods).map(([v,label])=>`<option value="${v}" ${String(r.period)===v?'selected':''}>${label}</option>`).join('')}</select>`;
  const amount=r=>r.amount??(r.amount_cents==null?'':(r.amount_cents/100).toFixed(2));
  const row=r=>{
    const formId=`role-${r.id}`;
    return `<tr><td data-label="Cargo"><form id="${formId}" method="post" action="/admin/contests/${contest.id}/roles/${r.id}">${csrf(token)}</form><input form="${formId}" name="name" value="${esc(r.name)}" maxlength="150" required>${r.amount_cents===null&&r.legacy_amount?`<small>Remuneração anterior: ${esc(r.legacy_amount)}</small>`:''}</td><td data-label="Período"><select form="${formId}" name="period" required><option value="">Selecione</option>${Object.entries(periods).map(([v,label])=>`<option value="${v}" ${String(r.period)===v?'selected':''}>${label}</option>`).join('')}</select></td><td data-label="Valor"><input form="${formId}" name="amount" type="number" min="0" step="0.01" value="${esc(amount(r))}" required></td><td data-label="Vagas"><input form="${formId}" name="quantity" type="number" min="${r.assigned??0}" step="1" value="${esc(r.quantity)}" required><small>${r.assigned??0} vinculado${r.assigned===1?'':'s'}</small></td><td data-label="Ações"><button form="${formId}">Salvar</button><form method="post" action="/admin/contests/${contest.id}/roles/${r.id}/delete">${csrf(token)}<button class="text">Excluir</button></form></td></tr>`;
  };
  const draftRow=draft&&!draft.id?draft:{};
  return `<a class="back" href="/admin/contests/${contest.id}">← Gerenciar concurso</a><div class="contest-tabs"><a href="/admin/registrations?contest=${contest.id}">Colaboradores</a><a class="active" href="/admin/contests/${contest.id}/roles">Cargos</a><a href="/admin/contests/${contest.id}/rooms">Salas</a></div><div class="heading"><div><p class="eyebrow">CONFIGURAÇÃO</p><h1>Cargos — ${esc(contest.title)}</h1><p>Edite período, valor e vagas direto na tabela.</p></div></div>
    <section class="panel"><h2>Novo cargo</h2><form class="inline role-create" method="post" action="/admin/contests/${contest.id}/roles">${csrf(token)}${input('Cargo','name',draftRow.name??'','text','maxlength="150"')}<label>Período${periodSelect(draftRow)}</label>${input('Valor (R$)','amount',draftRow.amount??'','number','min="0" step="0.01"')}${input('Vagas','quantity',draftRow.quantity??'','number','min="0" step="1"')}<button>Adicionar</button></form></section>
    <section class="panel"><h2>Cargos cadastrados</h2>${roles.length?`<div class="table-wrap roles-table"><table><thead><tr><th>Cargo</th><th>Período</th><th>Valor</th><th>Vagas</th><th>Ações</th></tr></thead><tbody>${roles.map(r=>row(draft?.id===r.id?{...r,...draft}:r)).join('')}</tbody></table></div>`:'<div class="empty muted">Nenhum cargo cadastrado.</div>'}</section>`;
}

export function assignmentPage(person,contest,roles,selected,token) {
  const ids=roleIds(selected);
  return `<a class="back" href="/admin/registrations?contest=${contest.id}">← Colaboradores</a><h1>Cargos de ${esc(person.name)}</h1><p>${esc(contest.title)}</p>
    <p>Selecione os cargos do colaborador. Manhã e Tarde ocupa ambos os períodos; dois cargos só são permitidos quando um é de manhã e o outro à tarde. Desmarque todos para remover os vínculos.</p>
    <form class="panel" method="post">${csrf(token)}${roles.length?roles.map(r=>`<label class="check"><input type="checkbox" name="role_ids" value="${r.id}" ${ids.includes(r.id)?'checked':''} ${!r.period||r.amount_cents===null?'disabled':''}>
      <span>${roleSummary([r])}<small>${r.assigned} de ${r.quantity} vagas ocupadas</small></span></label>`).join(''):'<p>Nenhum cargo cadastrado neste concurso.</p>'}<button>Salvar vínculos</button></form>
    <p><a href="/admin/contests/${contest.id}/roles">Gerenciar cargos do concurso</a></p>`;
}

export function mountStaffing(app,db,service,page,guard,audit) {
  const contest=value=>db.prepare('SELECT * FROM contests WHERE id=?').get(value) || (()=>{throw new Error('Concurso não encontrado.');})();
  const person=value=>db.prepare('SELECT * FROM registrations WHERE id=?').get(value) || (()=>{throw new Error('Colaborador não encontrado.');})();
  app.get('/admin/contests/:id/roles',(req,res)=>page(req,res,'Cargos',rolesPage(contest(req.params.id),service.list(req.params.id),req.session.csrf)));
  const save=(req,res)=>{
    const c=contest(req.params.id);
    try {const r=service.save(c.id,req.body,req.params.role);audit('cargo.salvo',r.id);}
    catch(error){return page(req,res,'Cargos',rolesPage(c,service.list(c.id),req.session.csrf,{...req.body,id:req.params.role}),400,error.message);}
    res.redirect(`/admin/contests/${c.id}/roles`);
  };
  app.post('/admin/contests/:id/roles',save);
  app.post('/admin/contests/:id/roles/:role',save);
  app.post('/admin/contests/:id/roles/:role/delete',(req,res)=>{
    service.remove(req.params.id,req.params.role);audit('cargo.excluido',req.params.role);res.redirect(`/admin/contests/${req.params.id}/roles`);
  });
  app.get('/admin/registrations/:id/roles',(req,res)=>{
    const r=person(req.params.id),c=contest(r.contest_id);
    page(req,res,'Cargos do colaborador',assignmentPage(r,c,service.list(c.id),service.assigned(r.id).map(x=>x.id),req.session.csrf));
  });
  app.post('/admin/registrations/:id/roles',(req,res)=>{
    const r=person(req.params.id),c=contest(r.contest_id);
    try {service.assign(r.id,req.body.role_ids);audit('participante.cargos_atualizados',r.id);}
    catch(error){return page(req,res,'Cargos do colaborador',assignmentPage(r,c,service.list(c.id),req.body.role_ids,req.session.csrf),400,error.message);}
    res.redirect(`/admin/registrations?contest=${c.id}`);
  });
  app.use(['/api/concursos','/api/participantes'],guard);
  app.get('/api/concursos/:id/cargos',(req,res)=>{contest(req.params.id);res.json(service.list(req.params.id));});
  app.post('/api/concursos/:id/cargos',(req,res)=>{const r=service.save(req.params.id,req.body);audit('cargo.salvo',r.id);res.status(201).json(r);});
  app.put('/api/concursos/:id/cargos/:role',(req,res)=>{const r=service.save(req.params.id,req.body,req.params.role);audit('cargo.salvo',r.id);res.json(r);});
  app.delete('/api/concursos/:id/cargos/:role',(req,res)=>{service.remove(req.params.id,req.params.role);audit('cargo.excluido',req.params.role);res.json({ok:true});});
  app.put('/api/participantes/:id/cargos',(req,res)=>{const roles=service.assign(req.params.id,req.body.role_ids);audit('participante.cargos_atualizados',req.params.id);res.json(roles);});
}
