import { randomBytes, randomUUID } from 'node:crypto';
import { accessibleContests } from './accounts.js';
import { id } from './bot-service.js';
import { csrf, esc, table } from './views.js';
import { fields } from './validation.js';

const fail = message => { throw new Error(message); };
const clean = (row,exclude=[]) => Object.fromEntries(Object.entries(row).filter(([key])=>!exclude.includes(key)));
const toInt = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;

function contestFor(db,contestId) {
  const contest=db.prepare(`SELECT * FROM contests WHERE id=? AND id IN (${accessibleContests()})`).get(contestId);
  return contest || fail('Concurso não encontrado.');
}

export function exportContest(db,contestId) {
  const contest=contestFor(db,contestId);
  const links=db.prepare('SELECT * FROM links WHERE contest_id=? ORDER BY group_name,created_at,rowid').all(contest.id);
  const roles=db.prepare('SELECT * FROM roles WHERE contest_id=? ORDER BY name,period,rowid').all(contest.id);
  const registrations=db.prepare('SELECT * FROM registrations WHERE contest_id=? ORDER BY name COLLATE NOCASE,created_at,rowid').all(contest.id);
  const registrationRoles=db.prepare(`SELECT rr.* FROM registration_roles rr JOIN registrations r ON r.id=rr.registration_id
    WHERE r.contest_id=? ORDER BY rr.registration_id,rr.role_id`).all(contest.id);
  const rooms=db.prepare('SELECT * FROM rooms WHERE contest_id=? ORDER BY name COLLATE NOCASE,rowid').all(contest.id);
  const roomRoles=db.prepare(`SELECT rr.* FROM room_roles rr JOIN rooms ro ON ro.id=rr.room_id
    WHERE ro.contest_id=? ORDER BY rr.room_id,rr.role_id`).all(contest.id);
  const roomAssignments=db.prepare(`SELECT ra.* FROM room_assignments ra JOIN rooms ro ON ro.id=ra.room_id
    WHERE ro.contest_id=? ORDER BY ra.room_id,ra.role_id,ra.registration_id`).all(contest.id);
  return {
    type:'ponto-de-prova.contest',
    version:1,
    exported_at:new Date().toISOString(),
    contest:clean(contest,['owner_id']),
    links,
    roles,
    registrations,
    registration_roles:registrationRoles,
    rooms,
    room_roles:roomRoles,
    room_assignments:roomAssignments
  };
}

function uniqueCode(db,preferred) {
  const base=String(preferred||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);
  if(base && !db.prepare('SELECT 1 FROM links WHERE code=?').get(base)) return base;
  let code;
  do code=randomBytes(6).toString('base64url'); while(db.prepare('SELECT 1 FROM links WHERE code=?').get(code));
  return code;
}

export function importContest(db,personal,user,payload) {
  if(!payload || payload.type!=='ponto-de-prova.contest' || !payload.contest) fail('Arquivo de concurso inválido.');
  const source=payload.contest;
  const contestId=randomUUID();
  const contestValues=fields.map(key=>source[key] ?? '');
  const linkMap=new Map(),roleMap=new Map(),registrationMap=new Map(),roomMap=new Map();
  db.exec('SAVEPOINT import_contest');
  try {
    db.prepare(`INSERT INTO contests(id,${fields.join(',')},active,owner_id) VALUES(?${fields.map(()=>',?').join('')},?,?)`)
      .run(contestId,...contestValues,source.active?1:0,user.id);
    for(const link of payload.links||[]) {
      const code=uniqueCode(db,link.code);
      linkMap.set(link.code,code);
      db.prepare('INSERT INTO links(code,contest_id,group_name,created_at) VALUES(?,?,?,coalesce(?,CURRENT_TIMESTAMP))')
        .run(code,contestId,String(link.group_name||'Grupo').slice(0,100),link.created_at||null);
    }
    for(const role of payload.roles||[]) {
      const newId=randomUUID();
      roleMap.set(role.id,newId);
      db.prepare(`INSERT INTO roles(id,contest_id,name,period,amount_cents,quantity,legacy_amount,created_at)
        VALUES(?,?,?,?,?,?,?,coalesce(?,CURRENT_TIMESTAMP))`)
        .run(newId,contestId,role.name,role.period??null,role.amount_cents??null,toInt(role.quantity),role.legacy_amount??null,role.created_at||null);
    }
    for(const registration of payload.registrations||[]) {
      const newId=randomUUID(),cpfFull=String(registration.cpf_full||'').replace(/\D/g,'');
      const cpfHash=cpfFull.length===11?personal.hash(cpfFull):`pending:${newId}`;
      registrationMap.set(registration.id,newId);
      db.prepare(`INSERT INTO registrations(id,contest_id,name,cpf,phone,code,source,created_at,cpf_final,consent_at,pix_type,pix_key,cpf_full)
        VALUES(?,?,?,?,?,?,?,coalesce(?,CURRENT_TIMESTAMP),?,?,?,?,?)`)
        .run(newId,contestId,registration.name,cpfHash,registration.phone||'',linkMap.get(registration.code)||null,
          registration.source||'importacao',registration.created_at||null,cpfFull?cpfFull.slice(-4):(registration.cpf_final||''),
          registration.consent_at||null,registration.pix_type||null,registration.pix_key||null,cpfFull||null);
    }
    for(const link of payload.registration_roles||[]) {
      const registrationId=registrationMap.get(link.registration_id),roleId=roleMap.get(link.role_id);
      if(registrationId&&roleId) db.prepare('INSERT OR IGNORE INTO registration_roles(registration_id,role_id) VALUES(?,?)').run(registrationId,roleId);
    }
    for(const room of payload.rooms||[]) {
      const newId=randomUUID();
      roomMap.set(room.id,newId);
      db.prepare('INSERT INTO rooms(id,contest_id,name,created_at) VALUES(?,?,?,coalesce(?,CURRENT_TIMESTAMP))')
        .run(newId,contestId,room.name,room.created_at||null);
    }
    for(const link of payload.room_roles||[]) {
      const roomId=roomMap.get(link.room_id),roleId=roleMap.get(link.role_id);
      if(roomId&&roleId) db.prepare('INSERT OR IGNORE INTO room_roles(room_id,role_id,quantity) VALUES(?,?,?)').run(roomId,roleId,toInt(link.quantity)||1);
    }
    for(const link of payload.room_assignments||[]) {
      const roomId=roomMap.get(link.room_id),roleId=roleMap.get(link.role_id),registrationId=registrationMap.get(link.registration_id);
      if(roomId&&roleId&&registrationId) db.prepare('INSERT OR IGNORE INTO room_assignments(room_id,registration_id,role_id) VALUES(?,?,?)').run(roomId,registrationId,roleId);
    }
    db.exec('RELEASE import_contest');
    return contestId;
  } catch(error) {
    db.exec('ROLLBACK TO import_contest; RELEASE import_contest');
    throw error;
  }
}

export function mountContestTransfer(app,db,personal,page,audit) {
  const importPage=(token,result=null,draft='')=>`<a class="back" href="/admin">← Visão geral</a><div class="heading"><div><p class="eyebrow">BACKUP</p><h1>Importar concurso</h1><p>Cole o JSON exportado de outro concurso para criar uma cópia nova.</p></div></div>
    <form class="panel form-grid" method="post">${csrf(token)}
      <label class="wide">Arquivo JSON<input type="file" accept=".json,application/json" data-fill="import-contest"></label>
      <label class="wide">Dados do concurso<textarea id="import-contest" name="content" rows="14" required>${esc(draft)}</textarea></label>
      <button>Importar concurso</button>
    </form>
    <script>document.querySelector('[data-fill="import-contest"]')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(file)document.getElementById('import-contest').value=await file.text();});</script>
    ${result?`<section class="panel"><h2>Importação concluída</h2>${table(['Concurso criado'],[[`<a href="/admin/contests/${result.id}">${esc(result.title)}</a>`]])}</section>`:''}`;
  app.get('/admin/contests/import',(req,res)=>page(req,res,'Importar concurso',importPage(req.session.csrf)));
  app.post('/admin/contests/import',(req,res)=>{
    try {
      const payload=JSON.parse(String(req.body.content||''));
      const contestId=importContest(db,personal,req.user,payload);
      audit('concurso.importado',contestId);
      const contest=db.prepare('SELECT id,title FROM contests WHERE id=?').get(contestId);
      page(req,res,'Importar concurso',importPage(req.session.csrf,contest,req.body.content));
    } catch(error) {
      page(req,res,'Importar concurso',importPage(req.session.csrf,null,req.body.content),400,error.message);
    }
  });
  app.get('/admin/contests/:id/export',(req,res)=>{
    const contestId=id(req.params.id),payload=exportContest(db,contestId);
    const filename=String(payload.contest.title||'concurso').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'concurso';
    audit('concurso.exportado',contestId);
    res.set('Content-Type','application/json; charset=utf-8');
    res.set('Content-Disposition',`attachment; filename="${filename}.json"`);
    res.send(JSON.stringify(payload,null,2));
  });
}
