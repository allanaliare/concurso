import { randomUUID } from 'node:crypto';

// Rebuild the legacy tables together so every foreign key follows its UUID.
export function migrateUuids(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get()) return;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','app_meta') AND name NOT LIKE 'sqlite_%'").all();
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
    const maps = new Map();
    const snapshots = tables.map(table => {
      const rows = db.prepare(`SELECT * FROM "${table.name}"`).all();
      if (/\bid INTEGER PRIMARY KEY/i.test(table.sql)) maps.set(table.name, new Map(rows.map(row => [row.id, randomUUID()])));
      return {...table, rows, refs: db.prepare(`PRAGMA foreign_key_list("${table.name}")`).all()};
    });
    for (const table of snapshots) db.exec(`DROP TABLE "${table.name}"`);
    for (const table of snapshots) {
      let sql = table.sql.replace(/\bid INTEGER PRIMARY KEY/ig, 'id TEXT PRIMARY KEY NOT NULL DEFAULT (uuid())');
      for (const ref of table.refs) if (maps.has(ref.table)) sql = sql.replace(new RegExp(`\\b${ref.from} INTEGER`, 'g'), `${ref.from} TEXT`);
      db.exec(sql);
      for (const row of table.rows) {
        if (maps.has(table.name)) row.id = maps.get(table.name).get(row.id);
        for (const ref of table.refs) if (maps.has(ref.table) && row[ref.from] != null) row[ref.from] = maps.get(ref.table).get(row[ref.from]);
        if (table.name === 'audit') {
          const targetTable = {concurso:'contests',grupo:'groups',faq:'faqs',lembrete:'reminders',participante:'registrations'}[row.action.split('.')[0]];
          row.target = maps.get(targetTable)?.get(Number(row.target)) ?? row.target;
        }
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO "${table.name}" (${columns.map(c=>`"${c}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));
      }
    }
    for (const index of indexes) db.exec(index.sql);
    db.exec('ALTER TABLE contests DROP COLUMN fee');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Falha ao migrar os vínculos dos cadastros.');
    db.exec('INSERT INTO schema_migrations(version) VALUES(4); COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
}
