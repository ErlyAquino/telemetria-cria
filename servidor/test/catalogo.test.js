// Testes das regras do catálogo. Rode com "npm test", na pasta servidor/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretarMensagem, lerLeituraHttp, lerTopico } from '../src/catalogo.js';

const AGORA = Date.UTC(2026, 9, 18, 17, 0, 0);
const valida = { valor: 6.12, unidade: 'pH', seq: 1834, boot: 7, t: AGORA - 1000 };

test('lerTopico aceita o padrão cria/{projeto}/{no}/{grandeza}', () => {
  assert.deepEqual(lerTopico('cria/horta/no1/ph'), { projeto: 'horta', no: 'no1', grandeza: 'ph' });
});

test('lerTopico recusa tópicos fora do catálogo', () => {
  for (const topico of ['cria/horta/ph', 'cria/horta/no1/ph/extra', 'outro/horta/no1/ph', 'cria/Horta/no1/ph',
    'cria/horta/no01/ph', 'cria/horta/cam1/ph', 'cria/horta/no1/pressão', 'cria/-horta/no1/ph',
    'cria/horta/no1/-ph', 'cria/servidor/no1/ph']) {
    assert.equal(lerTopico(topico), null, topico);
  }
});

test('leitura válida vira tipo "leitura", com fila falso por padrão', () => {
  const r = interpretarMensagem('cria/horta/no1/ph', JSON.stringify(valida), AGORA);
  assert.deepEqual(r, { tipo: 'leitura', projeto: 'horta', no: 'no1', grandeza: 'ph', ...valida, fila: false });
});

test('leitura reenviada da fila mantém fila verdadeiro', () => {
  const r = interpretarMensagem('cria/horta/no1/ph', JSON.stringify({ ...valida, fila: 1 }), AGORA);
  assert.equal(r.tipo, 'leitura');
  assert.equal(r.fila, true);
});

test('status online e offline', () => {
  assert.deepEqual(interpretarMensagem('cria/ar/no1/status', 'online', AGORA),
    { tipo: 'status', projeto: 'ar', no: 'no1', status: 'online' });
  assert.equal(interpretarMensagem('cria/ar/no1/status', 'offline', AGORA).status, 'offline');
  assert.equal(interpretarMensagem('cria/ar/no1/status', 'talvez', AGORA).tipo, 'invalida');
});

test('mensagem vazia e tópico cmd são ignorados', () => {
  assert.equal(interpretarMensagem('cria/ar/no1/status', '', AGORA).tipo, 'ignorada');
  assert.equal(interpretarMensagem('cria/ar/no1/cmd', '{"calibrar":1}', AGORA).tipo, 'ignorada');
});

test('campos inválidos são recusados com o motivo', () => {
  const casos = [
    ['não é JSON', 'JSON inválido'],
    [JSON.stringify({ ...valida, valor: '6,12' }), 'valor'],
    [JSON.stringify({ ...valida, unidade: 'µS/cm' }), 'unidade'],
    [JSON.stringify({ ...valida, unidade: '=1+1' }), 'unidade'],
    [JSON.stringify({ ...valida, unidade: '-C' }), 'unidade'],
    [JSON.stringify({ ...valida, seq: 0 }), 'seq'],
    // 1e19 é "inteiro" em JavaScript, mas não cabe no banco: derrubava o servidor.
    ['{"valor":1,"unidade":"C","seq":10000000000000000000,"boot":1,"t":' + (AGORA - 1000) + '}', 'seq'],
    [JSON.stringify({ ...valida, seq: 2 ** 31 }), 'seq'],
    [JSON.stringify({ ...valida, boot: 1.5 }), 'boot'],
    [JSON.stringify({ ...valida, t: 0 }), 'relógio do nó não foi acertado'],
    [JSON.stringify({ ...valida, t: AGORA + 5 * 60 * 1000 }), 'adiantado'],
    [JSON.stringify({ ...valida, fila: true }), 'fila'],
  ];
  for (const [texto, trecho] of casos) {
    const r = interpretarMensagem('cria/horta/no1/ph', texto, AGORA);
    assert.equal(r.tipo, 'invalida', texto);
    assert.match(r.motivo, new RegExp(trecho), texto);
  }
});

test('leitura da rota HTTP traz nó e grandeza no próprio objeto', () => {
  const { leitura } = lerLeituraHttp({ no: 'no2', grandeza: 'temperatura', ...valida }, AGORA);
  assert.equal(leitura.no, 'no2');
  assert.equal(leitura.grandeza, 'temperatura');
  assert.match(lerLeituraHttp({ no: 'no2', grandeza: 'status', ...valida }, AGORA).erro, /reservado/);
  assert.match(lerLeituraHttp({ grandeza: 'ph', ...valida }, AGORA).erro, /no ausente/);
  assert.match(lerLeituraHttp([1, 2], AGORA).erro, /não é um objeto/);
});
