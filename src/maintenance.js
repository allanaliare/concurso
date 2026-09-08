export function purgeExpired(db,days=180) {
  if(!Number.isInteger(days)||days<1||days>3650)throw new Error('RETENTION_DAYS deve estar entre 1 e 3650.');
  const cutoff=new Date(Date.now()-days*86400000).toISOString().slice(0,19).replace('T',' ');
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const table of ['registrations','messages','clicks','events','bot_errors','audit']) db.prepare(`DELETE FROM ${table} WHERE datetime(created_at)<datetime(?)`).run(cutoff);
    db.prepare('DELETE FROM bot_messages WHERE datetime(created_at)<datetime(?)').run(cutoff);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
