import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { database } from '../src/db.js';
import { accounts, migrateAccounts, SQLiteSessions } from '../src/accounts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contest as validateContest, fields } from '../src/validation.js';
import { staffing } from '../src/staffing.js';

const config={adminPassword:'initial-admin-password',sessionSecret:'s'.repeat(40),cpfSecret:'h'.repeat(40),baseUrl:'http://localhost'};
const contest={title:'Concurso privado A',organizer:'Organizador',location:'Escola',arrival:'2026-12-01T07:00',starts:'2026-12-01T08:00',ends:'2026-12-01T18:00',deadline:'2026-11-01T12:00',official_url:'https://example.com',notes:''};

test('back-office isola gestores em telas, URLs, APIs, vínculos e listas',async()=>{
  const db=database(':memory:');
  const app=createApp(config,db),users=accounts(db);
  const a=await users.save({name:'Gestor A',username:'gestor.a',password:'manager-a-password',role:'manager',active:'1'});
  const b=await users.save({name:'Gestor B',username:'gestor.b',password:'manager-b-password',role:'manager',active:'1'});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie='',token='';
    return async(path,data,method=data?'POST':'GET')=>{
      const res=await fetch(base+path,{method,redirect:'manual',headers:{cookie,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify({_csrf:token,...data}):undefined});
      cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
      const text=await res.text();token=text.match(/name="_csrf" value="([^"]+)"/)?.[1]||token;
      return {status:res.status,text,location:res.headers.get('location')};
    };
  }
  const admin=client(),first=client(),second=client(),guest=client();
  const login=async(c,username,password)=>{await c('/login');assert.equal((await c('/login',{username,password})).status,302);await c('/admin');};
  try {
    await guest('/login');assert.equal((await guest('/login',{password:config.adminPassword})).status,401);
    await login(admin,'admin',config.adminPassword);
    await login(first,a.username,'manager-a-password');await login(second,b.username,'manager-b-password');
    assert.equal((await first('/admin/users')).status,403);
    assert.equal((await first('/admin/users/new',{name:'Escalada',username:'evil',password:'evil-password-123',role:'admin',active:'1'})).status,403);
    assert.equal((await guest('/api/grupos')).status,401);
    const created=await first('/api/concursos',{...contest,owner_id:b.id});assert.equal(created.status,201);
    const c=JSON.parse(created.text);
    assert.equal(c.owner_id,a.id);
    const other=JSON.parse((await second('/api/concursos',{...contest,title:'Concurso privado B'})).text);
    assert.match((await first('/admin')).text,/Concurso privado A/);
    assert.doesNotMatch((await first('/admin')).text,/Concurso privado B/);
    assert.match((await admin('/admin')).text,/Concurso privado B/);
    for(const path of [`/admin/contests/${other.id}`,`/ADMIN/CONTESTS/${other.id}`,`/admin/contests/${other.id}/roles`,`/api/concursos/${other.id}`,`/admin/registrations?contest=${other.id}`]) assert.equal((await first(path)).status,404,path);
    assert.equal((await first(`/admin/contests/${other.id}/close`,{})).status,404);
    assert.equal((await first(`/api/concursos/${other.id}`,contest,'PUT')).status,404);
    const groupBody={name:'Grupo B exclusivo',instance:'test',remote_jid:'123@g.us',bot_jid:'5511999999999@s.whatsapp.net',contest_id:other.id,active:true};
    const group=JSON.parse((await second('/api/grupos',groupBody)).text);
    assert.doesNotMatch((await first('/admin/groups')).text,/Grupo B exclusivo|Concurso privado B/);
    assert.deepEqual(JSON.parse((await first('/api/grupos')).text),[]);
    assert.equal((await first('/api/grupos',groupBody)).status,404);
    assert.equal((await first(`/api/grupos/${group.id}`,{...groupBody,contest_id:c.id},'PUT')).status,404);
    await second(`/admin/contests/${other.id}/registrations/new`,{name:'Pessoa B exclusiva'});
    const person=db.prepare('SELECT id FROM registrations WHERE contest_id=?').get(other.id);
    assert.doesNotMatch((await first('/admin/registrations')).text,/Pessoa B exclusiva/);
    for(const path of [`/admin/registrations/${person.id}/edit`,`/admin/registrations/${person.id}/roles`])assert.equal((await first(path)).status,404);
    assert.equal((await first(`/admin/registrations/${person.id}/delete`,{})).status,404);
    assert.equal((await first(`/api/participantes/${person.id}/cargos`,{role_ids:[]},'PUT')).status,404);
    const role=staffing(db).save(other.id,{name:'Fiscal B',period:1,amount:100,quantity:2});
    assert.equal((await first(`/api/concursos/${c.id}/cargos/${role.id}`,{},'DELETE')).status,400);
    const reminder=await second('/admin/reminders',{group_id:group.id,type:'MENSAGEM_PERSONALIZADA',message:'Lembrete B exclusivo',execute_local:'2099-01-01T10:00'});
    assert.equal(reminder.status,302);
    assert.doesNotMatch((await first('/admin/reminders')).text,/Lembrete B exclusivo/);
    assert.equal((await first('/admin/messages')).status,403);
    assert.equal((await first('/admin/history')).status,403);
    const audit=db.prepare("SELECT actor FROM audit WHERE action='concurso.criado' AND target=?").get(c.id);
    assert.match(audit.actor,/Gestor A/);assert.match(audit.actor,new RegExp(a.id));
    const disabled=await admin(`/admin/users/${a.id}/edit`,{...a,active:'',password:''});assert.equal(disabled.status,302);
    assert.equal((await first('/admin')).status,302);
    await first('/login');assert.equal((await first('/login',{username:a.username,password:'manager-a-password'})).status,401);
    const hash=db.prepare('SELECT password_hash FROM users WHERE id=?').get(b.id).password_hash;
    assert.notEqual(hash,'manager-b-password');
    await users.save({...b,password:'new-manager-password',active:'1'},b.id);
    assert.equal((await second('/api/grupos')).status,401);
    const root=users.list().find(u=>u.role==='admin');
    await assert.rejects(users.save({...root,role:'manager',active:'1'},root.id),/administrador ativo/);
    assert.equal((await admin('/admin/users')).status,200);
  } finally {await new Promise(r=>server.close(r));db.close();}
});

test('reinicialização preserva contas e não redefine senha ou proprietário',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'concurso-accounts-')),path=join(folder,'test.sqlite');
  let db=database(path);
  try {
    const data=validateContest(contest);
    const oldContest=db.prepare(`INSERT INTO contests(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')}) RETURNING id`).get(...fields.map(k=>data[k]));
    migrateAccounts(db,config);
    const users=accounts(db),root=users.list()[0];
    assert.equal(db.prepare('SELECT owner_id FROM contests WHERE id=?').get(oldContest.id).owner_id,root.id);
    await users.save({...root,password:'changed-admin-password',active:'1'},root.id);
    const sessions=new SQLiteSessions(db);
    await new Promise((resolve,reject)=>sessions.set('saved-session',{userId:root.id,authVersion:2,cookie:{expires:new Date(Date.now()+60000).toISOString()}},e=>e?reject(e):resolve()));
    db.close();db=database(path);
    migrateAccounts(db,{...config,adminPassword:undefined});
    const reopened=accounts(db);
    assert.equal(reopened.list().length,1);
    assert.equal(await reopened.authenticate('admin',config.adminPassword),null);
    assert.equal((await reopened.authenticate('admin','changed-admin-password')).id,root.id);
    assert.equal(db.prepare('SELECT owner_id FROM contests WHERE id=?').get(oldContest.id).owner_id,root.id);
    const saved=await new Promise((resolve,reject)=>new SQLiteSessions(db).get('saved-session',(e,value)=>e?reject(e):resolve(value)));
    assert.equal(saved.userId,root.id);
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});
