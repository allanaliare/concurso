import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail, id, text } from './bot-service.js';

export function botRouter(service,config) {
  const router=express.Router(), windows=new Map();
  router.use((req,res,next)=>{
    const hash=v=>createHash('sha256').update(String(v??'')).digest();
    if(!config.internalToken||!timingSafeEqual(hash(req.get('authorization')),hash(`Bearer ${config.internalToken}`)))return res.status(401).json({error:'Não autorizado.'});
    const now=Date.now(),key=req.ip;
    if(!windows.has(key)||windows.get(key).until<now)windows.set(key,{until:now+60000,n:0});
    if(++windows.get(key).n>300)return res.status(429).json({error:'Limite de 300 requisições/minuto.'});
    next();
  });
  router.post('/processar-mensagem',(req,res)=>res.json(service.processMessage(req.body)));
  router.post('/mensagens/:id/resposta-ia',(req,res)=>res.json(service.aiResponse(req.params.id,req.body)));
  router.post('/mensagens/:id/resultado',(req,res)=>res.json(service.delivery(req.params.id,req.body)));
  router.get('/lembretes-pendentes',(req,res)=>res.json({items:service.due(req.query.limite??50)}));
  router.post('/lembretes/:id/processando',(req,res)=>res.json(service.claim(req.params.id)));
  router.post('/lembretes/:id/enviado',(req,res)=>res.json(service.finish(req.params.id,req.body,true)));
  router.post('/lembretes/:id/erro',(req,res)=>res.json(service.finish(req.params.id,req.body,false)));
  router.post('/registrar-erro',(req,res)=>res.json(service.registerError(req.body)));
  router.post('/confirmar-cadastro',(req,res)=>{
    const g=service.getGroup(id(req.body.group_id)),c=service.getContest(g.contest_id);
    if(!g.active||!c.active)fail('Grupo ou concurso pausado.',409);
    const target=text(req.body.participantJid,150);
    if(!/^\d+@(s\.whatsapp\.net|lid)$/.test(target))fail('Informe um destinatário privado válido.');
    res.json({action:'SEND_PRIVATE_MESSAGE',instance:g.instance,target,text:`Confirme sua inscrição pelo formulário: ${config.baseUrl}/l/${g.code}. Não envie CPF pelo WhatsApp.`});
  });
  router.post('/informar-cpf',(req,res)=>res.status(422).json({error:'CPF deve ser informado exclusivamente no formulário de confirmação. Use /confirmar-cadastro para obter o link.'}));
  router.use((error,req,res,next)=>res.status(error.status||400).json({error:error.code?'Não foi possível processar a solicitação.':error.message}));
  return router;
}
