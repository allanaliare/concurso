import QRCode from 'qrcode';
import { accessibleContests } from './accounts.js';
import { periods } from './staffing.js';
import { esc, table, money, csrf } from './views.js';
import { id } from './bot-service.js';
import { pixTypes } from './validation.js';

const ascii = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7E]/g,'').trim();
const tlv = (id,value) => `${id}${String(value).length.toString().padStart(2,'0')}${value}`;
const formatCpf = value => String(value ?? '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/,'$1.$2.$3-$4');
const printLayout = (title,body,css='') => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Ponto de Prova</title><style>${css}</style></head><body>${body}</body></html>`;

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
  async function printData(contestId) {
    const contest=db.prepare(`SELECT * FROM contests WHERE id=? AND id IN (${accessibleContests()})`).get(contestId);
    if(!contest) throw Object.assign(new Error('Concurso nao encontrado.'),{status:404});
    const roles=staff.list(contest.id);
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
    return {contest,roles,people,byPerson,qrByPerson};
  }
  function receiptSelection(req,res,contest,people,error='') {
    const personCard=person=>`<label class="receipt-person" data-name="${esc(person.name.toLowerCase())}"><input type="checkbox" name="selected" value="${person.id}"><span>${esc(person.name)}<small>${esc(formatCpf(person.cpf_full))}</small></span></label>`;
    const printIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6zM17 12h.01"/></svg>';
    page(req,res,'Guias de pagamento',`<a class="back" href="/admin/registrations?contest=${contest.id}">Voltar aos colaboradores</a><section class="panel receipt-picker-panel"><div class="section-heading"><div><p class="eyebrow">GUIAS DE PAGAMENTO</p><h1>Escolha os colaboradores</h1><p class="muted">${people.length} colaborador${people.length===1?'':'es'} cadastrado${people.length===1?'':'s'}</p></div><strong id="receipt-count">0 selecionados</strong></div><form data-receipt-picker method="post" action="/admin/contests/${contest.id}/registrations/receipts/print">${csrf(req.session.csrf)}<div class="receipt-picker-tools"><div><label>Buscar por nome<input id="receipt-search" type="search" placeholder="Digite o nome"></label><label class="check receipt-select-all"><input id="receipt-all" type="checkbox"> Selecionar todos</label></div><button class="icon-action receipt-print" title="Imprimir guias selecionadas" aria-label="Imprimir guias selecionadas">${printIcon}</button></div><p class="error" id="receipt-empty" ${error?'':'hidden'}>${esc(error||'Marque pelo menos um colaborador para imprimir.')}</p><div class="receipt-columns"><section><h2>Não vinculados</h2><div class="receipt-list" id="receipt-available">${people.map(personCard).join('')||'<div class="empty muted">Nenhum colaborador cadastrado.</div>'}</div></section><section><h2>Vinculados</h2><div class="receipt-list selected" id="receipt-chosen"></div></section></div></form></section><script src="/receipt-picker.js" defer></script>`,error?400:200,error);
  }
  app.get(['/admin/registrations/print','/admin/contests/:id/registrations/print'],async(req,res,next)=>{
    try {
      const contestId=req.params.id?id(req.params.id):(req.query.contest?id(req.query.contest):null);
      if(!contestId) throw Object.assign(new Error('Selecione um concurso para imprimir.'),{status:400});
      const {contest,roles,people,byPerson,qrByPerson}=await printData(contestId);
      const rowsFor=rows=>table(['CPF','Nome','Pix','QR Code'],rows.map(person=>[
        esc(formatCpf(person.cpf_full)),
        esc(person.name),
        person.pix_key?`${esc(pixTypes[person.pix_type]||person.pix_type)}<small>${esc(person.pix_key)}</small>`:'Nao informado',
        qrByPerson.get(person.id)?`<div class="pix-qr">${qrByPerson.get(person.id)}</div>`:'Sem Pix'
      ]),'Nenhum colaborador neste grupo.');
      const sections=roles.map(role=>{
        const rows=people.filter(person=>(byPerson.get(person.id)||[]).includes(role.id));
        const details=role.period&&role.amount_cents!==null
          ? `${periods[role.period]} - ${money(role.amount_cents/100)} - ${rows.length}/${role.quantity}`
          : `${rows.length} colaborador${rows.length===1?'':'es'} - cargo pendente de periodo e valor`;
        return {count:rows.length,name:role.name,html:`<section class="print-group"><div class="print-group-title"><h2>${esc(role.name)}</h2><span>${details}</span></div>${rowsFor(rows)}</section>`};
      }).sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name,'pt-BR')).map(section=>section.html);
      const withoutRole=people.filter(person=>!(byPerson.get(person.id)||[]).length);
      if(withoutRole.length) sections.push(`<section class="print-group"><div class="print-group-title"><h2>Sem cargo definido</h2><span>${withoutRole.length} colaborador${withoutRole.length===1?'':'es'}</span></div>${rowsFor(withoutRole)}</section>`);
      page(req,res,'Lista de pagamento',`<div class="print-actions"><a class="back" href="/admin/registrations?contest=${contest.id}">Voltar aos colaboradores</a><button type="button" onclick="window.print()">Imprimir</button></div><section class="print-head"><p class="eyebrow">LISTA DE PAGAMENTO</p><h1>${esc(contest.title)}</h1><p>${esc(contest.organizer)} - ${esc(contest.location)}</p></section>${sections.join('')||'<div class="empty muted">Nenhum colaborador cadastrado.</div>'}`);
    } catch(error) { next(error); }
  });
  app.get(['/admin/registrations/receipts','/admin/contests/:id/registrations/receipts'],async(req,res,next)=>{
    try {
      const contestId=req.params.id?id(req.params.id):(req.query.contest?id(req.query.contest):null);
      if(!contestId) throw Object.assign(new Error('Selecione um concurso para imprimir.'),{status:400});
      const {contest,people,byPerson,qrByPerson}=await printData(contestId);
      receiptSelection(req,res,contest,people);
    } catch(error) { next(error); }
  });
  app.post(['/admin/registrations/receipts/print','/admin/contests/:id/registrations/receipts/print'],async(req,res,next)=>{
    try {
      const contestId=req.params.id?id(req.params.id):(req.body.contest?id(req.body.contest):null);
      if(!contestId) throw Object.assign(new Error('Selecione um concurso para imprimir.'),{status:400});
      const {contest,people,byPerson,qrByPerson}=await printData(contestId);
      const selected=new Set((Array.isArray(req.body.selected)?req.body.selected:[req.body.selected]).filter(Boolean).map(value=>id(value)));
      if(!selected.size) return receiptSelection(req,res,contest,people,'Marque pelo menos um colaborador para imprimir.');
      const selectedPeople=people.filter(person=>selected.has(person.id));
      const roleById=new Map(staff.list(contest.id).map(role=>[role.id,role]));
      const receipt=person=>{
        const assigned=(byPerson.get(person.id)||[]).map(roleId=>roleById.get(roleId)).filter(Boolean);
        const amount=assigned.some(role=>role.amount_cents!==null)
          ? money(assigned.reduce((sum,role)=>sum+(role.amount_cents||0),0)/100)
          : 'A definir';
        const roleNames=assigned.length?assigned.map(role=>role.name).join(' / '):'Sem cargo definido';
        return `<section class="receipt"><p class="receipt-eyebrow">COMANDA DE PAGAMENTO</p><h1>${esc(person.name)}</h1><dl><div><dt>CPF</dt><dd>${esc(formatCpf(person.cpf_full))}</dd></div><div><dt>Concurso</dt><dd>${esc(contest.title)}</dd></div><div><dt>Cargo</dt><dd>${esc(roleNames)}</dd></div><div><dt>Valor</dt><dd>${amount}</dd></div></dl><div class="receipt-qr">${qrByPerson.get(person.id)||'<span>Sem Pix</span>'}</div><p class="receipt-pix">${person.pix_key?`${esc(pixTypes[person.pix_type]||person.pix_type)}: ${esc(person.pix_key)}`:'Pix não informado'}</p><div class="receipt-cut"><span>cortar aqui</span></div></section>`;
      };
      const css=`@page{size:80mm auto;margin:0}*{box-sizing:border-box}html,body{width:80mm;margin:0;background:#fff;color:#111;font-family:Arial,sans-serif}.receipt-actions{width:80mm;display:grid;gap:8px;padding:8px;border-bottom:1px solid #ddd}.receipt-actions a,.receipt-actions button{font:700 13px Arial,sans-serif;color:#111}.receipt-actions button{border:1px solid #111;background:#fff;border-radius:4px;padding:8px 10px}.receipt-hint{font-size:11px;line-height:1.3;margin:0;color:#444}.receipt{width:80mm;margin:0;padding:5mm 4mm 3mm;text-align:center;overflow:hidden;break-inside:avoid;page-break-inside:avoid}.receipt-eyebrow{font-size:9px;font-weight:700;letter-spacing:.8px;margin:0 0 3mm}.receipt h1{font-size:17px;line-height:1.15;margin:0 0 4mm;text-transform:uppercase;overflow-wrap:anywhere}dl{margin:0 0 4mm;text-align:left;border-top:1px dashed #111}dl div{display:flex;justify-content:space-between;gap:3mm;border-bottom:1px dashed #111;padding:2mm 0}dt{font-size:9px;font-weight:700;text-transform:uppercase}dd{margin:0;text-align:right;font-size:10px;font-weight:700;max-width:48mm;overflow-wrap:anywhere}.receipt-qr{display:grid;place-items:center;margin:2mm auto}.receipt-qr svg{display:block;width:48mm;height:48mm}.receipt-qr span{display:block;border:1px solid #111;padding:16mm 8mm;font-weight:700}.receipt-pix{font-size:9px;line-height:1.25;margin:3mm 0 0;overflow-wrap:anywhere}.receipt-cut{display:flex;align-items:center;gap:2mm;margin:4mm -1mm 0;color:#111;font-size:8px;text-transform:uppercase;letter-spacing:.5px}.receipt-cut:before,.receipt-cut:after{content:"";height:0;border-top:1px dashed #111;flex:1}.receipt-cut span{white-space:nowrap}@media print{@page{size:80mm auto;margin:0}html,body{width:80mm;height:auto;margin:0}.receipt-actions{display:none!important}.receipt{width:80mm;margin:0;break-inside:avoid;page-break-inside:avoid;break-after:auto;page-break-after:auto}}`;
      const actions=`<div class="receipt-actions"><a href="/admin/contests/${contest.id}/registrations/receipts">Voltar</a><button type="button" onclick="window.print()">Imprimir comandas 80mm</button><p class="receipt-hint">Use papel 80mm/recibo na impressora. As comandas saem em sequência na bobina, com linha pontilhada para corte.</p></div>`;
      res.send(printLayout('Comandas 80mm',actions+(selectedPeople.length?selectedPeople.map(receipt).join(''):'<section class="receipt"><h1>Nenhum colaborador selecionado.</h1></section>'),css));
    } catch(error) { next(error); }
  });
}
