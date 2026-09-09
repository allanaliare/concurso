import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pix } from '../src/validation.js';

test('Pix aceita e normaliza CPF, celular, e-mail e chave aleatória',()=>{
  for(const [type,key,expected] of [
    ['cpf','529.982.247-25','52998224725'],
    ['celular','(11) 99999-9999','+5511999999999'],
    ['celular','+55 (11) 99999-9999','+5511999999999'],
    ['email',' Pessoa@Example.com ','pessoa@example.com'],
    ['aleatoria','550E8400-E29B-41D4-A716-446655440000','550e8400-e29b-41d4-a716-446655440000']
  ]) assert.deepEqual(pix({pix_type:type,pix_key:key}),{pix_type:type,pix_key:expected});
});

test('Pix rejeita tipo desconhecido, chave ausente ou formato incompatível',()=>{
  for(const [type,key] of [
    ['cpf','11111111111'],['cpf','abc52998224725'],['cpf','pessoa@example.com'],
    ['celular','119999999'],['celular','abc11999999999'],['celular','1133334444'],
    ['email','pessoa@'],['email','pessoa @example.com'],['aleatoria','123'],
    ['outro','chave'],['toString','chave'],['cpf',''],['email',null]
  ]) assert.throws(()=>pix({pix_type:type,pix_key:key}));
});
