import { randomBytes, createHmac } from 'node:crypto';
import { redact } from './privacy.js';
import { localToUtc } from './dates.js';
import { staffing, periods } from './staffing.js';
export { localToUtc } from './dates.js';

export const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
export function text(value,max=500,required=true) {
  if(typeof value!=='string' || value.length>max || (required&&!value.trim()))fail('Texto ausente ou acima do limite.');
  return value.trim();
}
export function id(value) { if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail('UUID inválido.');return value.toLowerCase(); }
const flag = v => v===true||v===1||v==='1'||v==='on'?1:0;
export const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/!(duvida|concurso)\b/g,'').replace(/[^a-z0-9\s]/g,' ').trim();
const stop=new Set(['a','o','as','os','de','da','do','das','dos','e','em','para','por','que','qual','como','um','uma','ser','vai','posso']);
const terms=value=>normalize(value).split(/\s+/).filter(v=>v.length>1&&!stop.has(v));
export function matchFaq(question,faqs) {
  const tokens=new Set(terms(question));
  const ranked=faqs.map(f=>{
    const keys=[...new Set(terms(`${f.question} ${f.keywords}`))];
    const hits=keys.filter(k=>tokens.has(k)).length;
    return {f,score:normalize(f.question)===normalize(question)?100:hits>=2?hits/Math.max(tokens.size,1):0};
  }).sort((a,b)=>b.score-a.score);
  return ranked[0]?.score>=0.5?ranked[0].f:null;
}
export function botService(db,config) {
  const now=()=>new Date().toISOString();
  const staff=staffing(db);
  const audit=(action,target)=>db.prepare('INSERT INTO audit(actor,action,target) VALUES(?,?,?)').run('administrador',action,String(target));
  const getContest=value=>db.prepare('SELECT * FROM contests WHERE id=?').get(id(value))||fail('Concurso não encontrado.',404);
  const getGroup=value=>db.prepare('SELECT * FROM groups WHERE id=?').get(id(value))||fail('Grupo não encontrado.',404);
  function group(body,groupId) {
    const c=getContest(body.contest_id);
    const data={name:text(body.name,150),instance:text(body.instance,100),remote_jid:text(body.remote_jid,150),bot_jid:text(body.bot_jid,150),contest_id:c.id,
      active:flag(body.active),respond_mention:flag(body.respond_mention),respond_command:flag(body.respond_command)};
    if(!/^[\w-]+@g\.us$/.test(data.remote_jid)||!/^\d+@s\.whatsapp\.net$/.test(data.bot_jid))fail('Informe o JID do grupo e o número do bot com DDI.');
    const existing=groupId?getGroup(groupId):null;
    if(existing&&(existing.contest_id!==c.id||existing.instance!==data.instance||existing.remote_jid!==data.remote_jid)&&db.prepare("SELECT id FROM reminders WHERE group_id=? AND status='PROCESSANDO' LIMIT 1").get(existing.id))fail('Aguarde os envios em processamento antes de alterar o destino do grupo.',409);
    if(db.prepare('SELECT id FROM groups WHERE instance=? AND remote_jid=? AND id<>?').get(data.instance,data.remote_jid,existing?.id||''))fail('Este grupo já está cadastrado nesta instância.',409);
    db.exec('BEGIN IMMEDIATE');
    try {
      let code=existing?.code;
      if(!existing||existing.contest_id!==c.id){code=randomBytes(9).toString('base64url');db.prepare('INSERT INTO links(code,contest_id,group_name) VALUES(?,?,?)').run(code,c.id,data.name);}
      else db.prepare('UPDATE links SET group_name=? WHERE code=?').run(data.name,code);
      let resultId;
      if(existing) {
        db.prepare('UPDATE groups SET name=?,instance=?,remote_jid=?,bot_jid=?,contest_id=?,active=?,respond_mention=?,respond_command=?,code=? WHERE id=?').run(...Object.values(data),code,existing.id);
        if(existing.contest_id!==c.id)db.prepare("UPDATE reminders SET status='CANCELADO',error='Concurso do grupo alterado' WHERE group_id=? AND status IN ('PENDENTE','ERRO')").run(existing.id);
        resultId=existing.id;
      } else resultId=db.prepare('INSERT INTO groups(name,instance,remote_jid,bot_jid,contest_id,active,respond_mention,respond_command,code) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id').get(...Object.values(data),code).id;
      audit(existing?'grupo.atualizado':'grupo.criado',resultId);db.exec('COMMIT');return getGroup(resultId);
    } catch(e){db.exec('ROLLBACK');throw e;}
  }
  function faq(body,contestId,faqId) {
    getContest(contestId);
    const values=[text(body.question,500),text(body.answer,500),text(body.keywords??'',500,false),Number(body.sort_order||0),flag(body.active)];
    if(!Number.isSafeInteger(values[3]))fail('Ordem inválida.');
    if(faqId) {
      if(!db.prepare('SELECT id FROM faqs WHERE id=? AND contest_id=?').get(id(faqId),id(contestId)))fail('FAQ não encontrada.',404);
      db.prepare('UPDATE faqs SET question=?,answer=?,keywords=?,sort_order=?,active=? WHERE id=?').run(...values,id(faqId));
    } else faqId=db.prepare('INSERT INTO faqs(question,answer,keywords,sort_order,active,contest_id) VALUES(?,?,?,?,?,?) RETURNING id').get(...values,id(contestId)).id;
    audit('faq.salva',faqId);return db.prepare('SELECT * FROM faqs WHERE id=?').get(id(faqId));
  }
  function reminder(body,reminderId) {
    const g=getGroup(body.group_id),c=getContest(g.contest_id);
    const type=text(body.type,40),message=text(body.message,2000);
    if(!['INSCRICAO_ABERTA','INSCRICAO_ENCERRANDO','CONFIRMAR_CADASTRO','LEMBRETE_PROVA','MENSAGEM_PERSONALIZADA'].includes(type))fail('Tipo de lembrete inválido.');
    const execute=localToUtc(body.execute_local),hours=Number(body.repeat_hours||0),until=body.repeat_until?localToUtc(body.repeat_until):null;
    if(!Number.isSafeInteger(hours)||hours<0||hours>8760||(hours>0&&(!until||until<=execute)))fail('Repetição precisa de intervalo entre 1 e 8760 horas e data final posterior.');
    const values=[g.id,c.id,type,message,execute,body.execute_local,hours,until];
    if(reminderId){const r=getReminder(reminderId);if(r.status!=='PENDENTE'||r.attempts>0)fail('Somente lembretes pendentes sem tentativas podem ser editados.',409);db.prepare('UPDATE reminders SET group_id=?,contest_id=?,type=?,message=?,execute_at=?,original_local=?,repeat_hours=?,repeat_until=? WHERE id=?').run(...values,r.id);}
    else reminderId=db.prepare('INSERT INTO reminders(group_id,contest_id,type,message,execute_at,original_local,repeat_hours,repeat_until) VALUES(?,?,?,?,?,?,?,?) RETURNING id').get(...values).id;
    audit('lembrete.salvo',reminderId);return getReminder(reminderId);
  }
  const getReminder=value=>db.prepare('SELECT * FROM reminders WHERE id=?').get(id(value))||fail('Lembrete não encontrado.',404);
  const confirmation=g=>`${config.baseUrl}/l/${g.code}`;
  function renderReminder(r,g,c) {
    return redact(r.message.replace(/\{\{(nome_concurso|link_confirmacao|link_inscricao|data_fim|data_prova)\}\}/g,(_,key)=>({nome_concurso:c.title,link_confirmacao:confirmation(g),link_inscricao:confirmation(g),data_fim:c.deadline.replace('T',' '),data_prova:c.starts.replace('T',' ')}[key])));
  }
  function recover() {
    // Never requeue ambiguous sends automatically: delivery may already have happened.
    db.prepare("UPDATE reminders SET status='ERRO',error='TIMEOUT_INCERTO' WHERE status='PROCESSANDO' AND claimed_at<?").run(new Date(Date.now()-600000).toISOString());
  }
  function due(limit=50) {
    recover();const n=Number(limit);if(!Number.isInteger(n)||n<1||n>50)fail('Limite deve estar entre 1 e 50.');
    return db.prepare(`SELECT r.id,r.execute_at,r.type,r.attempts,g.name group_name FROM reminders r JOIN groups g ON g.id=r.group_id JOIN contests c ON c.id=r.contest_id
      WHERE r.status='PENDENTE' AND r.execute_at<=? AND r.attempts<3 AND g.active=1 AND c.active=1 AND g.contest_id=r.contest_id ORDER BY r.execute_at LIMIT ?`).all(now(),n);
  }
  function claim(value) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r=getReminder(value),g=getGroup(r.group_id),c=getContest(r.contest_id);
      if(r.status!=='PENDENTE'||r.execute_at>now()||r.attempts>=3||!g.active||!c.active||g.contest_id!==c.id)fail('Lembrete não disponível.',409);
      const token=randomBytes(24).toString('hex');
      db.prepare("UPDATE reminders SET status='PROCESSANDO',attempts=attempts+1,claim_token=?,claimed_at=?,error=NULL WHERE id=?").run(token,now(),r.id);
      db.exec('COMMIT');return {id:r.id,claim_token:token,instance:g.instance,target:g.remote_jid,text:renderReminder(r,g,c)};
    } catch(e){db.exec('ROLLBACK');throw e;}
  }
  function finish(value,body,success) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r=getReminder(value);
      if(typeof body.claim_token!=='string'||r.claim_token!==body.claim_token)fail('Reserva inválida.',409);
      if(r.status==='ENVIADO'&&success){db.exec('COMMIT');return {ok:true,duplicate:true};}
      if(r.status!=='PROCESSANDO' && !(success&&r.status==='ERRO'&&r.error==='TIMEOUT_INCERTO'))fail('Reserva não está em processamento.',409);
      const provider=success?text(body.provider_id,200):null;
      const error=success?null:allowedError(body.code);
      db.prepare('UPDATE reminders SET status=?,sent_at=?,error=?,provider_id=? WHERE id=?').run(success?'ENVIADO':'ERRO',success?now():null,error,provider,r.id);
      if(success&&r.repeat_hours>0){const next=new Date(Math.max(Date.parse(r.execute_at),Date.now())+r.repeat_hours*3600000).toISOString();if(next<=r.repeat_until)db.prepare('INSERT INTO reminders(group_id,contest_id,type,message,execute_at,original_local,repeat_hours,repeat_until) VALUES(?,?,?,?,?,?,?,?)').run(r.group_id,r.contest_id,r.type,r.message,next,new Date(Date.parse(next)-10800000).toISOString().slice(0,16),r.repeat_hours,r.repeat_until);}
      db.exec('COMMIT');return {ok:true};
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function transition(value,action) {
    const r=getReminder(value);
    if(action==='cancel' && ['PENDENTE','ERRO'].includes(r.status))db.prepare("UPDATE reminders SET status='CANCELADO' WHERE id=?").run(r.id);
    else if(action==='retry'&&r.status==='ERRO'&&r.attempts<3)db.prepare("UPDATE reminders SET status='PENDENTE',claim_token=NULL WHERE id=?").run(r.id);
    else fail('Esta alteração não é permitida no estado atual.',409);
    audit(`lembrete.${action}`,r.id);
  }
  function processMessage(b) {
    const instance=text(b.instance,100),messageId=text(b.messageId,200),remote=text(b.remoteJid,150);
    const ignore=reason=>({action:'IGNORE',reason});
    if(b.fromMe!==false)return ignore('FROM_ME_OR_INVALID');
    if(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000)return ignore('EMPTY_OR_UNSUPPORTED');
    if(!['conversation','extendedTextMessage','imageMessage','videoMessage'].includes(b.messageType))return ignore('UNSUPPORTED_MEDIA');
    if(b.isGroup!==true)return ignore('PRIVATE_USE_GROUP_LINK');
    if(typeof b.participantJid!=='string'||!/^\d+@(s\.whatsapp\.net|lid)$/.test(b.participantJid))return ignore('INVALID_PARTICIPANT');
    const g=db.prepare('SELECT * FROM groups WHERE instance=? AND remote_jid=?').get(instance,remote);
    if(!g)return ignore('UNKNOWN_GROUP');
    db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare('SELECT id FROM bot_messages WHERE instance=? AND message_id=?').get(instance,messageId)){db.exec('COMMIT');return ignore('DUPLICATE');}
      const c=getContest(g.contest_id),sender=createHmac('sha256',config.cpfSecret).update(`${instance}:${b.participantJid}`).digest('hex');
      let result;
      const question=redact(b.text).slice(0,1000);
      const triggered=(g.respond_command&&/^!(duvida|concurso)\b/i.test(b.text.trim())) || (g.respond_mention&&((Array.isArray(b.mentionedJids)&&b.mentionedJids.includes(g.bot_jid))||b.quotedMessageFromBot===true));
      if(!g.active||!c.active)result=ignore('BOT_DISABLED');
      else if(!triggered)result=ignore('BOT_NOT_TRIGGERED');
      else if(db.prepare("SELECT id FROM bot_messages WHERE group_id=? AND sender_hash=? AND action<>'IGNORE' AND created_at>? LIMIT 1").get(g.id,sender,new Date(Date.now()-5000).toISOString()))result=ignore('USER_RATE_LIMIT');
      else {
        const faqs=db.prepare('SELECT question,answer,keywords FROM faqs WHERE contest_id=? AND active=1 ORDER BY sort_order,id LIMIT 50').all(c.id),found=matchFaq(question,faqs);
        const q=normalize(question);
        let answer;
        if(/\b(cadastrei|confirmar|confirmacao|cpf)\b/.test(q))answer=`Cadastre-se para trabalhar pelo formulário privado: ${confirmation(g)}\nNão envie CPF no grupo.`;
        else if(found)answer=found.answer;
        else if(/\b(data|dia|horario|hora|quando)\b/.test(q)&&/\bprova\b/.test(q))answer=`Prova: ${c.starts.replace('T',' às ')}. Chegada: ${c.arrival.replace('T',' às ')}. Término: ${c.ends.replace('T',' às ')}. Horário de Brasília.`;
        else if(/\b(local|onde|endereco)\b/.test(q))answer=`Local da prova: ${c.location}.`;
        else if(/\b(taxa|valor|custo)\b/.test(q))answer='O cadastro para trabalhar no concurso é gratuito.';
        else if(/\bvagas\b/.test(q))answer=`Vagas: ${c.vacancies}. Cargos: ${c.role}.`;
        else if(/\b(inscricao|inscrever|inscricoes)\b/.test(q))answer=`Cadastros para trabalhar até ${c.deadline.replace('T',' às ')} (Brasília). ${confirmation(g)}`;
        else if(/\bedital\b/.test(q))answer=c.edital_url?`Edital: ${c.edital_url}`:c.fallback;
        result=answer?{action:'SEND_GROUP_MESSAGE',instance,target:remote,text:redact(answer).slice(0,500)}:{action:'ASK_AI',instance,target:remote,question,context:{finalidade:'Cadastro gratuito de trabalhadores para o concurso',concurso:c.title,cargo:c.role,cargos:staff.list(c.id).filter(r=>r.period&&r.amount_cents!==null).map(r=>({nome:r.name,periodo:periods[r.period],valor:r.amount_cents/100,quantidade:r.quantity})),atribuicaoCargos:'Somente o organizador define os cargos dos colaboradores.',vagas:c.vacancies,local:c.location,inicio:c.starts,chegada:c.arrival,termino:c.ends,inscricoesAte:c.deadline,fuso:'America/Sao_Paulo',linkEdital:c.edital_url,informacoes:redact(c.ai_context+'\n'+c.notes).slice(0,12000),faqs:faqs.map(f=>({pergunta:redact(f.question),resposta:redact(f.answer)}))},fallback:c.fallback,maxCharacters:500};
        if(result.text&&db.prepare("SELECT id FROM bot_messages WHERE group_id=? AND response=? AND action<>'IGNORE' AND created_at>? LIMIT 1").get(g.id,result.text,new Date(Date.now()-60000).toISOString()))result=ignore('GROUP_REPEAT_LIMIT');
      }
      const r=db.prepare('INSERT INTO bot_messages(instance,message_id,group_id,sender_hash,question,response,action,status,created_at,contest_id) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id').get(instance,messageId,g.id,sender,question,result.text||'',result.action,result.action==='IGNORE'?'IGNORADO':result.action==='ASK_AI'?'AGUARDANDO_IA':'PREPARADO',now(),c.id);
      db.prepare('UPDATE groups SET last_message_at=? WHERE id=?').run(now(),g.id);
      if(result.action!=='IGNORE')result.processing_id=r.id;
      db.exec('COMMIT');return result;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function aiResponse(value,body) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const m=db.prepare('SELECT * FROM bot_messages WHERE id=?').get(id(value));
      if(!m||m.status!=='AGUARDANDO_IA')fail('Resposta já preparada ou mensagem inválida.',409);
      const g=getGroup(m.group_id),c=getContest(g.contest_id);
      let answer=typeof body.text==='string'?redact(body.text).trim().slice(0,500):'';
      if(!answer||body.failed===true)answer='Não consegui consultar essa informação agora. Tente novamente em alguns minutos ou fale com um administrador.';
      const blocked=!g.active||!c.active||m.contest_id!==g.contest_id||m.instance!==g.instance||db.prepare("SELECT id FROM bot_messages WHERE group_id=? AND response=? AND created_at>? AND id<>?").get(g.id,answer,new Date(Date.now()-60000).toISOString(),m.id);
      db.prepare('UPDATE bot_messages SET response=?,status=? WHERE id=?').run(answer,blocked?'IGNORADO':'PREPARADO',m.id);
      db.exec('COMMIT');return blocked?{action:'IGNORE',reason:'PAUSED_OR_REPEATED'}:{action:'SEND_GROUP_MESSAGE',processing_id:m.id,instance:g.instance,target:g.remote_jid,text:answer};
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function delivery(value,body) {
    const status=body.success===true?'ENVIADO':'ERRO';
    if(!db.prepare('SELECT id FROM bot_messages WHERE id=?').get(id(value)))fail('Mensagem não encontrada.',404);
    db.prepare("UPDATE bot_messages SET status=? WHERE id=? AND status='PREPARADO'").run(status,id(value));return {ok:true};
  }
  function registerError(b) {
    const groupId=b.group_id?id(b.group_id):null;if(groupId)getGroup(groupId);
    // Only fixed error codes and non-payload numeric IDs are persisted.
    const workflow=/^BOT-(01|02|03|04|99)$/.test(b.workflow)?b.workflow:'BOT-99';
    const execution=/^\d{1,30}$/.test(String(b.execution_id??''))?String(b.execution_id):'';
    db.prepare('INSERT INTO bot_errors(group_id,workflow,execution_id,code) VALUES(?,?,?,?)').run(groupId,workflow,execution,allowedError(b.code));return {ok:true};
  }
  return {audit,getContest,getGroup,group,faq,reminder,getReminder,due,claim,finish,transition,processMessage,aiResponse,delivery,registerError,recover};
}
export function allowedError(code) { return ['PROVIDER_REJECTED','TIMEOUT_INCERTO','AI_FAILED','API_FAILED','WORKFLOW_FAILED'].includes(code)?code:'WORKFLOW_FAILED'; }
