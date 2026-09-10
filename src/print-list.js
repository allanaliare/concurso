import QRCode from 'qrcode';
import { accessibleContests } from './accounts.js';
import { periods } from './staffing.js';
import { esc, table, money } from './views.js';
import { maskPhone } from './privacy.js';
import { id } from './bot-service.js';
import { pixTypes } from './validation.js';

const ascii = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7E]/g,'').trim();
const tlv = (id,value) => `${id}${String(value).length.toString().padStart(2,'0')}${value}`;

function crc16(payload) {
  let crc=0xffff;
  for(const ch of payload) {
    crc^=ch.charCodeAt(0)<<8;
    for(let i=0;i<8;i++) crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4,'0');
}

function pixPayload(registration,contest) {
  if(!registration.pix_key) return '';
  const merchant=ascii(registration.name).toUpperCase().slice(0,25) || 'PONTO DE PROVA';
  const city=ascii(contest.location).toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').slice(0,15) || 'BRASILIA';
  const key=String(registration.pix_key).replace(/[\r\n\t]/g,' ').trim().slice(0,77);
  const txid=String(registration.id).replace(/[^A-Za-z0-9]/g,'').slice(0,25) || 'PONTODEPROVA';
  const account=tlv('00','br.gov.bcb.pix')+tlv('01',key);
  const payload=tlv('00','01')+tlv('01','12')+tlv('26',account)+tlv('52','0000')+tlv('53','986')+tlv('58','BR')+tlv('59',merchant)+tlv('60',city)+tlv('62',tlv('05',txid))+'6304';
  return payload+crc16(payload);
}

export function mountPrintList(app,db,staff,page) {
  app.get(['/admin/registrations/print','/admin/contests/:id/registrations/print'],async(req,res,next)=>{
    try {
      const contestId=req.params.id?id(req.params.id):(req.query.contest?id(req.query.contest):null);
      if(!contestId) throw Object.assign(new Error('Selecione um concurso para imprimir.'),{status:400});
      const contest=db.prepare(`SELECT * FROM contests WHERE id=? AND id IN (${accessibleContests()})`).get(contestId);
      if(!contest) throw Object.assign(new Error('Concurso nao encontrado.'),{status:404});
      const roles=staff.list(contest.id).filter(r=>r.period&&r.amount_cents!==null);
      const people=db.prepare(`SELECT r.*, l.group_name FROM registrations r LEFT JOIN links l ON l.code=r.code
        WHERE r.contest_id=? ORDER BY r.name COLLATE NOCASE,r.created_at`).all(contest.id);
      const links=db.prepare('SELECT rr.registration_id,rr.role_id FROM registration_roles rr JOIN roles ro ON ro.id=rr.role_id WHERE ro.contest_id=?').all(contest.id);
      const byPerson=new Map();
      for(const link of links) byPerson.set(link.registration_id,[...(byPerson.get(link.registration_id)||[]),link.role_id]);
      const qrByPerson=new Map();
      for(const person of people) {
        const payload=pixPayload(person,contest);
        if(payload) qrByPerson.set(person.id,await QRCode.toString(payload,{type:'svg',width:92,margin:1,errorCorrectionLevel:'M'}));
      }
      const rowsFor=rows=>table(['Pago','Nome','WhatsApp','CPF','Pix','QR Pix','Grupo'],rows.map(person=>[
        '<span class="paid-box"></span>',
        esc(person.name),
        esc(maskPhone(person.phone)),
        esc(person.cpf_full||''),
        person.pix_key?`${esc(pixTypes[person.pix_type]||person.pix_type)}<small>${esc(person.pix_key)}</small>`:'Nao informado',
        qrByPerson.get(person.id)?`<div class="pix-qr">${qrByPerson.get(person.id)}</div>`:'Sem Pix',
        esc(person.group_name||'Direto')
      ]),'Nenhum colaborador neste grupo.');
      const sections=roles.map(role=>{
        const rows=people.filter(person=>(byPerson.get(person.id)||[]).includes(role.id));
        return `<section class="print-group"><div class="print-group-title"><h2>${esc(role.name)}</h2><span>${periods[role.period]} - ${money(role.amount_cents/100)} - ${rows.length}/${role.quantity}</span></div>${rowsFor(rows)}</section>`;
      });
      const withoutRole=people.filter(person=>!(byPerson.get(person.id)||[]).length);
      if(withoutRole.length) sections.push(`<section class="print-group"><div class="print-group-title"><h2>Sem cargo definido</h2><span>${withoutRole.length} colaborador${withoutRole.length===1?'':'es'}</span></div>${rowsFor(withoutRole)}</section>`);
      page(req,res,'Lista de pagamento',`<div class="print-actions"><a class="back" href="/admin/registrations?contest=${contest.id}">Voltar aos colaboradores</a><button type="button" onclick="window.print()">Imprimir</button></div><section class="print-head"><p class="eyebrow">LISTA DE PAGAMENTO</p><h1>${esc(contest.title)}</h1><p>${esc(contest.organizer)} - ${esc(contest.location)}</p></section>${sections.join('')||'<div class="empty muted">Nenhum colaborador cadastrado.</div>'}`);
    } catch(error) { next(error); }
  });
}
