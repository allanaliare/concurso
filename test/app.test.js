import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { database } from '../src/db.js';
import { cpfValid, contest } from '../src/validation.js';
import http from 'node:http';

test('CPF e sequência de horários',()=>{
  assert.equal(cpfValid('52998224725'),true);
  assert.equal(cpfValid('11111111111'),false);
  assert.equal(cpfValid('52998224724'),false);
  assert.throws(()=>contest({}),/campos/);
});
test('envio ao n8n registra aceite e falha HTTP',async()=>{
  let received, fail=false;
  const mock=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    received={auth:req.headers.authorization,body:JSON.parse(body)};
    res.writeHead(fail?500:200);res.end('{}');
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>mock.once('listening',resolve));
  const db=database(':memory:');
  const server=createApp({cpfSecret:'h'.repeat(40),adminPassword:'test-password',sessionSecret:'s'.repeat(40),baseUrl:'http://localhost',outboundUrl:`http://127.0.0.1:${mock.address().port}`,outboundToken:'out-secret'},db).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie,token;
  async function request(path,data) {
    const res=await fetch(base+path,{redirect:'manual',headers:{...(cookie?{cookie}:{}),...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(data?{method:'POST',body:new URLSearchParams({_csrf:token,...data})}:{})});
    cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
    token=(await res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
    return res;
  }
  try {
    await request('/login');await request('/login',{password:'test-password'});await request('/admin/messages');
    await request('/admin/messages',{phone:'5511999999999',body:'Mensagem de teste'});
    assert.equal(received.auth,'Bearer out-secret');assert.equal(received.body.type,'whatsapp.send');
    assert.equal(db.prepare('SELECT status FROM messages ORDER BY rowid ASC LIMIT 1').get().status,'aceito pelo n8n');
    fail=true;await request('/admin/messages',{phone:'5511999999999',body:'Outra mensagem'});
    assert.equal(db.prepare('SELECT status FROM messages ORDER BY rowid DESC LIMIT 1').get().status,'falha HTTP 500');
  } finally {await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>mock.close(r))]);db.close();}
});
test('fluxo completo, autenticação, atribuição e idempotência',async()=>{
  const db=database(':memory:');
  const app=createApp({cpfSecret:'h'.repeat(40),adminPassword:'senha-de-teste-123',sessionSecret:'a'.repeat(40),webhookToken:'test-token',baseUrl:'http://localhost:3000'},db);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='',token='';
  async function request(path,data,options={}) {
    const response=await fetch(base+path,{redirect:'manual',...options,headers:{cookie,...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...options.headers},...(data?{method:'POST',body:new URLSearchParams({_csrf:token,...data})}:{})});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();token=text.match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
    return {response,text};
  }
  try {
    assert.equal((await request('/admin')).response.status,302);
    await request('/login');
    assert.equal((await request('/login',{password:'wrong'})).response.status,401);
    assert.equal((await request('/login',{password:'senha-de-teste-123'})).response.status,302);
    await request('/admin');
    assert.doesNotMatch((await request('/admin/contests/new')).text,/name="fee"/);
    const c={title:'Concurso Teste',organizer:'Banca',role:'Analista',vacancies:'12',salary:'R$ 5.000',location:'São Paulo',arrival:'2026-12-01T12:00',starts:'2026-12-01T13:00',ends:'2026-12-01T17:00',deadline:'2026-11-01T18:00',official_url:'https://example.com',notes:'Documento com foto'};
    for (const [changes,message] of [
      [{deadline:'2026-12-02T18:00'},/O fim das inscrições/],
      [{arrival:'2026-12-01T14:00'},/O horário de chegada/],
      [{ends:c.starts},/O término da prova/]
    ]) {
      const invalid=await request('/admin/contests/new',{...c,...changes});
      assert.equal(invalid.response.status,400);
      assert.match(invalid.text,message);
      assert.match(invalid.text,/value="Concurso Teste"/);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM contests').get().n,0);
    }
    const created=await request('/admin/contests/new',c);
    assert.equal(created.response.status,302);
    const contestId=db.prepare('SELECT id FROM contests').get().id;
    assert.match(contestId,/^[0-9a-f-]{36}$/);
    assert.equal(created.response.headers.get('location'),`/admin/contests/${contestId}`);
    const invalidEdit=await request(`/admin/contests/${contestId}/edit`,{...c,title:'Título revisado',ends:c.starts});
    assert.equal(invalidEdit.response.status,400);
    assert.match(invalidEdit.text,/value="Título revisado"/);
    assert.match(invalidEdit.text,/Editar concurso/);
    assert.equal(db.prepare('SELECT title FROM contests WHERE id=?').get(contestId).title,c.title);
    assert.equal((await request(`/admin/contests/${contestId}/edit`,c)).response.status,302);
    assert.equal((await request(`/admin/contests/${contestId}/links`,{group_name:'Grupo A'})).response.status,302);
    const code=db.prepare('SELECT code FROM links').get().code;
    await request(`/l/${code}`);await request(`/l/${code}`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM clicks').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT visitor) n FROM clicks').get().n,1);
    const publicPage=await request(`/concursos/${contestId}?grupo=${code}`);
    assert.match(publicPage.text,/Cadastre-se para trabalhar/);
    assert.doesNotMatch(publicPage.text,/Taxa de inscrição|pagamento à banca/);
    const person={name:'Pessoa Teste',cpf:'529.982.247-25',phone:'11999999999',consent:'yes',code,pix_type:'email',pix_key:'colaborador@example.com'};
    assert.match(publicPage.text,/name="pix_type"/);
    assert.match(publicPage.text,/name="pix_key"/);
    assert.equal((await request(`/concursos/${contestId}/confirmar`,{...person,pix_key:''})).response.status,400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations').get().n,0);
    assert.equal((await request(`/concursos/${contestId}/confirmar`,person)).response.status,200);
    assert.equal(db.prepare('SELECT pix_key FROM registrations').get().pix_key,person.pix_key);
    assert.match((await request('/admin/registrations')).text,/colaborador@example.com/);
    assert.doesNotMatch((await request(`/concursos/${contestId}`)).text,/colaborador@example.com/);
    await request(`/concursos/${contestId}/confirmar`,{...person,pix_key:'outra@example.com'});
    assert.equal(db.prepare('SELECT pix_key FROM registrations').get().pix_key,person.pix_key);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations').get().n,1);
    assert.equal(db.prepare('SELECT code FROM registrations').get().code,code);
    assert.equal((await request(`/concursos/${contestId}/confirmar`,{...person,_csrf:'invalid'})).response.status,403);
    assert.doesNotMatch((await request('/admin/registrations')).text,/529\.982\.247-25/);
    assert.equal(db.prepare('SELECT length(cpf) n FROM registrations').get().n,64);
    const hook=async(data,auth='Bearer test-token')=>fetch(base+'/api/webhooks/n8n',{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:JSON.stringify(data)});
    const event={event_id:'event-1',type:'whatsapp.message',phone:'5511999999999',message:'Olá'};
    assert.equal((await hook(event,'bad')).status,401);
    assert.equal((await hook(event)).status,200);
    assert.equal((await (await hook(event)).json()).duplicate,true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
    assert.equal((await hook({event_id:'bad',type:'invalid'})).status,400);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE event_id='bad'").get().n,0);
    assert.equal((await hook({...person,cpf:'52998224725',event_id:'reg-1',type:'registration.completed',contest_id:contestId,consent:true})).status,200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations').get().n,1);
    await request(`/admin/contests/${contestId}/close`,{});
    assert.equal((await request(`/l/${code}`)).response.status,404);
    assert.equal((await request(`/concursos/${contestId}`)).response.status,404);
    assert.doesNotMatch((await request('/')).text,/Concurso Teste/);
    assert.equal((await request(`/concursos/${contestId}/confirmar`,person)).response.status,400);
    assert.equal((await hook({...person,event_id:'closed',type:'registration.completed',contest_id:contestId,consent:true})).status,400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations').get().n,1);
    assert.match((await request('/admin')).text,/Concurso Teste/);
    await request(`/admin/contests/${contestId}/close`,{});
    assert.doesNotMatch((await request('/')).text,/Concurso Teste/);
    await request(`/admin/contests/${contestId}/reopen`,{});
    assert.match((await request('/')).text,/Concurso Teste/);
    assert.equal((await request(`/concursos/${contestId}`)).response.status,200);
    await request('/logout',{});
    assert.equal((await request('/admin/registrations')).response.status,302);
  } finally {await new Promise(resolve=>server.close(resolve));db.close();}
});
