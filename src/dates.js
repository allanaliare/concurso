export function localToUtc(value) {
  const invalid=()=>{throw Object.assign(new Error('Data inválida.'),{status:400});};
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value??''))invalid();
  const d=new Date(value+'-03:00');
  if(!Number.isFinite(d.getTime()) || new Date(d.getTime()-10800000).toISOString().slice(0,16)!==value)invalid();
  return d.toISOString();
}
