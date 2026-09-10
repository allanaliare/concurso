import express from 'express';
import { migrateAccounts, accounts, SQLiteSessions, actorContext, enforceBackOffice, accessibleContests, mountAccounts } from './accounts.js';
import session from 'express-session';
import helmet from 'helmet';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { database } from './db.js';
import { contest, fields, registration, digits, pixTypes } from './validation.js';
import { layout, esc, csrf, input, cards, table, contestForm, date } from './views.js';
import { privacy, maskCpf, maskPhone, redact } from './privacy.js';
import { botService, id } from './bot-service.js';
import { botRouter } from './bot-routes.js';
import { mountBotAdmin } from './bot-admin.js';
import { mountManualRegistration } from './manual-registration.js';
import { staffing } from './staffing.js';
import { mountStaffing, roleSummary, publicRoles } from './staffing-views.js';

const safeEqual = (a,b) => { const hash = v => createHash('sha256').update(String(v ?? '')).digest(); return timingSafeEqual(hash(a),hash(b)); };
export function createApp(config, db=database()) {
  migrateAccounts(db,config);
  const users=accounts(db);
  const personal=privacy(db,config.cpfSecret);
  const bot=botService(db,config);
  const staff=staffing(db);
  const app=express();
  if(config.trustLocalProxy)app.set('trust proxy','loopback');
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.static('public'));
  app.use(express.urlencoded({extended:false,limit:'32kb'}));
  app.use(express.json({limit:'32kb'}));
  app.use('/api/bot',botRouter(bot,config));
  app.use(session({store:new SQLiteSessions(db),secret:config.sessionSecret,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:config.production,maxAge:8*60*60*1000}}));
  app.use((req,res,next)=>{res.set('Cache-Control','no-store'); req.session.csrf ??= randomBytes(24).toString('hex');next();});
  app.use((req,res,next)=>{
    const user=req.session.userId?users.get(req.session.userId):null;
    req.user=user?.active&&user.auth_version===req.session.authVersion?user:null;
    req.session.admin=!!req.user;
    actorContext.run(req.user,next);
  });
  const page=(req,res,title,body,status=200,error='')=>res.status(status).send(layout(title,body,{admin:!!req.user,user:req.user,token:req.session.csrf,error}));
  const guard=(req,res,next)=>req.user?next():res.redirect('/login');
  const attempts=new Map();
  function limit(req,res,next) {
    const now=Date.now(), key=req.ip+req.path;
    if(attempts.size>10000) for(const [k,v] of attempts) if(v.until<now) attempts.delete(k);
    const bucket=attempts.get(key);
    if(!bucket || bucket.until<now) attempts.set(key,{n:1,until:now+60000});
    else if(++bucket.n>30) return res.status(429).send('Muitas tentativas. Aguarde um minuto.');
    next();
  }
  app.use((req,res,next)=>{
    if(['POST','PUT','PATCH','DELETE'].includes(req.method) && req.path!=='/api/webhooks/n8n' && !safeEqual(req.body?._csrf??req.get('x-csrf-token'),req.session.csrf)) return page(req,res,'Sessão expirada','<h1>Recarregue a página e tente novamente.</h1>',403);
    next();
  });
  app.use(enforceBackOffice(db));
  app.get('/login',(req,res)=>page(req,res,'Entrar',`<section class="login panel"><p class="eyebrow">ÁREA DO ORGANIZADOR</p><h1>Bom ter você aqui.</h1><p>Acesse seus concursos e acompanhe os cadastros para trabalhar.</p><form method="post">${csrf(req.session.csrf)}${input('Login','username','','text','autocomplete="username"')}${input('Senha de acesso','password','','password','autocomplete="current-password"')}<button>Entrar no painel →</button></form></section>`));
  app.post('/login',limit,async(req,res,next)=>{
    const user=await users.authenticate(req.body.username,req.body.password);
    if(!user) return page(req,res,'Acesso negado','<h1>Login ou senha incorretos.</h1><a href="/login">Tentar novamente</a>',401);
    req.session.regenerate(error=>{if(error)return next(error);req.session.userId=user.id;req.session.authVersion=user.auth_version;req.session.admin=true;req.session.csrf=randomBytes(24).toString('hex');req.session.save(error=>error?next(error):res.redirect('/admin'));});
  });
  app.post('/logout',(req,res)=>req.session.destroy(()=>res.redirect('/login')));
  app.get('/',(req,res)=>page(req,res,'Concursos',`<div class="heading"><div><p class="eyebrow">SEU PRÓXIMO PASSO</p><h1>Concursos em destaque</h1><p>Cadastre-se gratuitamente para trabalhar nos concursos disponíveis.</p></div></div>${cards(db.prepare('SELECT * FROM contests WHERE active=1 ORDER BY deadline').all())}`));
  function getContest(value) { const c=db.prepare('SELECT * FROM contests WHERE id=?').get(id(value)); if(!c) throw Object.assign(new Error('Concurso não encontrado.'),{status:404}); return c; }
  function getCode(code,id) { return typeof code==='string' && db.prepare('SELECT * FROM links WHERE code=? AND contest_id=?').get(code,id)?code:null; }
  app.get('/l/:code',limit,(req,res)=>{
    const link=db.prepare('SELECT l.* FROM links l JOIN contests c ON c.id=l.contest_id WHERE code=? AND c.active=1').get(req.params.code);
    if(!link) return page(req,res,'Link indisponível','<h1>Este link não está disponível.</h1>',404);
    req.session.visitor ??=randomBytes(16).toString('hex');
    db.prepare('INSERT INTO clicks(code,visitor) VALUES(?,?)').run(link.code,req.session.visitor);
    res.redirect(`/concursos/${link.contest_id}?grupo=${encodeURIComponent(link.code)}`);
  });
  app.get('/concursos/:id',(req,res)=>{
    const c=getContest(req.params.id); if(!c.active)return page(req,res,'Arquivado','<h1>Os cadastros para este concurso foram finalizados.</h1>',404);
    const code=getCode(req.query.grupo,c.id);
    page(req,res,c.title,`<a class="back" href="/">← Todos os concursos</a><div class="heading"><div><p class="eyebrow">${esc(c.organizer)}</p><h1>${esc(c.title)}</h1><p>Trabalho na equipe do concurso</p></div><span class="badge">${c.vacancies} vagas</span></div><div class="detail-grid"><section class="panel"><h2>Programe-se</h2><dl>${[['Cadastro','Gratuito'],['Cadastros até',date(c.deadline)],['Local',esc(c.location)],['Chegue até',date(c.arrival)],['Início da prova',date(c.starts)],['Término da prova',date(c.ends)]].map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>${publicRoles(staff.list(c.id))}<h3>Orientações</h3><p class="pre">${esc(c.notes)||'Consulte os requisitos e documentos no edital.'}</p><a class="button secondary" href="${esc(c.official_url)}" target="_blank" rel="noopener noreferrer">Informações no site oficial ↗</a></section><section class="panel"><p class="eyebrow">QUER TRABALHAR NESTE CONCURSO?</p><h2>Cadastre-se para trabalhar</h2><p>Informe seus dados para se candidatar à equipe de trabalho. O cadastro é gratuito.</p><form method="post" action="/concursos/${c.id}/confirmar">${csrf(req.session.csrf)}<input type="hidden" name="code" value="${esc(code)}">${input('Nome completo','name','','text','maxlength="150" autocomplete="name"')}${input('CPF','cpf','','text','inputmode="numeric" maxlength="14"')}${input('WhatsApp com DDD','phone','','tel','maxlength="20"')}<label>Tipo de chave Pix<select name="pix_type" required><option value="">Selecione o tipo</option>${Object.entries(pixTypes).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label>${input('Chave Pix','pix_key','','text','maxlength="254" autocapitalize="none" spellcheck="false"')}<small>Informe sua chave cadastrada no banco. Celular: inclua o DDD. Chave aleatória: copie a chave completa do aplicativo do banco.</small><label class="check"><input type="checkbox" name="consent" value="yes" required> Autorizo o uso de nome, CPF, telefone e chave Pix pelo organizador para avaliar meu cadastro para trabalhar, enviar informações deste concurso e realizar eventuais pagamentos pelo trabalho.</label><button>Enviar cadastro →</button><small>O cadastro não garante contratação. Aguarde o contato do organizador.</small></form></section></div>`);
  });
  function saveRegistration(body,id,source) {
    const c=getContest(id); if(!c.active)throw new Error('Cadastros finalizados para este concurso.');
    const data=registration(body), code=getCode(body.code,c.id);
    if(body.code && !code)throw new Error('Link de grupo inválido para este concurso.');
    const result=db.prepare('INSERT INTO registrations(contest_id,name,cpf,phone,code,source,cpf_final,consent_at,pix_type,pix_key,cpf_full) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(contest_id,cpf) DO UPDATE SET cpf_full=excluded.cpf_full').run(c.id,data.name,personal.hash(data.cpf),data.phone,code,source,data.cpf.slice(-4),new Date().toISOString(),data.pix_type,data.pix_key,data.cpf);
    return {created:result.changes>0};
  }
  app.post('/concursos/:id/confirmar',limit,(req,res)=>{
    if(req.body.consent!=='yes')throw new Error('É necessário autorizar o uso dos dados.');
    saveRegistration(req.body,req.params.id,'formulario');
    page(req,res,'Cadastro recebido','<section class="panel empty"><span class="badge">RECEBIDO</span><h1>Cadastro recebido!</h1><p>Os dados enviados foram processados. Se este CPF já estava cadastrado, o registro anterior foi mantido.</p><a class="button" href="/">Voltar aos concursos</a></section>');
  });
  app.use('/admin',guard);
  mountAccounts(app,db,users,page);
  mountBotAdmin(app,db,bot,page,guard);
  mountStaffing(app,db,staff,page,guard,bot.audit);
  mountManualRegistration(app,db,personal,page,bot.audit);
  app.get('/admin',(req,res)=>{
    const all=db.prepare(`SELECT * FROM contests WHERE id IN (${accessibleContests()}) ORDER BY active DESC, deadline`).all();
    const count=t=>db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${t==='clicks'?`code IN (SELECT code FROM links WHERE contest_id IN (${accessibleContests()}))`:`contest_id IN (${accessibleContests()})`}`).get().n;
    page(req,res,'Visão geral',`<div class="heading"><div><p class="eyebrow">PAINEL DO ORGANIZADOR</p><h1>Visão geral</h1><p>Acompanhe o caminho do primeiro clique à confirmação.</p></div><a class="button" href="/admin/contests/new">＋ Novo concurso</a></div><section class="stats">${[['Concursos publicados',all.filter(c=>c.active).length],['Cliques nos links',count('clicks')],['Cadastros recebidos',count('registrations')],['Grupos com link',count('links')]].map(([label,n])=>`<div><span>${label}</span><strong>${n}</strong></div>`).join('')}</section><div class="section-heading"><h2>Seus concursos</h2><span class="muted">${all.length} cadastrados</span></div>${cards(all,true)}`);
  });
  app.get('/admin/contests/new',(req,res)=>page(req,res,'Novo concurso',contestForm({},req.session.csrf)));
  app.post('/admin/contests/new',(req,res)=>{
    let c;
    try { c=contest(req.body); }
    catch(error) { return page(req,res,'Novo concurso',contestForm(req.body,req.session.csrf),400,error.message); }
    const result=db.prepare(`INSERT INTO contests(${fields.join(',')},owner_id) VALUES(${fields.map(()=>'?').join(',')},?) RETURNING id`).get(...fields.map(k=>c[k]),req.user.id); bot.audit('concurso.criado',result.id); res.redirect(`/admin/contests/${result.id}`);
  });
  app.get('/admin/contests/:id/edit',(req,res)=>page(req,res,'Editar concurso',contestForm(getContest(req.params.id),req.session.csrf)));
  app.post('/admin/contests/:id/edit',(req,res)=>{
    const existing=getContest(req.params.id);
    let c;
    try { c=contest(req.body,existing); }
    catch(error) { return page(req,res,'Editar concurso',contestForm({...req.body,id:existing.id},req.session.csrf),400,error.message); }
    db.prepare(`UPDATE contests SET ${fields.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...fields.map(k=>c[k]),req.params.id);bot.audit('concurso.atualizado',req.params.id);res.redirect(`/admin/contests/${req.params.id}`);
  });
  for(const [action,active] of [['close',0],['reopen',1]]) app.post(`/admin/contests/:id/${action}`,(req,res)=>{const c=getContest(req.params.id);db.prepare('UPDATE contests SET active=? WHERE id=?').run(active,c.id);bot.audit(active?'concurso.cadastros_reabertos':'concurso.cadastros_finalizados',c.id);res.redirect(`/admin/contests/${c.id}`);});
  app.get('/admin/contests/:id',(req,res)=>{
    const c=getContest(req.params.id);
    const links=db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM clicks WHERE code=l.code) clicks, (SELECT COUNT(DISTINCT visitor) FROM clicks WHERE code=l.code) visitors, (SELECT COUNT(*) FROM registrations WHERE code=l.code) confirmations FROM links l WHERE contest_id=?`).all(c.id);
    const clicks=db.prepare('SELECT l.group_name,c.created_at FROM clicks c JOIN links l ON l.code=c.code WHERE l.contest_id=? ORDER BY c.created_at DESC,c.rowid DESC LIMIT 50').all(c.id);
    page(req,res,c.title,`<a class="back" href="/admin">← Visão geral</a><div class="heading"><div><p class="eyebrow">CONCURSO · ${c.active?'CADASTROS ABERTOS':'CADASTROS FINALIZADOS'}</p><h1>${esc(c.title)}</h1><p>${esc(c.organizer)}</p></div><a class="button secondary" href="/admin/contests/${c.id}/edit">Editar informações</a></div><div class="toolbar"><a class="button" href="/admin/contests/${c.id}/registrations/new">Cadastrar colaborador</a><a class="button secondary" href="/admin/contests/${c.id}/roles">Cadastrar / gerenciar cargos</a><a href="/admin/contests/${c.id}/bot">FAQs e configuração do bot</a><a href="/concursos/${c.id}">Abrir página pública ↗</a><a href="/admin/registrations?contest=${c.id}">Ver cadastros →</a><form method="post" action="/admin/contests/${c.id}/${c.active?'close':'reopen'}">${csrf(req.session.csrf)}<button class="text">${c.active?'Finalizar cadastros':'Reabrir cadastros'}</button></form></div><section class="panel"><h2>Links por grupo</h2><p>Compartilhe um link diferente em cada grupo para acompanhar sua origem.</p><form class="inline" method="post" action="/admin/contests/${c.id}/links">${csrf(req.session.csrf)}${input('Nome do grupo','group_name','','text','maxlength="100"')}<button>Criar link curto</button></form>${table(['Grupo','Link para compartilhar','Cliques','Visitantes¹','Confirmações'],links.map(l=>[esc(l.group_name),`<a href="/l/${l.code}">${esc(config.baseUrl)}/l/${l.code}</a>`,l.clicks,l.visitors,l.confirmations]))}<small>¹ Estimativa por sessão do navegador. Cliques incluem repetições e podem incluir prévias automáticas do WhatsApp.</small></section><section class="panel"><h2>Acessos recentes</h2><p>Visitantes anônimos só são identificados após uma confirmação. Últimos 50 acessos.</p>${table(['Grupo','Data (UTC)'],clicks.map(c=>[esc(c.group_name),esc(c.created_at)]))}</section>`);
  });
  app.post('/admin/contests/:id/links',(req,res)=>{const c=getContest(req.params.id),group=String(req.body.group_name??'').trim();if(!group||group.length>100)throw new Error('Informe um nome de grupo com até 100 caracteres.');db.prepare('INSERT INTO links(code,contest_id,group_name) VALUES(?,?,?)').run(randomBytes(6).toString('base64url'),c.id,group);res.redirect(`/admin/contests/${c.id}`);});
  app.get('/admin/registrations',(req,res)=>{
    const filter=req.query.contest?id(req.query.contest):null;
    const rows=db.prepare(`SELECT r.*, c.title,l.group_name FROM registrations r JOIN contests c ON c.id=r.contest_id LEFT JOIN links l ON l.code=r.code WHERE r.contest_id IN (${accessibleContests()}) ${filter?'AND r.contest_id=?':''} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 500`).all(...(filter?[filter]:[]));
    const contests=db.prepare(`SELECT id,title FROM contests WHERE id IN (${accessibleContests()})`).all();
    page(req,res,'Trabalhadores',`<div class="heading"><div><p class="eyebrow">ACOMPANHAMENTO</p><h1>Cadastros para trabalhar</h1><p>Dados declarados pelos participantes. Até 500 registros recentes.</p></div></div><section class="panel"><form class="inline" method="get"><label>Concurso<select name="contest"><option value="">Todos os concursos</option>${contests.map(c=>`<option value="${c.id}" ${filter===c.id?'selected':''}>${esc(c.title)}</option>`).join('')}</select></label><button class="secondary">Filtrar</button></form>${table(['Nome / WhatsApp','CPF','Pix','Concurso','Cargos / períodos / valores','Grupo','Origem','Data (UTC)','Ações'],rows.map(r=>[`${esc(r.name)}<small>${esc(maskPhone(r.phone))}</small>`,esc(r.cpf_full|| (r.cpf_final?maskCpf(r.cpf_final)+' (completar CPF)':'Não informado')),r.pix_key?`${esc(pixTypes[r.pix_type])}<small>${esc(r.pix_key)}</small>`:'Não informado',esc(r.title),roleSummary(staff.assigned(r.id)),esc(r.group_name||'Direto'),esc(r.source),esc(r.created_at),`<a href="/admin/registrations/${r.id}/edit">Editar dados</a> <a href="/admin/registrations/${r.id}/roles">Definir cargos</a><form method="post" action="/admin/registrations/${r.id}/delete">${csrf(req.session.csrf)}<button class="text">Excluir dados</button></form>`]))}</section>`);
  });
  app.get('/admin/messages',(req,res)=>{
    const rows=db.prepare('SELECT * FROM messages ORDER BY created_at DESC,rowid DESC LIMIT 100').all();
    page(req,res,'WhatsApp',`<div class="heading"><div><p class="eyebrow">INTEGRAÇÃO N8N</p><h1>Central de mensagens</h1><p>Receba eventos e envie mensagens pelo seu fluxo do WhatsApp.</p></div><span class="badge">${config.outboundUrl?'Saída configurada':'Saída não configurada'}</span></div><div class="detail-grid"><section class="panel"><h2>Enviar mensagem</h2><form method="post" action="/admin/messages">${csrf(req.session.csrf)}${input('WhatsApp com DDI e DDD','phone','','tel')}<label>Mensagem<textarea name="body" required maxlength="4000" rows="6"></textarea></label><button ${config.outboundUrl?'':'disabled'}>Enviar para o n8n →</button></form><small>O aceite pelo n8n não confirma a entrega no WhatsApp.</small></section><section class="panel"><h2>Recebimento de eventos</h2><p>Endpoint para o seu fluxo:</p><code>POST /api/webhooks/n8n</code><p>Autenticação via Bearer token definido no arquivo de configuração.</p><p>Eventos aceitos: <code>registration.completed</code> e <code>whatsapp.message</code>.</p><small>Configure N8N_OUTBOUND_URL e os tokens no .env. O contrato completo está no README do projeto.</small></section></div><section class="panel"><h2>Histórico recente</h2>${table(['Direção','WhatsApp','Mensagem','Status','Data (UTC)'],rows.map(m=>[m.direction==='in'?'Recebida':'Enviada',esc(maskPhone(m.phone)),esc(redact(m.body)),esc(m.status),esc(m.created_at)]))}</section>`);
  });
  app.post('/admin/messages',limit,async(req,res)=>{
    if(!config.outboundUrl)throw new Error('Configure o endereço do n8n antes de enviar.');
    const phone=digits(req.body.phone),body=String(req.body.body??'').trim();
    if(!/^\d{10,15}$/.test(phone)||!body||body.length>4000)throw new Error('Telefone ou mensagem inválida.');
    const {id:messageId}=db.prepare("INSERT INTO messages(direction,phone,body,status) VALUES('out',?,?,'pendente') RETURNING id").get(phone,redact(body));
    try {
      const response=await fetch(config.outboundUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(config.outboundToken?{Authorization:`Bearer ${config.outboundToken}`}:{})},body:JSON.stringify({event_id:`out-${messageId}`,type:'whatsapp.send',phone,message:body}),signal:AbortSignal.timeout(10000)});
      db.prepare('UPDATE messages SET status=? WHERE id=?').run(response.ok?'aceito pelo n8n':`falha HTTP ${response.status}`,messageId);
    } catch { db.prepare("UPDATE messages SET status='resultado incerto; confira no n8n' WHERE id=?").run(messageId); }
    res.redirect('/admin/messages');
  });
  app.post('/api/webhooks/n8n',limit,(req,res)=>{
    if(!config.webhookToken||!safeEqual(req.get('authorization'),`Bearer ${config.webhookToken}`))return res.status(401).json({error:'Não autorizado'});
    const b=req.body;
    if(typeof b.event_id!=='string'||!b.event_id.trim()||b.event_id.length>150)return res.status(400).json({error:'event_id obrigatório (até 150 caracteres)'});
    db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare('SELECT 1 FROM events WHERE event_id=?').get(b.event_id)){db.exec('COMMIT');return res.json({ok:true,duplicate:true});}
      if(b.type==='registration.completed') {
        if(b.consent!==true)throw new Error('consent deve ser true, com autorização obtida no fluxo.');
        id(b.contest_id);
        saveRegistration(b,b.contest_id,'n8n');
      } else if(b.type==='whatsapp.message') {
        const phone=digits(b.phone);if(!/^\d{10,15}$/.test(phone)||typeof b.message!=='string'||!b.message.trim()||b.message.length>4000)throw new Error('Mensagem inválida.');
        db.prepare("INSERT INTO messages(direction,phone,body,status) VALUES('in',?,?,'recebida')").run(phone,redact(b.message));
      } else throw new Error('Tipo de evento não suportado.');
      db.prepare('INSERT INTO events(event_id,kind) VALUES(?,?)').run(b.event_id,b.type);db.exec('COMMIT');res.json({ok:true});
    } catch(error){db.exec('ROLLBACK');res.status(400).json({error:error.message});}
  });
  app.use((req,res)=>page(req,res,'Não encontrado','<h1>Página não encontrada.</h1><a href="/">Voltar ao início</a>',404));
  app.use((error,req,res,next)=>{const status=error.status||400;page(req,res,'Não foi possível concluir','<h1>Não foi possível concluir.</h1><p>Volte à página anterior para revisar os dados.</p>',status,error.code?'N?o foi poss?vel salvar os dados.':redact(error.message));});
  return app;
}
