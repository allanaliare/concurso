export const periods = {1:'Manhã',2:'Tarde',3:'Manhã e Tarde'};
const fail = message => { throw new Error(message); };
export const roleIds = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];

export function migrateStaffing(db) {
  if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=6').get()) return;
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE roles (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (uuid()),
      contest_id TEXT NOT NULL REFERENCES contests(id),name TEXT NOT NULL,
      period INTEGER CHECK(period IN (1,2,3)),amount_cents INTEGER CHECK(amount_cents>=0),
      quantity INTEGER NOT NULL CHECK(quantity>=0),legacy_amount TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX idx_roles_contest ON roles(contest_id);
    CREATE TABLE registration_roles (
      registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id),PRIMARY KEY(registration_id,role_id));
    CREATE INDEX idx_registration_roles_role ON registration_roles(role_id);
    INSERT INTO roles(contest_id,name,quantity,legacy_amount)
      SELECT id,role,vacancies,salary FROM contests WHERE trim(coalesce(role,''))<>'';
    INSERT INTO schema_migrations(version) VALUES(6); COMMIT;`);
}

export function staffing(db) {
  function transaction(fn) {
    db.exec('SAVEPOINT staffing');
    try { const result=fn(); db.exec('RELEASE staffing'); return result; }
    catch(error) { db.exec('ROLLBACK TO staffing; RELEASE staffing'); throw error; }
  }
  function get(roleId) {
    const row=typeof roleId==='string' && db.prepare('SELECT * FROM roles WHERE id=?').get(roleId);
    return row || fail('Cargo não encontrado.');
  }
  const list=contestId=>db.prepare(`SELECT r.*,(SELECT COUNT(*) FROM registration_roles WHERE role_id=r.id) assigned
    FROM roles r WHERE contest_id=? ORDER BY r.name,r.period,r.rowid`).all(contestId);
  const assigned=registrationId=>db.prepare(`SELECT r.* FROM roles r JOIN registration_roles rr ON rr.role_id=r.id
    WHERE rr.registration_id=? ORDER BY r.period,r.name`).all(registrationId);
  function refresh(contestId) {
    const roles=list(contestId),ready=roles.filter(r=>r.period && r.amount_cents!==null);
    db.prepare('UPDATE contests SET role=?,vacancies=?,salary=? WHERE id=?').run(
      roles.map(r=>r.name).join(', '),ready.reduce((n,r)=>n+r.quantity,0),
      ready.length?'Conforme o cargo':'A definir',contestId);
  }
  function save(contestId,body,roleId) {
    const name=typeof body.name==='string'?body.name.trim():'';
    const period=Number(body.period),quantity=Number(body.quantity);
    const raw=String(body.amount??'').trim().replace(',','.');
    const amount=Math.round(Number(raw)*100);
    if(!name || name.length>150) fail('Informe o nome do cargo com até 150 caracteres.');
    if(!Object.hasOwn(periods,period)) fail('Selecione Manhã, Tarde ou Manhã e Tarde.');
    if(!/^\d+(\.\d{1,2})?$/.test(raw) || !Number.isSafeInteger(amount)) fail('Informe um valor válido com até duas casas decimais.');
    if(String(body.quantity??'').trim()==='' || !Number.isSafeInteger(quantity) || quantity<0) fail('Informe uma quantidade inteira, igual ou maior que zero.');
    return transaction(()=>{
      if(!db.prepare('SELECT id FROM contests WHERE id=?').get(contestId)) fail('Concurso não encontrado.');
      if(roleId) {
        const old=get(roleId);
        if(old.contest_id!==contestId) fail('Cargo não pertence ao concurso.');
        const count=db.prepare('SELECT COUNT(*) n FROM registration_roles WHERE role_id=?').get(roleId).n;
        if(quantity<count) fail(`Este cargo já tem ${count} colaboradores. Remova vínculos antes de reduzir a quantidade.`);
        if(db.prepare(`SELECT 1 FROM registration_roles a JOIN registration_roles b ON b.registration_id=a.registration_id
          JOIN roles r ON r.id=b.role_id WHERE a.role_id=? AND b.role_id<>? AND (r.period & ?)<>0 LIMIT 1`).get(roleId,roleId,period))
          fail('A alteração de período geraria conflito para um colaborador já vinculado. Ajuste os vínculos primeiro.');
        db.prepare('UPDATE roles SET name=?,period=?,amount_cents=?,quantity=? WHERE id=?').run(name,period,amount,quantity,roleId);
      } else roleId=db.prepare('INSERT INTO roles(contest_id,name,period,amount_cents,quantity) VALUES(?,?,?,?,?) RETURNING id').get(contestId,name,period,amount,quantity).id;
      refresh(contestId);
      return get(roleId);
    });
  }
  function remove(contestId,roleId) {
    return transaction(()=>{
      const r=get(roleId);
      if(r.contest_id!==contestId) fail('Cargo não pertence ao concurso.');
      if(db.prepare('SELECT 1 FROM registration_roles WHERE role_id=? LIMIT 1').get(roleId)) fail('Remova os vínculos dos colaboradores antes de excluir este cargo.');
      db.prepare('DELETE FROM roles WHERE id=?').run(roleId);
      refresh(contestId);
    });
  }
  function validate(contestId,values,registrationId=null,required=true) {
    const ids=roleIds(values);
    if((required&&!ids.length) || ids.length>2 || ids.some(v=>typeof v!=='string') || new Set(ids).size!==ids.length)
      fail('Selecione um cargo ou dois cargos em períodos diferentes.');
    let occupied=0;
    return ids.map(value=>{
      const r=get(value);
      if(r.contest_id!==contestId) fail('Selecione somente cargos deste concurso.');
      if(!r.period || r.amount_cents===null) fail('Este cargo ainda precisa ser configurado pelo organizador.');
      if(occupied&r.period) fail('Os cargos selecionados têm períodos sobrepostos. Manhã e Tarde ocupa os dois períodos.');
      occupied|=r.period;
      const used=db.prepare('SELECT COUNT(*) n FROM registration_roles WHERE role_id=? AND registration_id<>?').get(r.id,registrationId||'').n;
      if(used>=r.quantity) fail(`Não há vagas disponíveis para o cargo ${r.name}.`);
      return r;
    });
  }
  function assign(registrationId,values,required=false) {
    return transaction(()=>{
      const registration=db.prepare('SELECT * FROM registrations WHERE id=?').get(registrationId);
      if(!registration) fail('Colaborador não encontrado.');
      const roles=validate(registration.contest_id,values,registrationId,required);
      db.prepare('DELETE FROM registration_roles WHERE registration_id=?').run(registrationId);
      for(const r of roles) db.prepare('INSERT INTO registration_roles(registration_id,role_id) VALUES(?,?)').run(registrationId,r.id);
      return roles;
    });
  }
  return {get,list,assigned,save,remove,assign,validate,refresh,transaction};
}
