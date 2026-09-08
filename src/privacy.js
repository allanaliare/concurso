import { createHmac, timingSafeEqual } from 'node:crypto';

export const maskPhone = phone => `••••••${String(phone).slice(-4)}`;
export const maskCpf = final => `***.***.*${String(final).slice(0,2)}-${String(final).slice(2)}`;
export const redact = text => String(text ?? '').replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g,'[dado pessoal removido]');
export function privacy(db, secret) {
  if(typeof secret !== 'string' || secret.length < 32) throw new Error('Configure CPF_HMAC_SECRET com pelo menos 32 caracteres.');
  const hash = cpf => createHmac('sha256',secret).update(cpf).digest('hex');
  const fingerprint = hash('ponto-de-prova:key-check:v1');
  const stored = db.prepare("SELECT value FROM app_meta WHERE key='cpf_key_check'").get();
  if(stored && !timingSafeEqual(Buffer.from(stored.value),Buffer.from(fingerprint))) throw new Error('CPF_HMAC_SECRET não corresponde à chave do banco. Restaure a chave original.');
  db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('cpf_key_check',?)").run(fingerprint);
  const legacy = db.prepare('SELECT id,cpf FROM registrations WHERE length(cpf)=11').all();
  if(legacy.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const r of legacy)db.prepare('UPDATE registrations SET cpf=?,cpf_final=? WHERE id=?').run(hash(r.cpf),r.cpf.slice(-4),r.id);
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  // Historical message bodies must follow the same policy as new messages.
  for(const m of db.prepare('SELECT id,body FROM messages').all()) {
    if(redact(m.body)!==m.body) db.prepare('UPDATE messages SET body=? WHERE id=?').run(redact(m.body),m.id);
  }
  return {hash};
}
