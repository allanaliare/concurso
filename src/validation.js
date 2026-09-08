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
export function registration(body) {
  const name = String(body.name ?? '').trim();
  const cpf = digits(body.cpf), phone = digits(body.phone);
  if (name.length < 3 || name.length > 150 || !cpfValid(cpf) || !/^\d{10,15}$/.test(phone))
    throw new Error('Informe nome, CPF válido e WhatsApp com DDD.');
  return { name, cpf, phone };
}
const coreFields = ['title','organizer','role','fee','vacancies','salary','location','arrival','starts','ends','deadline','official_url','notes'];
const dates=['arrival','starts','ends','deadline'];
export const fields = [...coreFields,...dates.map(k=>k+'_utc')];
export function contest(body) {
  const data = Object.fromEntries(coreFields.map(key => [key, String(body[key] ?? '').trim()]));
  for (const key of coreFields.filter(key => key !== 'notes')) if (!data[key] || data[key].length > 2000) throw new Error('Preencha todos os campos obrigatórios.');
  if (!Number.isFinite(Number(data.fee)) || Number(data.fee) < 0 || !Number.isSafeInteger(Number(data.vacancies)) || Number(data.vacancies) < 0) throw new Error('Valor ou vagas inválidos.');
  if (!/^https?:\/\//.test(data.official_url)) throw new Error('Use um link oficial HTTP ou HTTPS.');
  try { new URL(data.official_url); } catch { throw new Error('Link oficial inválido.'); }
  for(const key of dates)data[key+'_utc']=localToUtc(data[key]);
  if (data.arrival > data.starts || data.starts >= data.ends || data.deadline > data.starts) throw new Error('Confira a sequência de inscrição, chegada, início e término.');
  if (data.notes.length > 10000) throw new Error('Observações muito longas.');
  data.fee = Number(data.fee); data.vacancies = Number(data.vacancies);
  return data;
}
