// Testes da exportação em CSV. Rode com "npm test", na pasta servidor/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarFormatador } from '../src/csv.js';

// 18/10/2026, 14:32:07 em Recife (UTC-3).
const registro = {
  t: Date.UTC(2026, 9, 18, 17, 32, 7, 123),
  projeto: 'horta',
  no: 'no1',
  grandeza: 'ph',
  valor: 6.12,
  unidade: 'pH',
  seq: 1834,
  boot: 7,
};

test('formato brasileiro: ponto e vírgula, vírgula decimal e marca UTF-8', () => {
  const csv = criarFormatador({ formato: 'br', fusoHorario: 'America/Recife' });
  assert.equal(csv.cabecalho(), '\uFEFFdata_hora;projeto;no;grandeza;valor;unidade;seq;boot;t_ms\r\n');
  assert.equal(csv.linha(registro), '2026-10-18 14:32:07;horta;no1;ph;6,12;pH;1834;7;1792344727123\r\n');
});

test('formato internacional: vírgula e ponto decimal, sem marca UTF-8', () => {
  const csv = criarFormatador({ formato: 'internacional', fusoHorario: 'America/Recife' });
  assert.equal(csv.cabecalho(), 'data_hora,projeto,no,grandeza,valor,unidade,seq,boot,t_ms\r\n');
  assert.equal(csv.linha(registro), '2026-10-18 14:32:07,horta,no1,ph,6.12,pH,1834,7,1792344727123\r\n');
});

test('campo com o separador vai entre aspas', () => {
  const csv = criarFormatador({ formato: 'internacional', fusoHorario: 'America/Recife' });
  assert.match(csv.linha({ ...registro, unidade: 'a,b' }), /,"a,b",/);
});

test('célula que a planilha leria como fórmula vira texto', () => {
  const csv = criarFormatador({ formato: 'br', fusoHorario: 'America/Recife' });
  assert.match(csv.linha({ ...registro, unidade: '=1+1' }), /;'=1\+1;/);
});

test('formato desconhecido é recusado', () => {
  assert.throws(() => criarFormatador({ formato: 'excel' }), /formato de CSV desconhecido/);
});
