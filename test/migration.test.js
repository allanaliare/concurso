import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/migrations.js';
import { database } from '../src/db.js';

test('migra dados legados para UUID e preserva vínculos após reabrir o banco',()=>{
  const folder=mkdtempSync(join(tmpdir(),'concurso-uuid-'));
  const path=join(folder,'legacy.sqlite');
  let db=new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE contests(id INTEGER PRIMARY KEY,title TEXT,organizer TEXT,role TEXT,
        fee REAL NOT NULL CHECK(fee>=0),vacancies INTEGER,salary TEXT,location TEXT,
        arrival TEXT,starts TEXT,ends TEXT,deadline TEXT,official_url TEXT,notes TEXT,
        active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE links(code TEXT PRIMARY KEY,contest_id INTEGER REFERENCES contests(id),group_name TEXT);
      CREATE TABLE registrations(id INTEGER PRIMARY KEY,contest_id INTEGER REFERENCES contests(id),
        name TEXT,cpf TEXT,phone TEXT,code TEXT REFERENCES links(code),source TEXT,created_at TEXT,
        UNIQUE(contest_id,cpf));
      INSERT INTO contests(id,title,fee,active) VALUES(42,'Equipe antiga',0,0);
      INSERT INTO links VALUES('link-antigo',42,'Equipe');
      INSERT INTO registrations VALUES(9,42,'Pessoa','hash','11999999999','link-antigo','formulario','2026-09-01');
    `);
    migrate(db);
    db.exec(`
      INSERT INTO groups(id,name,instance,remote_jid,bot_jid,contest_id,code)
        VALUES(7,'Equipe','instancia','123@g.us','5511999999999@s.whatsapp.net',42,'link-antigo');
      INSERT INTO faqs(id,contest_id,question,answer) VALUES(6,42,'Onde?','No local.');
      INSERT INTO reminders(id,group_id,contest_id,type,message,execute_at,original_local)
        VALUES(5,7,42,'LEMBRETE_PROVA','Teste','2026-09-10T12:00:00.000Z','2026-09-10T09:00');
      INSERT INTO bot_messages(id,instance,message_id,group_id,sender_hash,question,action,status,created_at,contest_id)
        VALUES(3,'instancia','external-id',7,'hash','Pergunta','IGNORE','IGNORADO','2026-09-01',42);
      INSERT INTO audit(actor,action,target) VALUES('administrador','concurso.criado','42');
    `);
    db.close();
    db=database(path);
    const contest=db.prepare('SELECT * FROM contests').get();
    assert.match(contest.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(contest.title,'Equipe antiga');
    assert.equal(contest.active,0);
    assert.equal('fee' in contest,false);
    const group=db.prepare('SELECT * FROM groups').get();
    for(const table of ['links','registrations','groups','faqs','reminders','bot_messages'])
      assert.equal(db.prepare(`SELECT contest_id FROM ${table}`).get().contest_id,contest.id);
    for(const table of ['reminders','bot_messages'])
      assert.equal(db.prepare(`SELECT group_id FROM ${table}`).get().group_id,group.id);
    assert.equal(db.prepare('SELECT target FROM audit').get().target,contest.id);
    assert.equal(db.prepare('SELECT code FROM links').get().code,'link-antigo');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.throws(()=>db.prepare("INSERT INTO links VALUES('bad','missing','Erro')").run());
    db.close();
    db=database(path);
    assert.equal(db.prepare('SELECT id FROM contests').get().id,contest.id);
    const added=db.prepare("INSERT INTO messages(direction,phone,body,status) VALUES('in','11999999999','Teste','recebida') RETURNING id").get();
    assert.match(added.id,/^[0-9a-f-]{36}$/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM registrations').get().n,1);
    assert.equal(db.prepare('SELECT pix_key FROM registrations').get().pix_key,null);
    db.prepare('UPDATE registrations SET pix_type=?,pix_key=?').run('email','pessoa@example.com');
    db.close();
    db=database(path);
    assert.equal(db.prepare('SELECT pix_key FROM registrations').get().pix_key,'pessoa@example.com');
  } finally { db.close(); rmSync(folder,{recursive:true,force:true}); }
});
