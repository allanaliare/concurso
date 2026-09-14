import { randomUUID } from 'node:crypto';
import { cpfValid, digits, pix, pixTypes } from './validation.js';
import { csrf, esc, input, table } from './views.js';

export function manualData(body) {
  const name=String(body.name??'').trim(),cpf=digits(body.cpf),phone=digits(body.phone);
  if(!name || name.length>150) throw new Error('Informe o nome do colaborador com até 150 caracteres.');
  if(String(body.cpf??'').trim() && (!/^[\d.\s-]+$/.test(body.cpf)||!cpfValid(cpf))) throw new Error('Confira o CPF informado ou deixe o campo vazio.');
  if(String(body.phone??'').trim() && !/^\d{10,15}$/.test(phone)) throw new Error('Confira o telefone com DDD ou deixe o campo vazio.');
  const payment=body.pix_type||String(body.pix_key??'').trim()?pix(body):{pix_type:null,pix_key:null};
  return {name,cpf,phone,...payment};
}

export function mountManualRegistration(app,db,personal,page,audit) {
  const getContest=id=>db.prepare('SELECT * FROM contests WHERE id=?').get(id)||(()=>{throw new Error('Concurso não encontrado.');})();
  const getPerson=id=>db.prepare('SELECT * FROM registrations WHERE id=?').get(id)||(()=>{throw new Error('Colaborador não encontrado.');})();
  const form=(c,r,token)=>`<a href="/admin/contests/${c.id}">← Gerenciar concurso</a><h1>${r.id?'Editar':'Cadastrar'} colaborador</h1><p>${esc(c.title)}</p>
    <p>Somente o nome é obrigatório. CPF, telefone e Pix podem ser preenchidos depois.</p>
    ${r.id&&!r.cpf_full&&r.cpf_final?'<p>O CPF anterior não está disponível por inteiro. Informe-o novamente para completar o cadastro.</p>':''}
    <form class="panel form-grid" method="post">${csrf(token)}${input('Nome do colaborador','name',r.name??'','text','maxlength="150"')}
    <label>CPF<input name="cpf" value="${esc(r.cpf_full??'')}" maxlength="14" inputmode="numeric"></label>
    <label>Telefone com DDD<input name="phone" type="tel" value="${esc(r.phone??'')}" maxlength="20"></label>
    <label>Tipo de chave Pix<select name="pix_type"><option value="">Não informado</option>${Object.entries(pixTypes).map(([v,label])=>`<option value="${v}" ${r.pix_type===v?'selected':''}>${label}</option>`).join('')}</select></label>
    <label>Chave Pix<input name="pix_key" value="${esc(r.pix_key??'')}" maxlength="254"></label>
    <button>Salvar colaborador</button></form>`;
  const importPage=(c,token,result=null,draft='')=>`<a href="/admin/contests/${c.id}">← Gerenciar concurso</a><h1>Importar colaboradores</h1><p>${esc(c.title)}</p>
    <p>Informe um colaborador por linha no formato <code>cpf;nome;cargo</code>. O CPF será usado como chave Pix do tipo CPF.</p>
    <form class="panel form-grid" method="post">${csrf(token)}
      <label class="wide">Arquivo de texto<input type="file" accept=".txt,.csv,text/plain,text/csv" data-fill="import-text"></label>
      <label class="wide">Lista de colaboradores<textarea id="import-text" name="content" rows="12" required placeholder="cpf;nome;cargo">${esc(draft)}</textarea></label>
      <button>Importar colaboradores</button>
    </form>
    <script>document.querySelector('[data-fill="import-text"]')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(file)document.getElementById('import-text').value=await file.text();});</script>
    ${result?`<section class="panel"><h2>Resultado da importação</h2><div class="stats"><div><span>Importados</span><strong>${result.imported}</strong></div><div><span>Ignorados</span><strong>${result.skipped}</strong></div><div><span>Erros</span><strong>${result.errors.length}</strong></div></div>
    ${result.createdRoles.length?`<p>Cargos cadastrados automaticamente: ${result.createdRoles.map(esc).join(', ')}.</p>`:''}
    ${table(['Linha','Erro'],result.errors.map(e=>[e.line,esc(e.message)]),'Nenhuma linha com erro.')}</section>`:''}`;
  function normalizeRoleName(value) {
    const name=String(value??'').trim().replace(/\s+/g,' ');
    if(!name || name.length>150) throw new Error('Informe o cargo com até 150 caracteres.');
    return name;
  }
  function findOrCreateRole(contestId,name,result) {
    const existing=db.prepare('SELECT * FROM roles WHERE contest_id=? AND lower(trim(name))=lower(trim(?)) ORDER BY rowid LIMIT 1').get(contestId,name);
    if(existing) return existing;
    const role=db.prepare('INSERT INTO roles(contest_id,name,quantity) VALUES(?,?,0) RETURNING *').get(contestId,name);
    result.createdRoles.push(role.name);
    return role;
  }
  function importRows(contestId,content) {
    const result={imported:0,skipped:0,errors:[],createdRoles:[]};
    const lines=String(content??'').replace(/^\uFEFF/,'').split(/\r?\n/);
    db.exec('SAVEPOINT import_registrations');
    try {
      for(const [index,line] of lines.entries()) {
        const raw=line.trim();
        if(!raw) continue;
        try {
          const parts=raw.split(';').map(part=>part.trim());
          if(parts.length!==3) throw new Error('Use exatamente cpf;nome;cargo.');
          const [cpfText,nameText,roleText]=parts,cpf=digits(cpfText),name=String(nameText??'').trim();
          if(!/^[\d.\s-]+$/.test(cpfText) || !cpfValid(cpf)) throw new Error('CPF inválido.');
          if(name.length<3 || name.length>150) throw new Error('Informe o nome com 3 a 150 caracteres.');
          const role=findOrCreateRole(contestId,normalizeRoleName(roleText),result),hash=personal.hash(cpf);
          if(db.prepare('SELECT 1 FROM registrations WHERE contest_id=? AND cpf=?').get(contestId,hash)) { result.skipped++; continue; }
          const personId=db.prepare("INSERT INTO registrations(contest_id,name,cpf,cpf_full,cpf_final,phone,pix_type,pix_key,source,consent_at) VALUES(?,?,?,?,?,'','cpf',?,'importacao',?) RETURNING id").get(contestId,name,hash,cpf,cpf.slice(-4),cpf,new Date().toISOString()).id;
          db.prepare('INSERT INTO registration_roles(registration_id,role_id) VALUES(?,?)').run(personId,role.id);
          result.imported++;
        } catch(error) { result.errors.push({line:index+1,message:error.message}); }
      }
      const roleNames=db.prepare('SELECT name FROM roles WHERE contest_id=? ORDER BY name,rowid').all(contestId).map(r=>r.name).join(', ');
      db.prepare('UPDATE contests SET role=? WHERE id=?').run(roleNames,contestId);
      db.exec('RELEASE import_registrations');
      return result;
    } catch(error) {
      db.exec('ROLLBACK TO import_registrations; RELEASE import_registrations');
      throw error;
    }
  }
  const save=(req,res,existing,c)=>{
    try {
      const data=manualData(req.body);
      // Keep an unavailable legacy CPF hash when its full value has not been re-entered.
      const cpf=data.cpf?personal.hash(data.cpf):existing&&!existing.cpf_full&&existing.cpf_final?existing.cpf:`pending:${existing?.id??randomUUID()}`;
      if(db.prepare('SELECT id FROM registrations WHERE contest_id=? AND cpf=? AND id<>?').get(c.id,cpf,existing?.id??'')) throw new Error('Este CPF já está cadastrado neste concurso. Edite o cadastro existente.');
      let personId=existing?.id;
      if(existing) db.prepare('UPDATE registrations SET name=?,cpf=?,cpf_full=?,cpf_final=?,phone=?,pix_type=?,pix_key=? WHERE id=?').run(data.name,cpf,data.cpf||null,data.cpf?data.cpf.slice(-4):cpf===existing.cpf?existing.cpf_final:'',data.phone,data.pix_type,data.pix_key,existing.id);
      else personId=db.prepare("INSERT INTO registrations(contest_id,name,cpf,cpf_full,cpf_final,phone,pix_type,pix_key,source) VALUES(?,?,?,?,?,?,?,?,'administrador') RETURNING id").get(c.id,data.name,cpf,data.cpf||null,data.cpf.slice(-4),data.phone,data.pix_type,data.pix_key).id;
      audit(existing?'participante.atualizado':'participante.criado',personId);
      res.redirect(`/admin/registrations/${personId}/roles`);
    } catch(error) {
      page(req,res,'Cadastro do colaborador',form(c,{...existing,...req.body,cpf_full:req.body.cpf},req.session.csrf),400,error.code?'Não foi possível salvar o colaborador.':error.message);
    }
  };
  app.get('/admin/contests/:id/registrations/new',(req,res)=>page(req,res,'Cadastrar colaborador',form(getContest(req.params.id),{},req.session.csrf)));
  app.post('/admin/contests/:id/registrations/new',(req,res)=>save(req,res,null,getContest(req.params.id)));
  app.get('/admin/contests/:id/registrations/import',(req,res)=>page(req,res,'Importar colaboradores',importPage(getContest(req.params.id),req.session.csrf)));
  app.post('/admin/contests/:id/registrations/import',(req,res)=>{
    const c=getContest(req.params.id);
    const result=importRows(c.id,req.body.content);
    audit('participantes.importados',c.id);
    page(req,res,'Importar colaboradores',importPage(c,req.session.csrf,result,req.body.content));
  });
  app.get('/admin/registrations/:id/edit',(req,res)=>{const r=getPerson(req.params.id);page(req,res,'Editar colaborador',form(getContest(r.contest_id),r,req.session.csrf));});
  app.post('/admin/registrations/:id/edit',(req,res)=>{const r=getPerson(req.params.id);save(req,res,r,getContest(r.contest_id));});
}
