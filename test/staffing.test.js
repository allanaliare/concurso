import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/db.js';
import { staffing } from '../src/staffing.js';
import { rooms as roomService } from '../src/rooms.js';
import { contest, fields } from '../src/validation.js';
import { createApp } from '../src/app.js';

const config={adminPassword:'password-for-tests',sessionSecret:'s'.repeat(40),cpfSecret:'h'.repeat(40),baseUrl:'http://localhost'};
const contestBody={title:'Equipe de trabalho',organizer:'Banca',location:'Escola',arrival:'2026-12-01T07:00',starts:'2026-12-01T08:00',ends:'2026-12-01T18:00',deadline:'2026-11-01T12:00',official_url:'https://example.com',notes:''};
function fixture() {
  const db=database(':memory:'),s=staffing(db);
  const c=contest(contestBody);
  const insertContest=()=>db.prepare(`INSERT INTO contests(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')}) RETURNING id`).get(...fields.map(k=>c[k])).id;
  const contestId=insertContest();
  const person=name=>db.prepare("INSERT INTO registrations(contest_id,name,cpf,phone,source) VALUES(?,?,?,?, 'formulario') RETURNING id").get(contestId,name,name,'11999999999').id;
  const a=person('Pessoa A'),b=person('Pessoa B');
  const role=(name,period,quantity=1)=>s.save(contestId,{name,period,quantity,amount:'150,50'});
  return {db,s,contestId,insertContest,a,b,role};
}

test('cargos permitem manhã + tarde e rejeitam todos os períodos sobrepostos sem perder vínculos',()=>{
  const {db,s,contestId,a,role}=fixture();
  try {
    const morning=role('Fiscal',1),afternoon=role('Apoio',2),allDay=role('Coordenador',3),otherMorning=role('Recepção',1);
    assert.equal(morning.amount_cents,15050);
    assert.match(morning.id,/^[0-9a-f-]{36}$/);
    s.assign(a,[morning.id,afternoon.id]);
    for(const ids of [[morning.id,otherMorning.id],[morning.id,allDay.id],[allDay.id,afternoon.id],[morning.id,morning.id]]) {
      assert.throws(()=>s.assign(a,ids),/períodos|sobrepostos/);
      assert.deepEqual(s.assigned(a).map(r=>r.id),[morning.id,afternoon.id]);
    }
    s.assign(a,[allDay.id]);
    assert.equal(s.assigned(a).length,1);
    assert.throws(()=>s.save(contestId,{name:'X',period:4,amount:'10',quantity:1}),/Selecione/);
    assert.throws(()=>s.save(contestId,{name:'X',period:1,amount:'10.001',quantity:1}),/valor/);
    assert.throws(()=>s.save(contestId,{name:'X',period:1,amount:'10',quantity:1.5}),/quantidade/);
  } finally {db.close();}
});

test('quantidade, edição de período, exclusão e isolamento entre concursos',()=>{
  const {db,s,contestId,insertContest,a,b,role}=fixture();
  try {
    const morning=role('Fiscal',1),afternoon=role('Apoio',2);
    s.assign(a,[morning.id,afternoon.id]);
    s.assign(a,[morning.id,afternoon.id]); // Saving the same links must not consume another slot.
    assert.throws(()=>s.assign(b,[morning.id]),/Não há vagas/);
    assert.equal(s.assigned(b).length,0);
    assert.throws(()=>s.save(contestId,{name:morning.name,period:1,amount:150,quantity:0},morning.id),/já tem/);
    assert.throws(()=>s.save(contestId,{name:afternoon.name,period:1,amount:150,quantity:1},afternoon.id),/conflito/);
    assert.equal(s.get(afternoon.id).period,2);
    assert.throws(()=>s.remove(contestId,morning.id),/vínculos/);
    const other=s.save(insertContest(),{name:'Outro concurso',period:1,amount:10,quantity:2});
    assert.throws(()=>s.assign(b,[other.id]),/deste concurso/);
    assert.throws(()=>s.remove(contestId,other.id),/não pertence/);
    s.assign(a,[]);
    s.assign(b,[morning.id]);
    db.prepare('DELETE FROM registrations WHERE id=?').run(b);
    assert.equal(s.list(contestId).find(r=>r.id===morning.id).assigned,0);
    s.remove(contestId,morning.id);
    assert.throws(()=>s.get(morning.id),/não encontrado/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.close();}
});

test('painel cadastra cargos e atribui colaboradores; visitante não escolhe cargos',async()=>{
  const {db,s,contestId,a,b}=fixture();
  const server=createApp(config,db).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='',token='';
  async function request(path,data) {
    const form=new URLSearchParams({_csrf:token});
    for(const [key,value] of Object.entries(data||{})) for(const item of Array.isArray(value)?value:[value]) form.append(key,item);
    const res=await fetch(base+path,{redirect:'manual',headers:{cookie,...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(data?{method:'POST',body:form}:{})});
    cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
    const text=await res.text();token=text.match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
    return {res,text};
  }
  try {
    assert.equal((await request(`/admin/contests/${contestId}/roles`)).res.status,302);
    await request('/login');
    assert.equal((await request(`/admin/registrations/${a}/roles`,{role_ids:'fake'})).res.status,302);
    await request('/login',{username:'admin',password:config.adminPassword});
    await request('/admin');
    const manualUrl=`/admin/contests/${contestId}/registrations/new`;
    assert.equal((await request(manualUrl,{name:'Cadastro parcial'})).res.status,302);
    assert.equal((await request(manualUrl,{name:'Outro cadastro parcial'})).res.status,302);
    const partial=db.prepare("SELECT * FROM registrations WHERE name='Cadastro parcial'").get();
    assert.equal(partial.cpf_full,null);
    assert.equal(partial.phone,'');
    assert.equal(partial.pix_key,null);
    assert.equal((await request(`/admin/registrations/${partial.id}/edit`,{name:'Cadastro completo',cpf:'11111111111'})).res.status,400);
    assert.equal((await request(`/admin/registrations/${partial.id}/edit`,{name:'Cadastro completo',cpf:'111.444.777-35'})).res.status,302);
    assert.equal(db.prepare('SELECT cpf_full FROM registrations WHERE id=?').get(partial.id).cpf_full,'11144477735');
    assert.equal((await request(manualUrl,{name:'Duplicado',cpf:'11144477735'})).res.status,400);
    assert.equal((await request(manualUrl,{name:''})).res.status,400);
    assert.match((await request('/admin/registrations')).text,/11144477735/);
    assert.doesNotMatch((await request(`/concursos/${contestId}`)).text,/11144477735/);
    const form=await request('/admin/contests/new');
    assert.doesNotMatch(form.text,/name="(role|salary|vacancies)"/);
    const url=`/admin/contests/${contestId}/roles`;
    assert.equal((await request(url,{name:'Fiscal',period:1,quantity:1,amount:100})).res.status,302);
    assert.equal((await request(url,{name:'Apoio',period:2,quantity:1,amount:200})).res.status,302);
    const morning=s.list(contestId).find(r=>r.period===1),afternoon=s.list(contestId).find(r=>r.period===2);
    assert.match((await request(url)).text,/Fiscal/);
    const publicPage=await request(`/concursos/${contestId}`);
    assert.match(publicPage.text,/O organizador atribuirá/);
    assert.doesNotMatch(publicPage.text,/name="role_ids"/);
    assert.equal((await request(`/admin/registrations/${a}/roles`,{role_ids:[morning.id,afternoon.id]})).res.status,302);
    assert.equal(s.assigned(a).length,2);
    const registrations=await request(`/admin/registrations?contest=${contestId}`);
    assert.match(registrations.text,/Fiscal · Manhã/);
    assert.match(registrations.text,/Imprimir lista/);
    assert.match(registrations.text,/Imprimir guias de pagamento/);
    assert.match(registrations.text,/Cadastrar colaborador/);
    assert.match(registrations.text,/Importar colaboradores/);
    assert.match(registrations.text,/Sem cargo definido/);
    assert.match(registrations.text,/CPF/);
    assert.match(registrations.text,/Nome/);
    assert.match(registrations.text,/Cargo/);
    assert.equal((await request(`/admin/registrations/${b}/roles`,{role_ids:morning.id})).res.status,400);
    assert.equal((await request(`${url}/${afternoon.id}`,{name:'Apoio',period:1,quantity:1,amount:200})).res.status,400);
    assert.equal((await request(`/admin/contests/${contestId}/edit`,contestBody)).res.status,302);
    assert.equal(db.prepare('SELECT vacancies FROM contests WHERE id=?').get(contestId).vacancies,2);
    // The public form ignores injected role IDs; allocation is an administrator action.
    const signup=await request(`/concursos/${contestId}/confirmar`,{name:'Pessoa nova',cpf:'52998224725',phone:'11999999999',pix_type:'email',pix_key:'pessoa@example.com',consent:'yes',role_ids:morning.id});
    assert.equal(signup.res.status,200);
    const newPerson=db.prepare("SELECT id FROM registrations WHERE name='Pessoa nova'").get();
    assert.equal(s.assigned(newPerson.id).length,0);
    const withoutRole=await request(`/admin/registrations?contest=${contestId}&role=none`);
    assert.match(withoutRole.text,/Pessoa nova/);
    assert.doesNotMatch(withoutRole.text,/Pessoa A/);
    const byRole=await request(`/admin/registrations?contest=${contestId}&role=${morning.id}`);
    assert.match(byRole.text,/Pessoa A/);
    assert.doesNotMatch(byRole.text,/Pessoa nova/);
    const print=await request(`/admin/contests/${contestId}/registrations/print`);
    assert.equal(print.res.status,200);
    assert.match(print.text,/LISTA DE PAGAMENTO/);
    assert.match(print.text,/<th scope="col">CPF<\/th><th scope="col">Nome<\/th><th scope="col">Pix<\/th><th scope="col">QR Code<\/th>/);
    assert.match(print.text,/Pessoa nova/);
    assert.doesNotMatch(print.text,/<th scope="col">Pago<\/th>/);
    assert.doesNotMatch(print.text,/<th scope="col">WhatsApp<\/th>/);
    assert.doesNotMatch(print.text,/<th scope="col">Grupo<\/th>/);
    const receipts=await request(`/admin/contests/${contestId}/registrations/receipts`);
    assert.equal(receipts.res.status,200);
    assert.match(receipts.text,/Escolha os colaboradores/);
    assert.match(receipts.text,/Buscar por nome/);
    assert.match(receipts.text,/Selecionar todos/);
    assert.match(receipts.text,/receipt-picker\.js/);
    assert.doesNotMatch(receipts.text,/Marcar todos/);
    assert.doesNotMatch(receipts.text,/Desmarcar todos/);
    assert.match(receipts.text,/Não vinculados/);
    assert.match(receipts.text,/Vinculados/);
    const selectedReceipts=await request(`/admin/contests/${contestId}/registrations/receipts/print`,{selected:a});
    assert.equal(selectedReceipts.res.status,200);
    assert.match(selectedReceipts.text,/COMANDA DE PAGAMENTO/);
    assert.match(selectedReceipts.text,/Pessoa A/);
    assert.doesNotMatch(selectedReceipts.text,/Pessoa B/);
    assert.match(selectedReceipts.text,/Equipe de trabalho/);
    assert.match(selectedReceipts.text,/R\$\s*300,00/);
    assert.match(selectedReceipts.text,/@page\{size:80mm auto/);
    assert.match(selectedReceipts.text,/Imprimir comandas 80mm/);
    assert.match(selectedReceipts.text,/cortar aqui/);
    assert.equal((await request(`/admin/registrations/${a}/roles`,{})).res.status,302);
    assert.equal(s.assigned(a).length,0);
    assert.equal((await request(`/admin/registrations/${b}/roles`,{role_ids:morning.id,_csrf:'bad'})).res.status,403);
  } finally {await new Promise(r=>server.close(r));db.close();}
});

test('painel importa colaboradores com cargo e Pix CPF sem duplicar registros',async()=>{
  const {db,s,contestId}=fixture();
  const server=createApp(config,db).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='',token='';
  async function request(path,data) {
    const form=new URLSearchParams({_csrf:token});
    for(const [key,value] of Object.entries(data||{})) form.append(key,value);
    const res=await fetch(base+path,{redirect:'manual',headers:{cookie,...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(data?{method:'POST',body:form}:{})});
    cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
    const text=await res.text();token=text.match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
    return {res,text};
  }
  try {
    await request('/login');
    await request('/login',{username:'admin',password:config.adminPassword});
    const importUrl=`/admin/contests/${contestId}/registrations/import`;
    assert.match((await request(importUrl)).text,/cpf;nome;cargo/);
    const content=[
      '529.982.247-25;Pessoa Importada;Fiscal de sala',
      '52998224725;Pessoa Duplicada;Fiscal de sala',
      '111.444.777-35;Pessoa Apoio; fiscal de sala ',
      '123;Pessoa Erro;Apoio'
    ].join('\n');
    const imported=await request(importUrl,{content});
    assert.equal(imported.res.status,200);
    assert.match(imported.text,/Importados<\/span><strong>2<\/strong>/);
    assert.match(imported.text,/Ignorados<\/span><strong>1<\/strong>/);
    assert.match(imported.text,/CPF inválido/);
    assert.match(imported.text,/Cargos cadastrados automaticamente: Fiscal de sala/);
    const rows=db.prepare('SELECT * FROM registrations WHERE contest_id=? AND source=? ORDER BY name').all(contestId,'importacao');
    assert.equal(rows.length,2);
    assert.deepEqual(rows.map(r=>r.pix_type),['cpf','cpf']);
    assert.deepEqual(rows.map(r=>r.pix_key),['11144477735','52998224725']);
    assert.deepEqual(rows.map(r=>r.phone),['','']);
    assert.equal(s.list(contestId).filter(r=>r.name.toLowerCase()==='fiscal de sala').length,1);
    const role=s.list(contestId).find(r=>r.name==='Fiscal de sala');
    assert.equal(role.period,null);
    assert.equal(role.amount_cents,null);
    assert.equal(role.assigned,2);
    assert.equal(s.assigned(rows[0].id)[0].id,role.id);
    assert.equal(db.prepare('SELECT role FROM contests WHERE id=?').get(contestId).role,'Fiscal de sala');
    assert.match((await request(`/admin/contests/${contestId}/roles`)).text,/min="2"/);
    assert.equal((await request(`/admin/contests/${contestId}/roles/${role.id}`,{name:'Fiscal de sala',period:1,amount:'180.75',quantity:5})).res.status,302);
    const updated=s.get(role.id);
    assert.equal(updated.period,1);
    assert.equal(updated.amount_cents,18075);
    assert.equal(updated.quantity,5);
    assert.equal(updated.name,'Fiscal de sala');
    assert.equal(s.assigned(rows[0].id)[0].id,role.id);
    assert.equal(db.prepare('SELECT vacancies FROM contests WHERE id=?').get(contestId).vacancies,5);
    assert.equal((await request(`/admin/contests/${contestId}/roles`,{name:'Apoio extra',period:2,amount:'90',quantity:1})).res.status,302);
    const extra=s.list(contestId).find(r=>r.name==='Apoio extra');
    const manualId=db.prepare("INSERT INTO registrations(contest_id,name,cpf,phone,source) VALUES(?,?,?,?, 'administrador') RETURNING id").get(contestId,'Pessoa Extra','extra','').id;
    s.assign(manualId,[extra.id]);
    const print=await request(`/admin/contests/${contestId}/registrations/print`);
    assert.equal(print.res.status,200);
    assert.match(print.text,/Pessoa Importada/);
    assert.match(print.text,/Pessoa Apoio/);
    assert.match(print.text,/529\.982\.247-25/);
    assert.match(print.text,/111\.444\.777-35/);
    assert.match(print.text,/Manhã - R\$\s*180,75 - 2\/5/);
    assert.ok(print.text.indexOf('Fiscal de sala') < print.text.indexOf('Apoio extra'));
    assert.doesNotMatch(print.text,/Nenhum colaborador cadastrado/);
    assert.doesNotMatch(print.text,/<th scope="col">WhatsApp<\/th>/);
    assert.doesNotMatch(print.text,/<th scope="col">Grupo<\/th>/);
    const receipts=await request(`/admin/contests/${contestId}/registrations/receipts`);
    assert.equal(receipts.res.status,200);
    assert.match(receipts.text,/Escolha os colaboradores/);
    assert.match(receipts.text,/Pessoa Importada/);
    assert.match(receipts.text,/Selecionar todos/);
    const selectedReceipts=await request(`/admin/contests/${contestId}/registrations/receipts/print`,{selected:rows.find(r=>r.name==='Pessoa Importada').id});
    assert.equal(selectedReceipts.res.status,200);
    assert.match(selectedReceipts.text,/COMANDA DE PAGAMENTO/);
    assert.match(selectedReceipts.text,/Pessoa Importada/);
    assert.doesNotMatch(selectedReceipts.text,/Pessoa Apoio/);
    assert.match(selectedReceipts.text,/529\.982\.247-25/);
    assert.match(selectedReceipts.text,/Equipe de trabalho/);
    assert.match(selectedReceipts.text,/R\$\s*180,75/);
    assert.match(selectedReceipts.text,/Fiscal de sala/);
    assert.match(selectedReceipts.text,/pix-qr|receipt-qr/);
    assert.match(selectedReceipts.text,/cortar aqui/);
  } finally {await new Promise(r=>server.close(r));db.close();}
});

test('painel cadastra salas em lote, define composição e imprime distribuição',async()=>{
  const {db,s,contestId,a,b}=fixture();
  const server=createApp(config,db).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='',token='';
  async function request(path,data) {
    const form=new URLSearchParams({_csrf:token});
    for(const [key,value] of Object.entries(data||{})) for(const item of Array.isArray(value)?value:[value]) form.append(key,item);
    const res=await fetch(base+path,{redirect:'manual',headers:{cookie,...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(data?{method:'POST',body:form}:{})});
    cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
    const text=await res.text();token=text.match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
    return {res,text};
  }
  try {
    await request('/login');
    await request('/login',{username:'admin',password:config.adminPassword});
    const adminPage=await request('/admin');
    assert.match(adminPage.text,/data-sidebar-toggle/);
    assert.match(adminPage.text,/layout\.js/);
    assert.doesNotMatch(adminPage.text,/<footer>/);
    const rolesUrl=`/admin/contests/${contestId}/roles`;
    assert.equal((await request(rolesUrl,{name:'Fiscal',period:1,amount:100,quantity:2})).res.status,302);
    assert.equal((await request(rolesUrl,{name:'Chefe de sala',period:3,amount:200,quantity:1})).res.status,302);
    const fiscal=s.list(contestId).find(r=>r.name==='Fiscal');
    const chief=s.list(contestId).find(r=>r.name==='Chefe de sala');
    s.assign(a,[fiscal.id]);
    s.assign(b,[chief.id]);
    const contestPage=await request(`/admin/contests/${contestId}`);
    assert.match(contestPage.text,/▦ Salas/);
    assert.doesNotMatch(contestPage.text,/Cadastrar salas/);
    const roomsUrl=`/admin/contests/${contestId}/rooms`;
    assert.match((await request(roomsUrl)).text,/Adicionar sala/);
    assert.equal((await request(roomsUrl,{name:'Sala',count:2,role_ids:[fiscal.id,chief.id],[`quantity_${fiscal.id}`]:1,[`quantity_${chief.id}`]:1})).res.status,302);
    let roomsPage=await request(roomsUrl);
    assert.match(roomsPage.text,/Sala 1/);
    assert.match(roomsPage.text,/Sala 2/);
    assert.match(roomsPage.text,/rooms\.js/);
    assert.match(roomsPage.text,/data-open-dialog="new-room"/);
    assert.match(roomsPage.text,/2 salas/);
    assert.match(roomsPage.text,/Nome ou prefixo da sala/);
    assert.match(roomsPage.text,/Quantidade de salas<input name="count" type="number" value="" min="1" max="200" step="1">/);
    const room=db.prepare("SELECT * FROM rooms WHERE contest_id=? AND name='Sala 1'").get(contestId);
    const secondRoom=db.prepare("SELECT * FROM rooms WHERE contest_id=? AND name='Sala 2'").get(contestId);
    assert.equal(db.prepare('SELECT COALESCE(SUM(quantity),0) total FROM room_roles WHERE room_id=?').get(room.id).total,2);
    assert.equal((await request(`${roomsUrl}/${room.id}`,{name:'Sala 1',role_ids:[fiscal.id,chief.id],[`quantity_${fiscal.id}`]:1,[`quantity_${chief.id}`]:1,assignments:[`${a}|${fiscal.id}`,`${b}|${chief.id}`]})).res.status,302);
    assert.equal(roomService(db).assignmentOptions(contestId,secondRoom.id).some(person=>person.registration_id===a),false);
    roomsPage=await request(roomsUrl);
    assert.match(roomsPage.text,/Fiscal <strong>1<\/strong>/);
    assert.match(roomsPage.text,/Chefe de sala <strong>1<\/strong>/);
    assert.match(roomsPage.text,/Colaboradores da sala/);
    assert.match(roomsPage.text,/Pessoa A/);
    assert.match(roomsPage.text,/rooms\/message/);
    const message=await request(`${roomsUrl}/message`);
    assert.equal(message.res.status,200);
    assert.match(message.text,/Mensagem de ensalamento/);
    assert.match(message.text,/Sala 1\n\nChefe de sala\nPessoa B\n\nFiscal\nPessoa A\n\nSala 2/);
    assert.match(message.text,/Copiar mensagem/);
    const print=await request(`${roomsUrl}/print`);
    assert.equal(print.res.status,200);
    assert.match(print.text,/Sala 1/);
    assert.match(print.text,/Equipe de trabalho/);
    assert.match(print.text,/<h2>Fiscal<\/h2><span>1\/1<\/span>/);
    assert.match(print.text,/<h2>Chefe de sala<\/h2><span>1\/1<\/span>/);
    assert.match(print.text,/ENSALAMENTO/);
    assert.match(print.text,/Assinatura/);
    assert.match(print.text,/Pessoa A/);
    assert.match(print.text,/Pessoa B/);
  } finally {await new Promise(r=>server.close(r));db.close();}
});

test('painel exporta e importa concurso com cargos, colaboradores e salas',async()=>{
  const {db,s,contestId,a}=fixture();
  const server=createApp(config,db).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='',token='';
  async function request(path,data) {
    const form=new URLSearchParams({_csrf:token});
    for(const [key,value] of Object.entries(data||{})) for(const item of Array.isArray(value)?value:[value]) form.append(key,item);
    const res=await fetch(base+path,{redirect:'manual',headers:{cookie,...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(data?{method:'POST',body:form}:{})});
    cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
    const text=await res.text();token=text.match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
    return {res,text};
  }
  try {
    await request('/login');
    await request('/login',{username:'admin',password:config.adminPassword});
    await request('/admin');
    assert.match((await request('/admin')).text,/Importar concurso/);
    const role=s.save(contestId,{name:'Fiscal',period:1,amount:100,quantity:2});
    s.assign(a,[role.id]);
    db.prepare("INSERT INTO rooms(contest_id,name) VALUES(?,?)").run(contestId,'Sala 1');
    const room=db.prepare("SELECT * FROM rooms WHERE contest_id=? AND name='Sala 1'").get(contestId);
    db.prepare('INSERT INTO room_roles(room_id,role_id,quantity) VALUES(?,?,?)').run(room.id,role.id,1);
    db.prepare('INSERT INTO room_assignments(room_id,registration_id,role_id) VALUES(?,?,?)').run(room.id,a,role.id);
    const contestPage=await request(`/admin/contests/${contestId}`);
    assert.match(contestPage.text,/Exportar concurso/);
    const exported=await request(`/admin/contests/${contestId}/export`);
    assert.equal(exported.res.status,200);
    assert.match(exported.res.headers.get('content-type'),/application\/json/);
    const payload=JSON.parse(exported.text);
    assert.equal(payload.type,'ponto-de-prova.contest');
    assert.equal(payload.roles.length,1);
    assert.equal(payload.rooms.length,1);
    assert.equal(payload.registration_roles.length,1);
    assert.equal(payload.room_assignments.length,1);
    const importPage=await request('/admin/contests/import');
    assert.equal(importPage.res.status,200);
    assert.match(importPage.text,/Importar concurso/);
    const imported=await request('/admin/contests/import',{content:JSON.stringify(payload)});
    assert.equal(imported.res.status,200);
    assert.match(imported.text,/Importação concluída/);
    const contests=db.prepare("SELECT id FROM contests WHERE title='Equipe de trabalho' ORDER BY created_at,rowid").all();
    assert.equal(contests.length,2);
    const importedId=contests.find(c=>c.id!==contestId).id;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM roles WHERE contest_id=?').get(importedId).n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations WHERE contest_id=?').get(importedId).n,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registration_roles rr JOIN registrations r ON r.id=rr.registration_id WHERE r.contest_id=?').get(importedId).n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rooms WHERE contest_id=?').get(importedId).n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM room_roles rr JOIN rooms ro ON ro.id=rr.room_id WHERE ro.contest_id=?').get(importedId).n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM room_assignments ra JOIN rooms ro ON ro.id=ra.room_id WHERE ro.contest_id=?').get(importedId).n,1);
  } finally {await new Promise(r=>server.close(r));db.close();}
});
