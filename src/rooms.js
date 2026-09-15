import { accessibleContests } from './accounts.js';
import { id } from './bot-service.js';
import { csrf, esc, input } from './views.js';
import { periods } from './staffing.js';
import { maskCpf } from './privacy.js';

const fail = message => { throw new Error(message); };
const formatCpf = value => String(value ?? '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/,'$1.$2.$3-$4');
const toArray = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
const messageText = plans => plans.map(room=>{
  const lines=[room.name];
  for(const role of room.roles) {
    lines.push('',role.name);
    if(role.assigned.length) for(const person of role.assigned) lines.push(person.name);
    else lines.push('Sem colaborador vinculado');
  }
  return lines.join('\n');
}).join('\n\n');

export function migrateRooms(db) {
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=8').get()) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (uuid()),
      contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contest_id,name)
    );
    CREATE INDEX idx_rooms_contest ON rooms(contest_id);
    CREATE TABLE room_roles (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL CHECK(quantity>0),
      PRIMARY KEY(room_id,role_id)
    );
    INSERT INTO schema_migrations(version) VALUES(8);
    COMMIT;`);
  if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=9').get()) return;
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE room_assignments (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY(registration_id,role_id)
    );
    CREATE INDEX idx_room_assignments_room ON room_assignments(room_id);
    INSERT INTO schema_migrations(version) VALUES(9);
    COMMIT;`);
}

export function rooms(db) {
  function transaction(fn) {
    db.exec('SAVEPOINT rooms');
    try { const result=fn(); db.exec('RELEASE rooms'); return result; }
    catch(error) { db.exec('ROLLBACK TO rooms; RELEASE rooms'); throw error; }
  }
  const contest = contestId => db.prepare(`SELECT * FROM contests WHERE id=? AND id IN (${accessibleContests()})`).get(contestId) || fail('Concurso não encontrado.');
  const list = contestId => db.prepare(`SELECT ro.*,
    (SELECT COALESCE(SUM(quantity),0) FROM room_roles WHERE room_id=ro.id) planned,
    (SELECT COUNT(*) FROM room_assignments WHERE room_id=ro.id) assigned
    FROM rooms ro WHERE ro.contest_id=? ORDER BY ro.name COLLATE NOCASE,ro.rowid`).all(contestId);
  const rolesFor = roomId => db.prepare(`SELECT r.*,rr.quantity room_quantity FROM room_roles rr JOIN roles r ON r.id=rr.role_id
    WHERE rr.room_id=? ORDER BY r.name COLLATE NOCASE,r.period,r.rowid`).all(roomId);
  function get(roomId) {
    const row=typeof roomId==='string' && db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId);
    return row || fail('Sala não encontrada.');
  }
  function save(contestId,body,roomId=null) {
    const c=contest(contestId),name=String(body.name??'').trim().replace(/\s+/g,' ');
    if(!name || name.length>100) fail('Informe o nome da sala com até 100 caracteres.');
    const roleIds=toArray(body.role_ids);
    const selectedPeople=toArray(body.assignments).map(value=>String(value).split('|')).filter(parts=>parts.length===2);
    return transaction(()=>{
      let target=roomId;
      if(target) {
        const room=get(target);
        if(room.contest_id!==c.id) fail('Sala não pertence ao concurso.');
        db.prepare('UPDATE rooms SET name=? WHERE id=?').run(name,target);
        db.prepare('DELETE FROM room_roles WHERE room_id=?').run(target);
        db.prepare('DELETE FROM room_assignments WHERE room_id=?').run(target);
      } else target=db.prepare('INSERT INTO rooms(contest_id,name) VALUES(?,?) RETURNING id').get(c.id,name).id;
      const roomRoles=new Set();
      for(let i=0;i<roleIds.length;i++) {
        const roleId=String(roleIds[i]??'');
        const quantity=Number(body[`quantity_${roleId}`]);
        if(!roleId && !quantity) continue;
        const role=db.prepare('SELECT * FROM roles WHERE id=? AND contest_id=?').get(roleId,c.id);
        if(!role) fail('Selecione somente cargos deste concurso.');
        if(!Number.isSafeInteger(quantity) || quantity<1) fail('Informe a quantidade de cada cargo da sala.');
        db.prepare('INSERT INTO room_roles(room_id,role_id,quantity) VALUES(?,?,?)').run(target,roleId,quantity);
        roomRoles.add(roleId);
      }
      const counts=new Map();
      for(const [registrationId,roleId] of selectedPeople) {
        if(!roomRoles.has(roleId)) fail('Selecione o cargo da sala antes de vincular colaboradores nele.');
        const person=db.prepare(`SELECT 1 FROM registration_roles rr JOIN registrations r ON r.id=rr.registration_id
          WHERE rr.registration_id=? AND rr.role_id=? AND r.contest_id=?`).get(registrationId,roleId,c.id);
        if(!person) fail('Selecione somente colaboradores vinculados aos cargos desta sala.');
        counts.set(roleId,(counts.get(roleId)||0)+1);
      }
      for(const [roleId,count] of counts) {
        const limit=db.prepare('SELECT quantity FROM room_roles WHERE room_id=? AND role_id=?').get(target,roleId)?.quantity||0;
        if(count>limit) fail('Há mais colaboradores vinculados do que vagas configuradas na sala.');
      }
      for(const [registrationId,roleId] of selectedPeople) {
        db.prepare('DELETE FROM room_assignments WHERE registration_id=? AND role_id=?').run(registrationId,roleId);
        db.prepare('INSERT INTO room_assignments(room_id,registration_id,role_id) VALUES(?,?,?)').run(target,registrationId,roleId);
      }
      return get(target);
    });
  }
  function createBatch(contestId,body) {
    const c=contest(contestId),count=Number(body.count),prefix=String(body.prefix??'Sala').trim().replace(/\s+/g,' ')||'Sala';
    if(!Number.isSafeInteger(count) || count<1 || count>200) fail('Informe uma quantidade de salas entre 1 e 200.');
    const roleIds=toArray(body.role_ids);
    return transaction(()=>{
      const created=[];
      for(let i=1;i<=count;i++) {
        const name=`${prefix} ${i}`;
        const existing=db.prepare('SELECT id FROM rooms WHERE contest_id=? AND name=?').get(c.id,name);
        if(existing) continue;
        const roomId=db.prepare('INSERT INTO rooms(contest_id,name) VALUES(?,?) RETURNING id').get(c.id,name).id;
        for(const roleId of roleIds) {
          const role=db.prepare('SELECT * FROM roles WHERE id=? AND contest_id=?').get(String(roleId),c.id);
          if(!role) fail('Selecione somente cargos deste concurso.');
          const quantity=Number(body[`quantity_${role.id}`]);
          if(!Number.isSafeInteger(quantity) || quantity<1) fail('Informe a quantidade de cada cargo da sala.');
          db.prepare('INSERT INTO room_roles(room_id,role_id,quantity) VALUES(?,?,?)').run(roomId,role.id,quantity);
        }
        created.push(roomId);
      }
      return created;
    });
  }
  function remove(contestId,roomId) {
    const c=contest(contestId),room=get(roomId);
    if(room.contest_id!==c.id) fail('Sala não pertence ao concurso.');
    db.prepare('DELETE FROM rooms WHERE id=?').run(roomId);
  }
  function plan(contestId) {
    const c=contest(contestId),roomList=list(c.id);
    return roomList.map(room=>{
      const roles=rolesFor(room.id).map(role=>{
        const assigned=db.prepare(`SELECT r.* FROM room_assignments ra JOIN registrations r ON r.id=ra.registration_id
          WHERE ra.room_id=? AND ra.role_id=? ORDER BY r.name COLLATE NOCASE,r.created_at`).all(room.id,role.id);
        return {...role,assigned};
      });
      return {...room,roles};
    });
  }
  function assignmentOptions(contestId,roomId) {
    return db.prepare(`SELECT r.id registration_id,r.name,r.cpf_full,r.cpf_final,rr.role_id,ro.name role_name,ra.room_id assigned_room_id,room.name assigned_room_name
      FROM registration_roles rr JOIN registrations r ON r.id=rr.registration_id JOIN roles ro ON ro.id=rr.role_id
      LEFT JOIN room_assignments ra ON ra.registration_id=r.id AND ra.role_id=rr.role_id
      LEFT JOIN rooms room ON room.id=ra.room_id
      WHERE r.contest_id=? AND rr.role_id IN (SELECT role_id FROM room_roles WHERE room_id=?)
        AND (ra.room_id IS NULL OR ra.room_id=?)
      ORDER BY ro.name COLLATE NOCASE,r.name COLLATE NOCASE,r.created_at`).all(contestId,roomId,roomId);
  }
  return {list,rolesFor,get,save,createBatch,remove,plan,assignmentOptions};
}

export function mountRooms(app,db,service,page,audit) {
  const roleOptions = contestId => db.prepare(`SELECT * FROM roles WHERE contest_id=? ORDER BY name COLLATE NOCASE,period,rowid`).all(contestId);
  function roomForm(contest,roles,room={},assigned=[]) {
    const selected=new Map(assigned.map(r=>[r.id,r.room_quantity]));
    const assignmentRows=room.id?service.assignmentOptions(contest.id,room.id):[];
    const assignmentList=assignmentRows.length?assignmentRows.map(person=>{
      const checked=person.assigned_room_id===room.id;
      const note=person.assigned_room_id&&person.assigned_room_id!==room.id?`<small>Hoje em ${esc(person.assigned_room_name)}</small>`:'';
      return `<label class="room-person-row"><input type="checkbox" name="assignments" value="${person.registration_id}|${person.role_id}" ${checked?'checked':''}><span>${esc(person.name)}<small>${esc(person.role_name)} · ${esc(person.cpf_full?formatCpf(person.cpf_full):person.cpf_final?maskCpf(person.cpf_final):'CPF não informado')}</small>${note}</span></label>`;
    }).join(''):'<p class="muted">Salve a sala com cargos para depois vincular colaboradores.</p>';
    return `<form class="room-modal-form" method="post" action="/admin/contests/${contest.id}/rooms${room.id?`/${room.id}`:''}">${csrf(contest.csrf)}
      ${input(room.id?'Nome da sala':'Nome ou prefixo da sala','name',room.name??'','text','maxlength="100"')}
      ${room.id?'':`<label>Quantidade de salas<input name="count" type="number" value="" min="1" max="200" step="1"></label><small>Preencha a quantidade para criar Sala 1, Sala 2... Deixe vazio para criar só uma sala com o nome informado.</small>`}
      <div class="room-role-picker">${roles.length?roles.map(r=>`<label class="room-role-card"><input type="checkbox" name="role_ids" value="${r.id}" ${selected.has(r.id)?'checked':''}><span>${esc(r.name)}<small>${periods[r.period]||'Período a definir'}</small></span><input name="quantity_${r.id}" type="number" min="1" step="1" value="${esc(selected.get(r.id)??1)}" aria-label="Quantidade de ${esc(r.name)}"></label>`).join(''):'<p>Nenhum cargo cadastrado ainda.</p>'}</div>
      ${room.id?`<h3>Colaboradores da sala</h3><div class="room-person-list">${assignmentList}</div>`:''}
      <div class="modal-actions"><button>${room.id?'Salvar sala':'Adicionar'}</button><button class="secondary" type="button" data-close-dialog>Cancelar</button></div></form>`;
  }
  function roomsPage(req,res,contest,draft=null,error='') {
    const roles=roleOptions(contest.id),roomList=service.list(contest.id);
    contest={...contest,csrf:req.session.csrf};
    const composition=room=>service.rolesFor(room.id).map(r=>`<span>${esc(r.name)} <strong>${r.room_quantity}</strong></span>`).join('') || '<span>Sem cargos definidos</span>';
    const cards=roomList.length?`<div class="room-grid">${roomList.map(room=>`<article class="room-card"><div><h2>${esc(room.name)}</h2><p>${room.assigned}/${room.planned} colaborador${room.planned===1?'':'es'}</p></div><div class="room-composition">${composition(room)}</div><div class="room-card-actions"><button class="secondary" type="button" data-open-dialog="room-${room.id}">Editar</button><form method="post" action="/admin/contests/${contest.id}/rooms/${room.id}/delete">${csrf(req.session.csrf)}<button class="text">Excluir</button></form></div></article><dialog class="room-dialog" id="room-${room.id}"><h2>Editar sala</h2>${roomForm(contest,roles,draft?.id===room.id?{...room,...draft}:room,draft?.id===room.id?[]:service.rolesFor(room.id))}</dialog>`).join('')}</div>`:'<div class="empty muted">Nenhuma sala cadastrada.</div>';
    return page(req,res,'Salas',`<a class="back" href="/admin/contests/${contest.id}">← Gerenciar concurso</a><div class="contest-tabs"><a href="/admin/registrations?contest=${contest.id}">☰ Colaboradores</a><a href="/admin/contests/${contest.id}/roles">◎ Cargos</a><a class="active" href="/admin/contests/${contest.id}/rooms">▦ Salas</a></div><section class="panel rooms-panel"><div class="room-header"><div><p class="eyebrow">DISTRIBUIÇÃO</p><h1>Salas</h1><p>${roomList.length} sala${roomList.length===1?'':'s'}</p></div><div class="room-actions"><button type="button" data-open-dialog="new-room">Adicionar sala</button><a class="icon-action" href="/admin/contests/${contest.id}/rooms/message" title="Mensagem para WhatsApp" aria-label="Mensagem para WhatsApp">☰</a><a class="icon-action" href="/admin/contests/${contest.id}/rooms/print" title="Imprimir salas" aria-label="Imprimir salas">⎙</a></div></div>${cards}</section><dialog class="room-dialog" id="new-room"><h2>Adicionar sala</h2>${roomForm(contest,roles,draft&&!draft.id?draft:{})}</dialog><script src="/rooms.js" defer></script>`,error?400:200,error);
  }
  const contest=value=>db.prepare(`SELECT * FROM contests WHERE id=? AND id IN (${accessibleContests()})`).get(id(value)) || fail('Concurso não encontrado.');
  app.get('/admin/contests/:id/rooms',(req,res)=>roomsPage(req,res,{...contest(req.params.id)},null,''));
  app.post('/admin/contests/:id/rooms',(req,res)=>{
    const c=contest(req.params.id);
    try {
      if(String(req.body.count??'').trim()) { service.createBatch(c.id,{...req.body,prefix:req.body.name}); audit('salas.criadas',c.id); }
      else { const room=service.save(c.id,req.body); audit('sala.salva',room.id); }
      res.redirect(`/admin/contests/${c.id}/rooms`);
    }
    catch(error) { roomsPage(req,res,c,req.body,error.message); }
  });
  app.post('/admin/contests/:id/rooms/batch',(req,res)=>{
    const c=contest(req.params.id),created=service.createBatch(c.id,req.body);
    audit('salas.criadas',c.id); res.redirect(`/admin/contests/${c.id}/rooms`);
  });
  app.post('/admin/contests/:id/rooms/:room',(req,res)=>{
    const c=contest(req.params.id);
    try { const room=service.save(c.id,req.body,req.params.room); audit('sala.salva',room.id); res.redirect(`/admin/contests/${c.id}/rooms`); }
    catch(error) { roomsPage(req,res,c,{...req.body,id:req.params.room},error.message); }
  });
  app.post('/admin/contests/:id/rooms/:room/delete',(req,res)=>{
    const c=contest(req.params.id); service.remove(c.id,req.params.room); audit('sala.excluida',req.params.room); res.redirect(`/admin/contests/${c.id}/rooms`);
  });
  app.get('/admin/contests/:id/rooms/message',(req,res)=>{
    const c=contest(req.params.id),plans=service.plan(c.id),text=messageText(plans);
    page(req,res,'Mensagem de ensalamento',`<a class="back" href="/admin/contests/${c.id}/rooms">← Voltar às salas</a><section class="panel room-message-panel"><div class="section-heading"><div><p class="eyebrow">WHATSAPP</p><h1>Mensagem de ensalamento</h1><p class="muted">Texto pronto para copiar e colar no WhatsApp.</p></div><button class="secondary" type="button" data-copy-room-message>Copiar mensagem</button></div><textarea class="room-message-box" id="room-message" readonly rows="18">${esc(text||'Nenhuma sala cadastrada.')}</textarea></section><script src="/rooms.js" defer></script>`);
  });
  app.get('/admin/contests/:id/rooms/print',(req,res)=>{
    const c=contest(req.params.id),plans=service.plan(c.id);
    const css=`@page{margin:9mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#18251f;margin:0;background:#eef4f1}.actions{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px auto;max-width:980px;padding:0 12px}.actions a,.actions button{font:700 14px Arial;color:#164f45}.actions button{border:1px solid #164f45;background:#fff;border-radius:7px;padding:10px 14px}.print-sheet{max-width:980px;margin:0 auto 18px;background:#fff;border:1px solid #c9d8d1;border-radius:12px;overflow:hidden;box-shadow:0 14px 36px #172f3814;break-after:page;page-break-after:always}.print-sheet:last-child{break-after:auto;page-break-after:auto}.print-head{display:flex;justify-content:space-between;gap:16px;padding:18px 22px;background:#174f45;color:#fff}.print-head p{margin:0}.eyebrow{font-size:10px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#bdd9cd}.print-head h1{font-size:25px;line-height:1.1;margin:4px 0 5px;text-transform:uppercase}.print-head .contest{font-size:13px;color:#e5f2ec}.summary{display:grid;grid-template-columns:repeat(2,minmax(82px,1fr));gap:8px;min-width:210px}.summary div{border:1px solid #ffffff55;border-radius:8px;padding:8px 10px;text-align:center}.summary span{display:block;font-size:10px;color:#cfe3da;text-transform:uppercase}.summary strong{display:block;font-size:20px;margin-top:2px}.room-body{padding:16px 22px 20px}.role-block{border:1px solid #d8e4de;border-radius:10px;margin:0 0 14px;overflow:hidden;break-inside:avoid;page-break-inside:avoid}.role-title{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#eef5f1;border-bottom:1px solid #d8e4de;padding:11px 14px}.role-title h2{font-size:15px;margin:0;color:#153f38}.role-title span{font-size:12px;font-weight:800;color:#315c51;background:#fff;border:1px solid #c8d8d1;border-radius:999px;padding:4px 9px;white-space:nowrap}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #dce6e1;padding:8px 10px;vertical-align:middle}th{background:#f8fbf9;color:#335d52;font-size:10px;text-transform:uppercase;letter-spacing:.4px}th:nth-child(1),td:nth-child(1){width:135px}th:nth-child(3),td:nth-child(3){width:155px}tbody tr:nth-child(even){background:#fbfdfc}tbody tr:last-child td{border-bottom:0}.missing{color:#78877f}.signature{height:24px;border-bottom:1px solid #9eaaa4}.empty-room{padding:28px 22px;color:#66766e}.print-foot{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #d8e4de;padding:10px 22px;color:#66766e;font-size:11px;background:#fbfdfc}@media print{body{background:#fff}.actions{display:none!important}.print-sheet{max-width:none;margin:0;border:0;border-radius:0;box-shadow:none}.print-head{print-color-adjust:exact;-webkit-print-color-adjust:exact}.role-title,th,tbody tr:nth-child(even),.print-foot{print-color-adjust:exact;-webkit-print-color-adjust:exact}}`;
    const roleHtml=role=>`<section class="role-block"><div class="role-title"><h2>${esc(role.name)}</h2><span>${role.assigned.length}/${role.room_quantity}</span></div><table><thead><tr><th>CPF</th><th>Nome</th><th>Assinatura</th></tr></thead><tbody>${role.assigned.map(person=>`<tr><td>${esc(person.cpf_full?formatCpf(person.cpf_full):person.cpf_final?maskCpf(person.cpf_final):'')}</td><td>${esc(person.name)}</td><td><div class="signature"></div></td></tr>`).join('')}${Array.from({length:Math.max(0,role.room_quantity-role.assigned.length)},()=>'<tr class="missing"><td></td><td>Vaga sem colaborador</td><td><div class="signature"></div></td></tr>').join('')}</tbody></table></section>`;
    const sheet=room=>{const total=room.roles.reduce((sum,role)=>sum+role.room_quantity,0),assigned=room.roles.reduce((sum,role)=>sum+role.assigned.length,0);return `<section class="print-sheet"><header class="print-head"><div><p class="eyebrow">ENSALAMENTO</p><h1>${esc(room.name)}</h1><p class="contest">${esc(c.title)} · ${esc(c.organizer)}</p></div><div class="summary"><div><span>Cargos</span><strong>${room.roles.length}</strong></div><div><span>Equipe</span><strong>${assigned}/${total}</strong></div></div></header><div class="room-body">${room.roles.length?room.roles.map(roleHtml).join(''):'<div class="empty-room">Nenhum cargo configurado para esta sala.</div>'}</div><footer class="print-foot"><span>${esc(c.location)}</span><span>Impresso pelo Ponto de Prova</span></footer></section>`};
    const body=`<div class="actions"><a href="/admin/contests/${c.id}/rooms">Voltar</a><button onclick="window.print()">Imprimir salas</button></div>${plans.length?plans.map(sheet).join(''):'<section class="print-sheet"><div class="empty-room"><h1>Nenhuma sala cadastrada.</h1></div></section>'}`;
    res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Impressão de salas · Ponto de Prova</title><style>${css}</style></head><body>${body}</body></html>`);
  });
}
