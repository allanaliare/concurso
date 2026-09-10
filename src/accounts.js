import { randomBytes, scryptSync, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import session from 'express-session';
import { esc, csrf, input, table } from './views.js';

export const actorContext=new AsyncLocalStorage();
const derive=promisify(scrypt);
const passwordValid=password=>typeof password==='string'&&password.length>=12&&password.length<=128;
const fail=message=>{throw new Error(message);};
const loginName=value=>String(value??'').trim().toLowerCase();
export function migrateAccounts(db,config) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (uuid()),name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','manager')),
    active INTEGER NOT NULL DEFAULT 1,auth_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);`);
  if(!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    if(!passwordValid(config.adminPassword)) fail('Configure ADMIN_PASSWORD com 12 a 128 caracteres para criar o primeiro administrador.');
    if(!/^[a-z0-9._@-]{3,80}$/.test(loginName(config.adminUsername||'admin')))fail('Configure ADMIN_USERNAME com 3 a 80 caracteres válidos para login.');
    const salt=randomBytes(16).toString('hex');
    const hash=scryptSync(config.adminPassword,salt,64).toString('hex');
    db.prepare("INSERT INTO users(name,username,password_hash,role) VALUES(?,?,?,'admin')").run('Administrador',loginName(config.adminUsername||'admin'),`${salt}:${hash}`);
  }
  if(!db.prepare('PRAGMA table_info(contests)').all().some(c=>c.name==='owner_id'))db.exec('ALTER TABLE contests ADD COLUMN owner_id TEXT REFERENCES users(id)');
  db.prepare("UPDATE contests SET owner_id=(SELECT id FROM users WHERE role='admin' ORDER BY created_at,rowid LIMIT 1) WHERE owner_id IS NULL").run();
  db.exec('CREATE INDEX IF NOT EXISTS idx_contests_owner ON contests(owner_id)');
}

// The identifier comes exclusively from the authenticated database record.
export function accessibleContests() {
  const user=actorContext.getStore();
  if(!user||user.role==='admin')return 'SELECT id FROM contests';
  if(!/^[0-9a-f-]{36}$/.test(user.id))throw new Error('Usuário inválido.');
  return `SELECT id FROM contests WHERE owner_id='${user.id}'`;
}

export function enforceBackOffice(db) {
  return (req,res,next)=>{
    const path=req.path.toLowerCase();
    if(!/^\/(admin(?:\/|$)|api\/(grupos|concursos|faqs|participantes)(?:\/|$))/.test(path))return next();
    if(!req.user)return path.startsWith('/api/')?res.status(401).json({error:'Entre com seu usuário.'}):res.redirect('/login');
    if(req.user.role==='admin')return next();
    if(/^\/admin\/(users|messages|history)(?:\/|$)/.test(path))return res.status(403).send('Esta área é exclusiva do administrador.');
    const owned=value=>typeof value==='string'&&!!db.prepare('SELECT id FROM contests WHERE id=? AND owner_id=?').get(value,req.user.id);
    const resources={contests:'contests',concursos:'contests',groups:'groups',grupos:'groups',reminders:'reminders',registrations:'registrations',participantes:'registrations',faqs:'faqs'};
    const parts=path.split('/').filter(Boolean),table=resources[parts[1]],value=parts[2];
    if(table&&value&&value!=='new') {
      const row=db.prepare(`SELECT ${table==='contests'?'id':'contest_id'} AS contest_id FROM ${table} WHERE id=?`).get(value);
      if(!row||!owned(row.contest_id))return res.sendStatus(404);
    }
    if(req.query.contest&&!owned(req.query.contest))return res.sendStatus(404);
    if(req.body?.contest_id&&!owned(req.body.contest_id))return res.sendStatus(404);
    if(req.body?.group_id) {
      const g=typeof req.body.group_id==='string'&&db.prepare('SELECT contest_id FROM groups WHERE id=?').get(req.body.group_id);
      if(!g||!owned(g.contest_id))return res.sendStatus(404);
    }
    next();
  };
}

export class SQLiteSessions extends session.Store {
  constructor(db) {super();this.db=db;}
  get(sid,callback) {
    try {const r=this.db.prepare('SELECT data FROM sessions WHERE sid=? AND expires>?').get(sid,Date.now());callback(null,r?JSON.parse(r.data):null);}catch(e){callback(e);}
  }
  set(sid,data,callback=()=>{}) {
    try {this.db.prepare('INSERT INTO sessions(sid,data,expires) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(sid,JSON.stringify(data),data.cookie.expires?new Date(data.cookie.expires).getTime():Date.now()+28800000);this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());callback();}catch(e){callback(e);}
  }
  destroy(sid,callback=()=>{}) {try{this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);callback();}catch(e){callback(e);}}
  touch(sid,data,callback=()=>{}) {this.set(sid,data,callback);}
}

export function accounts(db) {
  const publicColumns='id,name,username,role,active,auth_version,created_at';
  const get=value=>db.prepare(`SELECT ${publicColumns} FROM users WHERE id=?`).get(value);
  const list=()=>db.prepare(`SELECT ${publicColumns} FROM users ORDER BY name,username`).all();
  async function authenticate(username,password) {
    if(typeof password!=='string'||password.length>128)return null;
    const user=db.prepare('SELECT * FROM users WHERE username=?').get(loginName(username));
    const [salt,hash]=(user?.password_hash||'00000000000000000000000000000000:'+ '00'.repeat(64)).split(':');
    const candidate=await derive(password,salt,64);
    const current=user?get(user.id):null;
    return timingSafeEqual(Buffer.from(hash,'hex'),candidate)&&current?.active&&current.auth_version===user.auth_version?current:null;
  }
  async function save(body,userId) {
    const name=String(body.name??'').trim(),username=loginName(body.username),role=body.role;
    if(!name||name.length>100)fail('Informe o nome com até 100 caracteres.');
    if(!/^[a-z0-9._@-]{3,80}$/.test(username))fail('O login deve ter 3 a 80 caracteres: letras sem acentos, números, ponto, @, hífen ou sublinhado.');
    if(!['admin','manager'].includes(role))fail('Selecione o perfil do usuário.');
    const old=userId?get(userId):null;
    if(userId&&!old)fail('Usuário não encontrado.');
    const password=body.password??'';
    if((!old||password)&&!passwordValid(password))fail('A senha deve ter entre 12 e 128 caracteres.');
    let hash;
    if(password){const salt=randomBytes(16).toString('hex');hash=`${salt}:${(await derive(password,salt,64)).toString('hex')}`;}
    const active=body.active==='1'||body.active===true?1:0;
    db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(username,userId||''))fail('Este login já está em uso.');
      const current=userId?get(userId):null;
      if(current?.role==='admin'&&current.active&&(!active||role!=='admin')&&db.prepare("SELECT COUNT(*) n FROM users WHERE active=1 AND role='admin'").get().n<=1)fail('Mantenha pelo menos um administrador ativo.');
      if(current) db.prepare('UPDATE users SET name=?,username=?,role=?,active=?,password_hash=coalesce(?,password_hash),auth_version=auth_version+? WHERE id=?').run(name,username,role,active,hash??null,hash||current.role!==role||current.active!==active?1:0,userId);
      else userId=db.prepare('INSERT INTO users(name,username,password_hash,role,active) VALUES(?,?,?,?,?) RETURNING id').get(name,username,hash,role,active).id;
      db.exec('COMMIT');return get(userId);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {get,list,authenticate,save};
}

export function mountAccounts(app,db,users,page) {
  app.use('/admin/users',(req,res,next)=>req.user?.role==='admin'?next():res.status(403).send('Somente administradores podem gerenciar usuários.'));
  const form=(u={},token)=>`<a class="back" href="/admin/users">← Usuários</a><h1>${u.id?'Editar':'Novo'} usuário</h1><form class="panel form-grid" method="post">${csrf(token)}${input('Nome','name',u.name||'','text','maxlength="100"')}${input('Login','username',u.username||'','text','autocomplete="off" maxlength="80"')}<label>${u.id?'Nova senha (deixe vazio para manter)':'Senha'}<input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" ${u.id?'':'required'}></label><label>Perfil<select name="role"><option value="manager" ${u.role==='manager'?'selected':''}>Gestor de concursos</option><option value="admin" ${u.role==='admin'?'selected':''}>Administrador</option></select></label><label class="check"><input type="checkbox" name="active" value="1" ${u.active===undefined||u.active?'checked':''}>Usuário ativo</label><button>Salvar usuário</button></form>`;
  app.get('/admin/users',(req,res)=>page(req,res,'Usuários',`<div class="heading"><div><p class="eyebrow">BACK-OFFICE</p><h1>Usuários e acessos</h1><p>Cada pessoa acessa com seu próprio login e senha.</p></div><a class="button" href="/admin/users/new">Novo usuário</a></div>${table(['Nome','Login','Perfil','Situação','Ações'],users.list().map(u=>[esc(u.name),esc(u.username),u.role==='admin'?'Administrador':'Gestor de concursos',u.active?'Ativo':'Desativado',`<a href="/admin/users/${u.id}/edit">Editar acesso</a>`]))}`));
  app.get('/admin/users/new',(req,res)=>page(req,res,'Novo usuário',form({},req.session.csrf)));
  app.get('/admin/users/:id/edit',(req,res)=>{const u=users.get(req.params.id);if(!u)return res.sendStatus(404);page(req,res,'Editar usuário',form(u,req.session.csrf));});
  const save=async(req,res)=>{
    try {const u=await users.save(req.body,req.params.id);db.prepare('INSERT INTO audit(actor,action,target) VALUES(?,?,?)').run(`${req.user.name} (${req.user.username}) [${req.user.id}]`,'usuario.salvo',u.id);res.redirect('/admin/users');}
    catch(error){page(req,res,'Salvar usuário',form({...req.body,id:req.params.id,active:req.body.active==='1'},req.session.csrf),400,error.code?'Não foi possível salvar o usuário.':error.message);}
  };
  app.post('/admin/users/new',save);
  app.post('/admin/users/:id/edit',save);
}
