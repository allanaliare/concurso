import { createApp } from './app.js';
import { database } from './db.js';
import { purgeExpired } from './maintenance.js';
const env=process.env;
if(!env.SESSION_SECRET || env.SESSION_SECRET.length<32) {
  console.error('Configure SESSION_SECRET (mínimo 32 caracteres) no .env. Consulte README.md.');
  process.exit(1);
}
const port=Number(env.PORT||3000);
if(!env.CPF_HMAC_SECRET || env.CPF_HMAC_SECRET.length<32 || [env.SESSION_SECRET,env.BOT_INTERNAL_TOKEN,env.WEBHOOK_TOKEN].includes(env.CPF_HMAC_SECRET)) {
  console.error('Configure CPF_HMAC_SECRET com pelo menos 32 caracteres, diferente das outras chaves.');process.exit(1);
}
const db=database(env.DATABASE_PATH||'data/concurso.sqlite');
const app=createApp({adminPassword:env.ADMIN_PASSWORD,adminUsername:env.ADMIN_USERNAME,sessionSecret:env.SESSION_SECRET,webhookToken:env.WEBHOOK_TOKEN,
  internalToken:env.BOT_INTERNAL_TOKEN,cpfSecret:env.CPF_HMAC_SECRET,trustLocalProxy:env.TRUST_LOCAL_PROXY==='true',
  outboundUrl:env.N8N_OUTBOUND_URL,outboundToken:env.N8N_OUTBOUND_TOKEN,baseUrl:(env.BASE_URL||`http://localhost:${port}`).replace(/\/$/,''),production:env.NODE_ENV==='production'},db);
purgeExpired(db,Number(env.RETENTION_DAYS||180));
setInterval(()=>purgeExpired(db,Number(env.RETENTION_DAYS||180)),3600000).unref();
app
  .listen(port,'0.0.0.0',()=>console.log(`Ponto de Prova disponível em http://localhost:${port}`));
