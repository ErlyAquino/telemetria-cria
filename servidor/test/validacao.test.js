// Testes dos cálculos de validação. Rode com "npm test", na pasta servidor/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agruparEmFaixas,
  avaliarMedidasManuais,
  calcularDisponibilidade,
  calcularLatencia,
  criarContadorDePerda,
  montarRelatorio,
  percentil,
} from '../src/validacao.js';

const HORA = 3600 * 1000;

test('percentil pelo posto mais próximo', () => {
  const dez = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentil(dez, 0.5), 5);
  assert.equal(percentil(dez, 0.95), 10);
  assert.equal(percentil([7], 0.95), 7);
  assert.equal(percentil([], 0.5), null);
});

test('agrupa lacunas em faixas', () => {
  assert.deepEqual(agruparEmFaixas([3, 4, 5, 9, 11, 12]), [[3, 5], [9, 9], [11, 12]]);
  assert.deepEqual(agruparEmFaixas([]), []);
});

// Leituras de um nó a cada 10 s, de "desde" em diante, com os seq dados.
function publicar(contador, { projeto = 'horta', no = 'no1', boot, seqs, desde }) {
  seqs.forEach((seq, i) => contador.adicionar({ projeto, no, boot, seq, t: desde + i * 10000 }));
}
const intervalo = (de, ate, sem = []) => Array.from({ length: ate - de + 1 }, (_, i) => de + i).filter((s) => !sem.includes(s));

test('perda por nó e por boot, com repetidas contadas uma vez', () => {
  const contador = criarContadorDePerda();
  publicar(contador, { boot: 1, seqs: intervalo(1, 100, [40, 41, 77]), desde: 0 });
  contador.adicionar({ projeto: 'horta', no: 'no1', boot: 1, seq: 50, t: 470000 }); // repetida (reenvio, mesma hora)
  contador.adicionar({ projeto: 'horta', no: 'no1', boot: 1, seq: 59, t: 549999 }); // acerto do relógio inverteu a ordem
  publicar(contador, { projeto: 'ar', boot: 7, seqs: intervalo(5, 104), desde: 0 });

  const { porNo, total, avisos } = contador.resultado({ inicio: 0, fim: 1000000 });
  assert.deepEqual(porNo.map((n) => `${n.projeto}/${n.no}`), ['ar/no1', 'horta/no1']);
  const boot1 = porNo[1].boots[0];
  assert.deepEqual([boot1.menor, boot1.maior, boot1.recebidas, boot1.esperadas, boot1.perdidas], [1, 100, 97, 100, 3]);
  assert.deepEqual(boot1.lacunas, [[40, 41], [77, 77]]);
  assert.equal(porNo[0].boots[0].esperadas, 100); // primeiro boot: começa no seq 5, que chegou primeiro
  assert.deepEqual([total.recebidas, total.esperadas, total.perdidas], [197, 200, 3]);
  assert.deepEqual(avisos, []);
});

test('boot que começou no período conta desde o seq 1', () => {
  const contador = criarContadorDePerda();
  publicar(contador, { boot: 1, seqs: intervalo(200, 299), desde: 0 });
  // O nó reiniciou e as leituras 1 a 50 do boot 2 se perderam (fila cheia, por exemplo).
  publicar(contador, { boot: 2, seqs: intervalo(51, 100), desde: 1000000 });
  const { porNo, total } = contador.resultado({ inicio: 0, fim: 1500000 });
  assert.deepEqual(porNo[0].boots.map((b) => [b.boot, b.menor, b.perdidas]), [[1, 200, 0], [2, 1, 50]]);
  assert.equal(total.perdidas, 50);
});

test('seq que volta atrás no mesmo boot gera aviso', () => {
  const contador = criarContadorDePerda();
  publicar(contador, { boot: 1, seqs: [...intervalo(1, 200), ...intervalo(1, 30)], desde: 0 });
  const { avisos } = contador.resultado({ inicio: 0, fim: 2300000 });
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /voltou atrás 1 vez/);
});

test('nó que se cala no meio do período gera aviso', () => {
  const contador = criarContadorDePerda();
  publicar(contador, { boot: 1, seqs: intervalo(1, 60), desde: 0 }); // 10 min de leituras
  const { avisos } = contador.resultado({ inicio: 0, fim: 2 * HORA });
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /antes do fim do período/);
});

test('latência: percentis e cobertura das medidas', () => {
  const medidas = [...Array(95).fill(300), ...Array(5).fill(2500)].map((ms, i) => ({ t: i * 30000, ms }));
  const r = calcularLatencia(medidas, { inicio: 0, fim: HORA, leiturasAoVivo: 100 });
  assert.deepEqual([r.amostras, r.mediana, r.p95, r.p99, r.maxima], [100, 300, 300, 2500, 2500]);
  assert.equal(r.fracaoAbaixoDoLimite, 0.95);
  assert.equal(r.suficiente, true);

  // Painel aberto só nos primeiros minutos: poucas medidas e horas sem medida.
  const poucas = calcularLatencia([{ t: 0, ms: 300 }, { t: 1000, ms: 390 }], { inicio: 0, fim: 2 * HORA, leiturasAoVivo: 1000 });
  assert.equal(poucas.suficiente, false);
  assert.deepEqual(poucas.horasSemMedida, [HORA]);
  assert.equal(calcularLatencia([], { inicio: 0, fim: HORA, leiturasAoVivo: 10 }).suficiente, false);
});

test('disponibilidade: verificação que faltou conta como falha', () => {
  const verificacoes = [];
  for (let t = 0; t < 100000; t += 10000) {
    if (t === 30000 || t === 40000) continue; // verificador parado
    verificacoes.push({ t, ok: t !== 70000 }); // servidor fora numa verificação
  }
  const r = calcularDisponibilidade(verificacoes, { inicio: 0, fim: 100000, intervaloMs: 10000 });
  assert.deepEqual([r.esperadas, r.verificacoes, r.bemSucedidas, r.fracao], [10, 8, 7, 0.7]);
  assert.deepEqual(r.quedas.map((q) => [q.inicio, q.fim]), [[30000, 50000], [70000, 80000]]);
  assert.match(r.quedas[0].motivo, /sem verificação/);
  assert.match(r.quedas[1].motivo, /não respondeu/);
});

test('disponibilidade: dois verificadores juntos não cobrem as falhas', () => {
  // Servidor fora na segunda metade; dois verificadores consultando juntos.
  const verificacoes = [];
  for (let t = 0; t < 100000; t += 10000) {
    verificacoes.push({ t, ok: t < 50000 });
    verificacoes.push({ t: t + 100, ok: t < 50000 });
  }
  const r = calcularDisponibilidade(verificacoes, { inicio: 0, fim: 100000, intervaloMs: 10000 });
  assert.equal(r.fracao, 0.5);
  // Verificador com intervalo menor que o do relatório: mesma coisa.
  const rapido = [];
  for (let t = 0; t < 100000; t += 2000) rapido.push({ t, ok: t < 50000 });
  assert.equal(calcularDisponibilidade(rapido, { inicio: 0, fim: 100000, intervaloMs: 10000 }).fracao, 0.5);
});

test('medidas manuais: limites, texto com vírgula e valores inválidos', () => {
  const r = avaliarMedidasManuais({
    ph: { referencia: '6,86', medido: 7.06 },
    condutividade: { referencia: 1413, medido: 1484 },
    reuso: { minutos: '31' },
  });
  assert.equal(r.ph.atende, true); // diferença de exatamente 0,2
  assert.equal(r.condutividade.atende, false); // +5,02%
  assert.equal(r.reuso.atende, false);
  assert.deepEqual(avaliarMedidasManuais({ ph: { referencia: 'seis', medido: 7 } }), { ph: { invalido: true } });
  assert.deepEqual(avaliarMedidasManuais(null), {});
});

test('relatório: preliminar, pendente com poucas medidas e verificar com avisos', () => {
  const contador = criarContadorDePerda();
  publicar(contador, { projeto: 'ar', boot: 1, seqs: intervalo(1, 360, [100]), desde: 0 });
  const dataHora = (t) => new Date(t).toISOString();
  const base = {
    inicio: 0,
    fim: HORA,
    geradoEm: HORA,
    projetos: ['ar'],
    perda: contador.resultado({ inicio: 0, fim: HORA }),
    latencia: calcularLatencia([{ t: 0, ms: 200 }], { inicio: 0, fim: HORA, leiturasAoVivo: 359 }),
    leiturasAoVivo: 359,
    disponibilidade: null,
    intervaloDisponibilidadeMs: 30000,
    pastaDosDados: 'validacao/dados',
    manuais: avaliarMedidasManuais({ ph: { referencia: 'x', medido: 1 } }),
    dataHora,
  };
  const texto = montarRelatorio(base);
  assert.match(texto, /Resultado preliminar/);
  assert.match(texto, /\| 1\. Perda de pacotes \| menos de 1% \| 0,28% \(1 de 360\) \| \*\*atende\*\* \|/);
  assert.match(texto, /\| 2\. Latência .* medidas insuficientes \| pendente \|/);
  assert.match(texto, /\| 3\. Exatidão do pH .* valor inválido .* \| pendente \|/);
  assert.match(texto, /\| 5\. Disponibilidade do servidor .* \| pendente \|/);
  assert.match(texto, /copie para essa pasta/);

  const comAviso = criarContadorDePerda();
  publicar(comAviso, { projeto: 'ar', boot: 1, seqs: intervalo(1, 30), desde: 0 });
  const verificar = montarRelatorio({ ...base, perda: comAviso.resultado({ inicio: 0, fim: HORA }) });
  assert.match(verificar, /\| 1\. Perda de pacotes .* veja os avisos \| \*\*verificar\*\* \|/);
  assert.match(verificar, /## Avisos/);
});
