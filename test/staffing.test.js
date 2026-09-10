import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/db.js';
import { staffing } from '../src/staffing.js';
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
    assert.match(registrations.text,/Cadastrar colaborador/);
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
    assert.match(print.text,/QR Pix/);
    assert.match(print.text,/Pessoa nova/);
    assert.match(print.text,/paid-box/);
    assert.equal((await request(`/admin/registrations/${a}/roles`,{})).res.status,302);
    assert.equal(s.assigned(a).length,0);
    assert.equal((await request(`/admin/registrations/${b}/roles`,{role_ids:morning.id,_csrf:'bad'})).res.status,403);
  } finally {await new Promise(r=>server.close(r));db.close();}
});
