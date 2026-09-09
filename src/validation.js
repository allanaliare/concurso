import { localToUtc } from './dates.js';
export function cpfValid(value) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  for (let n = 9; n < 11; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(value[i]) * (n + 1 - i);
    const digit = (sum * 10) % 11;
    if ((digit === 10 ? 0 : digit) !== Number(value[n])) return false;
  }
  return true;
}
export const digits = value => String(value ?? '').replace(/\D/g, '');
export const pixTypes = {cpf:'CPF',celular:'Celular',email:'E-mail',aleatoria:'Aleatória'};
export function pix(body) {
  const type=body.pix_type;
  let key=typeof body.pix_key==='string'?body.pix_key.trim():'';
  if (!Object.hasOwn(pixTypes,type) || !key || key.length>254) throw new Error('Selecione o tipo e informe sua chave Pix.');
  if(type==='cpf') {
    if(!/^[\d.\s-]+$/.test(key) || !cpfValid(digits(key))) throw new Error('Informe um CPF válido como chave Pix.');
    key=digits(key);
  } else if(type==='celular') {
    if(!/^\+?[\d\s()-]+$/.test(key)) throw new Error('Informe uma chave Pix de celular válida, com DDD.');
    key=digits(key);
    if(key.length===11) key='55'+key;
    if(!/^55[1-9]\d9\d{8}$/.test(key)) throw new Error('Informe uma chave Pix de celular válida, com DDD.');
    key='+'+key;
  } else if(type==='email') {
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) throw new Error('Informe um e-mail válido como chave Pix.');
    key=key.toLowerCase();
  } else {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new Error('Informe a chave Pix aleatória completa, copiada do aplicativo do banco.');
    key=key.toLowerCase();
  }
  return {pix_type:type,pix_key:key};
}
export function registration(body) {
  const name = String(body.name ?? '').trim();
  const cpf = digits(body.cpf), phone = digits(body.phone);
  if (name.length < 3 || name.length > 150 || !cpfValid(cpf) || !/^\d{10,15}$/.test(phone))
    throw new Error('Informe nome, CPF válido e WhatsApp com DDD.');
  return { name, cpf, phone, ...pix(body) };
}
const coreFields = ['title','organizer','role','vacancies','salary','location','arrival','starts','ends','deadline','official_url','notes'];
const dates=['arrival','starts','ends','deadline'];
export const fields = [...coreFields,...dates.map(k=>k+'_utc')];
export function contest(body) {
  const data = Object.fromEntries(coreFields.map(key => [key, String(body[key] ?? '').trim()]));
  for (const key of coreFields.filter(key => key !== 'notes')) if (!data[key] || data[key].length > 2000) throw new Error('Preencha todos os campos obrigatórios.');
  if (!Number.isSafeInteger(Number(data.vacancies)) || Number(data.vacancies) < 0) throw new Error('Número de vagas inválido.');
  if (!/^https?:\/\//.test(data.official_url)) throw new Error('Use um link oficial HTTP ou HTTPS.');
  try { new URL(data.official_url); } catch { throw new Error('Link oficial inválido.'); }
  for(const key of dates)data[key+'_utc']=localToUtc(data[key]);
  if (data.deadline > data.starts) throw new Error('O fim das inscrições deve ser anterior ou igual ao início da prova. Confira também o dia, mês e ano.');
  if (data.arrival > data.starts) throw new Error('O horário de chegada deve ser anterior ou igual ao início da prova. Confira também o dia, mês e ano.');
  if (data.starts >= data.ends) throw new Error('O término da prova deve ser posterior ao início. Confira também o dia, mês e ano.');
  if (data.notes.length > 10000) throw new Error('Observações muito longas.');
  data.vacancies = Number(data.vacancies);
  return data;
}
