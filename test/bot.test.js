import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/db.js';
import { privacy } from '../src/privacy.js';
import { botService, localToUtc } from '../src/bot-service.js';
import { createApp } from '../src/app.js';
import { purgeExpired } from '../src/maintenance.js';

const config={adminPassword:'password-for-tests',sessionSecret:'s'.repeat(40),cpfSecret:'h'.repeat(40),internalToken:'internal-test',baseUrl:'https://example.com'};
function fixture() {
  const db=database(':memory:');privacy(db,config.cpfSecret);
  db.prepare(`INSERT INTO contests(title,organizer,role,vacancies,salary,location,arrival,starts,ends,deadline,official_url,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('Concurso Teste','Banca','Analista',12,'5000','São Paulo','2026-12-01T12:00','2026-12-01T13:00','2026-12-01T17:00','2026-11-01T18:00','https://example.com','Documento com foto');
  const contestId=db.prepare('SELECT id FROM contests').get().id;
  const s=botService(db,config);
  const group=s.group({name:'Grupo A',instance:'test',remote_jid:'123@g.us',bot_jid:'5511999999999@s.whatsapp.net',contest_id:contestId,active:true,respond_command:true,respond_mention:true});
  const event={instance:'test',messageId:'m1',remoteJid:'123@g.us',participantJid:'5511888888888@s.whatsapp.net',fromMe:false,isGroup:true,messageType:'conversation',text:'!duvida qual a data da prova?',mentionedJids:[],quotedMessageFromBot:false};
  return {db,s,group,event,contestId};
}
test('acionamento, grupos e isolamento de instâncias',()=>{
  const {db,s,event,group,contestId}=fixture();
  try {
    assert.equal(s.processMessage({...event,text:'Bom dia'}).reason,'BOT_NOT_TRIGGERED');
    assert.equal(s.processMessage({...event,messageId:'m2',fromMe:true}).reason,'FROM_ME_OR_INVALID');
    assert.equal(s.processMessage({...event,messageId:'m2',remoteJid:'unknown@g.us'}).reason,'UNKNOWN_GROUP');
    assert.equal(s.processMessage({...event,messageId:'m2',instance:'other'}).reason,'UNKNOWN_GROUP');
    const r=s.processMessage({...event,messageId:'m2'});assert.equal(r.action,'SEND_GROUP_MESSAGE');assert.match(r.text,/2026-12-01/);
    assert.equal(s.processMessage({...event,messageId:'m2'}).reason,'DUPLICATE');
    assert.equal(s.processMessage({...event,messageId:'m3'}).reason,'USER_RATE_LIMIT');
    assert.equal(s.processMessage({...event,messageId:'m4',participantJid:'5511777777777@s.whatsapp.net'}).reason,'GROUP_REPEAT_LIMIT');
    s.group({...group,active:false},group.id);
    assert.equal(s.processMessage({...event,messageId:'m5'}).reason,'BOT_DISABLED');
    assert.throws(()=>s.group({...group,name:'Duplicado'}),/já está cadastrado/);
  } finally{db.close();}
});
test('FAQ, menção e resposta ao bot; IA não recebe CPF',()=>{
  const {db,s,event,group,contestId}=fixture();
  try {
    s.faq({question:'Pode levar caneta azul?',answer:'Use caneta azul transparente.',keywords:'caneta azul preta',active:true},contestId);
    assert.equal(s.processMessage({...event,text:'!duvida pode levar caneta azul?'}).text,'Use caneta azul transparente.');
    let r=s.processMessage({...event,messageId:'m2',participantJid:'5511777777777@s.whatsapp.net',text:'Qual documento devo levar?',mentionedJids:[group.bot_jid]});
    assert.equal(r.action,'ASK_AI');
    assert.equal(s.aiResponse(r.processing_id,{failed:true}).action,'SEND_GROUP_MESSAGE');
    assert.throws(()=>s.aiResponse(r.processing_id,{text:'Outra resposta'}),/já preparada/);
    r=s.processMessage({...event,messageId:'m3',participantJid:'5511666666666@s.whatsapp.net',text:'Meu 529.982.247-25 serve como documento?',quotedMessageFromBot:true});
    assert.doesNotMatch(JSON.stringify(r),/529/);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT question FROM bot_messages').all()),/529/);
    const prepared=s.aiResponse(r.processing_id,{text:'x'.repeat(600)});assert.equal(prepared.text.length,500);
  }finally{db.close();}
});
test('confirmação usa link por grupo e nunca solicita CPF no grupo',()=>{
  const {db,s,event,group}=fixture();
  try{const r=s.processMessage({...event,text:'!concurso cadastrei'});assert.match(r.text,new RegExp('/l/'+group.code));assert.match(r.text,/Não envie CPF/);assert.equal(s.processMessage({...event,isGroup:false}).reason,'PRIVATE_USE_GROUP_LINK');}finally{db.close();}
});
test('lembretes: futuro, reserva, callbacks, repetição e pausa',()=>{
  const {db,s,group}=fixture();
  try {
    const body={group_id:group.id,type:'CONFIRMAR_CADASTRO',message:'Confirme {{nome_concurso}} em {{link_confirmacao}}',execute_local:'2020-01-01T00:30',repeat_hours:24,repeat_until:'2099-01-01T00:00'};
    const r=s.reminder(body);s.reminder({...body,execute_local:'2090-01-01T00:00'});
    assert.equal(s.due().length,1);
    const claimed=s.claim(r.id);assert.match(claimed.text,/Concurso Teste/);assert.match(claimed.text,/\/l\//);
    assert.throws(()=>s.claim(r.id),/não disponível/);
    assert.throws(()=>s.finish(r.id,{claim_token:'wrong',provider_id:'ok'},true),/Reserva inválida/);
    assert.equal(s.finish(r.id,{claim_token:claimed.claim_token,provider_id:'evo-1'},true).ok,true);
    assert.equal(s.finish(r.id,{claim_token:claimed.claim_token,provider_id:'evo-1'},true).duplicate,true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reminders').get().n,3);
    assert.equal(s.getReminder(r.id).attempts,1);
    assert.equal(s.due().length,0);
    const pending=s.reminder({...body,repeat_hours:0});s.group({...group,active:false},group.id);
    assert.equal(s.due().length,0);assert.throws(()=>s.claim(pending.id),/não disponível/);
  }finally{db.close();}
});
test('lembrete incerto exige revisão; tentativas limitadas a três',()=>{
  const {db,s,group}=fixture();
  try {
    const r=s.reminder({group_id:group.id,type:'MENSAGEM_PERSONALIZADA',message:'Teste',execute_local:'2020-01-01T00:00'});
    s.claim(r.id);db.prepare("UPDATE reminders SET claimed_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(r.id);
    assert.equal(s.due().length,0);assert.equal(s.getReminder(r.id).error,'TIMEOUT_INCERTO');
    for(let i=0;i<2;i++){s.transition(r.id,'retry');const c=s.claim(r.id);s.finish(r.id,{claim_token:c.claim_token,code:'PROVIDER_REJECTED'},false);}
    assert.equal(s.getReminder(r.id).attempts,3);assert.throws(()=>s.transition(r.id,'retry'),/não é permitida/);
  }finally{db.close();}
});
test('conversão de Brasília independe do fuso do processo, inclusive meia-noite',()=>{
  assert.equal(localToUtc('2026-11-01T00:30'),'2026-11-01T03:30:00.000Z');
  assert.equal(localToUtc('2026-11-01T23:30'),'2026-11-02T02:30:00.000Z');
  assert.throws(()=>localToUtc('2026-02-31T08:00'),/inválida/);
});
test('migração de CPF legado, detecção de chave trocada e retenção',()=>{
  const {db,contestId}=fixture();
  try {
    db.prepare("INSERT INTO registrations(contest_id,name,cpf,phone,source,created_at) VALUES(?,'Pessoa','52998224725','11999999999','formulario','2020-01-01')").run(contestId);
    privacy(db,config.cpfSecret);
    const r=db.prepare('SELECT * FROM registrations').get();assert.equal(r.cpf.length,64);assert.equal(r.cpf_final,'4725');
    assert.throws(()=>privacy(db,'z'.repeat(40)),/não corresponde/);
    purgeExpired(db,180);assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations').get().n,0);
  }finally{db.close();}
});
test('API interna autentica e reserva atômica entre requisições concorrentes',async()=>{
  const {db,s,group,event}=fixture();const app=createApp(config,db),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,auth='Bearer internal-test')=>fetch(base+'/api/bot'+path,{method:body?'POST':'GET',headers:{Authorization:auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  try {
    assert.equal((await request('/processar-mensagem',event,'invalid')).status,401);
    const messages=await Promise.all([request('/processar-mensagem',event),request('/processar-mensagem',event)]);
    const results=await Promise.all(messages.map(r=>r.json()));assert.equal(results.filter(r=>r.action==='SEND_GROUP_MESSAGE').length,1);
    const r=s.reminder({group_id:group.id,type:'LEMBRETE_PROVA',message:'Teste',execute_local:'2020-01-01T00:00'});
    const claims=await Promise.all([request(`/lembretes/${r.id}/processando`,{}),request(`/lembretes/${r.id}/processando`,{})]);assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
    assert.equal((await request('/informar-cpf',{cpf:'52998224725'})).status,422);
    const error=await request('/registrar-erro',{workflow:'BOT-01',code:'token-secret 52998224725',execution_id:'123',message:'secret'});assert.equal(error.status,200);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM bot_errors').all()),/secret|529/);
  }finally{await new Promise(r=>server.close(r));db.close();}
});
