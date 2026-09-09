import { esc, input, csrf, table, money } from './views.js';
import { periods, roleIds } from './staffing.js';

export function roleSummary(roles) {
  return roles.length ? roles.map(r=>`${esc(r.name)} · ${periods[r.period]||'Período a definir'} · ${r.amount_cents===null?'Valor a definir':money(r.amount_cents/100)}`).join('<br>') : 'Aguardando definição dos cargos';
}

export function publicRoles(roles) {
  return `<h3>Cargos de trabalho</h3>${table(['Cargo','Período','Valor','Quantidade'],roles.filter(r=>r.period&&r.amount_cents!==null).map(r=>[esc(r.name),periods[r.period],money(r.amount_cents/100),r.quantity]),'O organizador ainda está definindo os cargos.')}<p>O organizador atribuirá os cargos aos colaboradores após o cadastro.</p>`;
}

export function rolesPage(contest,roles,token,draft=null) {
  const form=(r={})=>`<form class="panel form-grid" method="post" action="/admin/contests/${contest.id}/roles${r.id?'/'+r.id:''}">
    ${csrf(token)}${input('Nome do cargo','name',r.name??'','text','maxlength="150"')}
    <label>Período<select name="period" required><option value="">Selecione</option>${Object.entries(periods).map(([v,label])=>`<option value="${v}" ${String(r.period)===v?'selected':''}>${label}</option>`).join('')}</select></label>
    ${input('Valor pelo trabalho (R$)','amount',r.amount??(r.amount_cents==null?'':(r.amount_cents/100).toFixed(2)),'number','min="0" step="0.01"')}
    ${input('Quantidade de vagas','quantity',r.quantity??'','number','min="0" step="1"')}
    ${r.amount_cents===null&&r.legacy_amount?`<p>Remuneração informada anteriormente: ${esc(r.legacy_amount)}. Informe o valor deste cargo acima.</p>`:''}
    ${r.id?`<p>${r.assigned??0} colaboradores vinculados.${!r.period||r.amount_cents===null?' Complete o período e o valor para permitir vínculos.':''}</p>`:''}
    <button>${r.id?'Salvar alterações':'Adicionar cargo'}</button></form>
    ${r.id?`<form method="post" action="/admin/contests/${contest.id}/roles/${r.id}/delete">${csrf(token)}<button class="text">Excluir cargo</button></form>`:''}`;
  return `<a class="back" href="/admin/contests/${contest.id}">← Gerenciar concurso</a><h1>Cargos — ${esc(contest.title)}</h1>
    <p>Cadastre cada função com seu período, valor e quantidade. Os vínculos dos colaboradores são definidos pelo organizador.</p>
    ${roles.map(r=>form(draft?.id===r.id?{...r,...draft}:r)).join('')}<h2>Novo cargo</h2>${form(draft&&!draft.id?draft:{})}`;
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
