export function migrate(db) {
  db.exec(`PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get())db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE registrations ADD COLUMN cpf_final TEXT NOT NULL DEFAULT '';
    ALTER TABLE registrations ADD COLUMN consent_at TEXT;
    ALTER TABLE contests ADD COLUMN edital_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE contests ADD COLUMN registration_opens TEXT NOT NULL DEFAULT '';
    ALTER TABLE contests ADD COLUMN ai_context TEXT NOT NULL DEFAULT '';
    ALTER TABLE contests ADD COLUMN fallback TEXT NOT NULL DEFAULT 'Não encontrei essa informação. Consulte o edital ou fale com um administrador.';
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,instance TEXT NOT NULL,remote_jid TEXT NOT NULL,bot_jid TEXT NOT NULL,
      contest_id INTEGER NOT NULL REFERENCES contests(id),code TEXT NOT NULL REFERENCES links(code),
      active INTEGER NOT NULL DEFAULT 1,respond_mention INTEGER NOT NULL DEFAULT 1,respond_command INTEGER NOT NULL DEFAULT 1,
      last_message_at TEXT,UNIQUE(instance,remote_jid));
    CREATE TABLE faqs(id INTEGER PRIMARY KEY,contest_id INTEGER NOT NULL REFERENCES contests(id),question TEXT NOT NULL,
      answer TEXT NOT NULL,keywords TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX idx_faq_contest ON faqs(contest_id,active);
    CREATE TABLE reminders(id INTEGER PRIMARY KEY,group_id INTEGER NOT NULL REFERENCES groups(id),contest_id INTEGER NOT NULL REFERENCES contests(id),
      type TEXT NOT NULL,message TEXT NOT NULL,execute_at TEXT NOT NULL,original_local TEXT NOT NULL,
      repeat_hours INTEGER NOT NULL DEFAULT 0,repeat_until TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE',attempts INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,claimed_at TEXT,sent_at TEXT,error TEXT,provider_id TEXT);
    CREATE INDEX idx_reminder_due ON reminders(status,execute_at);
    CREATE TABLE bot_messages(id INTEGER PRIMARY KEY,instance TEXT NOT NULL,message_id TEXT NOT NULL,group_id INTEGER REFERENCES groups(id),
      sender_hash TEXT NOT NULL,question TEXT NOT NULL,response TEXT NOT NULL DEFAULT '',action TEXT NOT NULL,status TEXT NOT NULL,
      created_at TEXT NOT NULL,UNIQUE(instance,message_id));
    CREATE INDEX idx_bot_group_time ON bot_messages(group_id,created_at);
    CREATE TABLE bot_errors(id INTEGER PRIMARY KEY,group_id INTEGER REFERENCES groups(id),workflow TEXT NOT NULL,
      execution_id TEXT NOT NULL,code TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO schema_migrations(version) VALUES(2);
    COMMIT;`);
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get())db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE bot_messages ADD COLUMN contest_id INTEGER REFERENCES contests(id);
    UPDATE bot_messages SET contest_id=(SELECT contest_id FROM groups WHERE groups.id=bot_messages.group_id);
    ALTER TABLE contests ADD COLUMN arrival_utc TEXT;
    ALTER TABLE contests ADD COLUMN starts_utc TEXT;
    ALTER TABLE contests ADD COLUMN ends_utc TEXT;
    ALTER TABLE contests ADD COLUMN deadline_utc TEXT;
    ALTER TABLE contests ADD COLUMN registration_opens_utc TEXT;
    UPDATE contests SET arrival_utc=strftime('%Y-%m-%dT%H:%M:%fZ',arrival,'+3 hours'),
      starts_utc=strftime('%Y-%m-%dT%H:%M:%fZ',starts,'+3 hours'),ends_utc=strftime('%Y-%m-%dT%H:%M:%fZ',ends,'+3 hours'),
      deadline_utc=strftime('%Y-%m-%dT%H:%M:%fZ',deadline,'+3 hours'),registration_opens_utc=strftime('%Y-%m-%dT%H:%M:%fZ',registration_opens,'+3 hours');
    INSERT INTO schema_migrations(version) VALUES(3);COMMIT;`);
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=5').get())db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE registrations ADD COLUMN pix_type TEXT CHECK(pix_type IN ('cpf','celular','email','aleatoria'));
    ALTER TABLE registrations ADD COLUMN pix_key TEXT;
    INSERT INTO schema_migrations(version) VALUES(5); COMMIT;`);
  if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=7').get())db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE registrations ADD COLUMN cpf_full TEXT;
    INSERT INTO schema_migrations(version) VALUES(7); COMMIT;`);
}
