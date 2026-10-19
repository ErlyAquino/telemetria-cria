// Gera o relatório de validação (validacao/relatorio-validacao.md) com os seis
// critérios de aceitação.
//
//   npm run relatorio                         # últimas 24 h, todos os projetos menos "teste"
//   npm run relatorio -- --inicio 2026-12-08T09:00 --fim 2026-12-09T09:00
//
// De onde vem cada número:
//   1 (perda) e 2 (latência)  consultas ao InfluxDB, com o INFLUX_* do .env
//   5 (disponibilidade)       arquivos do verificador (npm run disponibilidade)
//   3 (pH), 4 (condutividade) e 6 (reuso)  validacao/medidas-manuais.json,
//                             preenchido pela equipe (modelo: medidas-manuais.exemplo.json)
//
// Opções:
//   --horas N        período terminando agora (padrão: 24)
//   --inicio, --fim  período exato, na hora da escola (FUSO_HORARIO do .env,
//                    padrão America/Recife), ex.: 2026-12-08T09:00
//   --projetos       lista separada por vírgula, que substitui o padrão (todos, menos "teste")
//   --intervalo-disponibilidade  segundos entre verificações (padrão: o gravado pelo verificador)
//   --dados          pasta dos arquivos do verificador (padrão: validacao/dados)
//   --manuais        arquivo das medidas manuais (padrão: validacao/medidas-manuais.json)
//   --saida          arquivo do relatório (padrão: validacao/relatorio-validacao.md)

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InfluxDB, flux, fluxDateTime, fluxExpression } from '@influxdata/influxdb-client';
import { NOME_VALIDO } from '../src/catalogo.js';
import { lerConfigDoInflux } from '../src/config.js';
import {
  avaliarMedidasManuais,
  calcularDisponibilidade,
  calcularLatencia,
  criarContadorDePerda,
  montarRelatorio,
} from '../src/validacao.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASTA_VALIDACAO = join(RAIZ, 'validacao');
const INTERVALO_PADRAO_S = 30;
const DIFERENCA_DE_RELOGIO_TOLERADA_MS = 5000;

function parar(mensagem) {
  console.error(mensagem);
  process.exit(1);
}

let opcoes;
try {
  ({ values: opcoes } = parseArgs({
    options: {
      horas: { type: 'string', default: '24' },
      inicio: { type: 'string' },
      fim: { type: 'string' },
      projetos: { type: 'string' },
      'intervalo-disponibilidade': { type: 'string' },
      dados: { type: 'string', default: join(PASTA_VALIDACAO, 'dados') },
      manuais: { type: 'string', default: join(PASTA_VALIDACAO, 'medidas-manuais.json') },
      saida: { type: 'string', default: join(PASTA_VALIDACAO, 'relatorio-validacao.md') },
    },
  }));
} catch (erro) {
  parar(`${erro.message}\nVeja as opções no início de ferramentas/gerar-relatorio-validacao.js.`);
}

let influx;
try {
  influx = lerConfigDoInflux();
} catch (erro) {
  parar(erro.message);
}
const fusoHorario = process.env.FUSO_HORARIO || 'America/Recife';
const avisos = [];

// ---------------------------------------------------------------------------
// Período e projetos

// Lê uma data e hora sem fuso (2026-12-08T09:00) como hora da escola, e não do
// computador: o servidor pode estar em UTC, como o Ubuntu vem de fábrica.
function lerHoraDaEscola(texto) {
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(texto)) return Date.parse(texto);
  const comoUtc = Date.parse(`${texto}Z`);
  if (!Number.isFinite(comoUtc)) return NaN;
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: fusoHorario,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(comoUtc)
      .map((p) => [p.type, Number(p.value)]),
  );
  const diferencaDoFuso = Date.UTC(partes.year, partes.month - 1, partes.day, partes.hour, partes.minute, partes.second) - comoUtc;
  return comoUtc - diferencaDoFuso;
}

const fim = opcoes.fim ? lerHoraDaEscola(opcoes.fim) : Date.now();
const inicio = opcoes.inicio ? lerHoraDaEscola(opcoes.inicio) : fim - Number(opcoes.horas) * 3600 * 1000;
if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio >= fim) {
  parar('Período inválido: confira --inicio, --fim ou --horas (ex.: --inicio 2026-12-08T09:00).');
}
const projetos = opcoes.projetos ? opcoes.projetos.split(',').map((p) => p.trim()).filter(Boolean) : [];
for (const p of projetos) if (!NOME_VALIDO.test(p)) parar(`Projeto "${p}" fora das regras do catálogo.`);

// Sem --projetos, entram todos menos "teste", que é das oficinas.
const filtroDeProjeto = projetos.length
  ? fluxExpression(projetos.map((p) => flux`r.projeto == ${p}`).join(' or '))
  : fluxExpression('r.projeto != "teste"');

const dataHora = (t) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: fusoHorario, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(t));

console.log(`Período: de ${dataHora(inicio)} a ${dataHora(fim)} (hora de ${fusoHorario}).`);

// ---------------------------------------------------------------------------
// Banco: perda (seq e boot de cada leitura) e latência

const consulta = new InfluxDB({ url: influx.url, token: influx.token, timeout: 5 * 60 * 1000 }).getQueryApi(influx.org);
const periodo = flux`range(start: ${fluxDateTime(new Date(inicio).toISOString())}, stop: ${fluxDateTime(new Date(fim).toISOString())})`;

const contador = criarContadorDePerda();
let leiturasAoVivo = 0;
const medidasDeLatencia = [];
try {
  const consultaDasLeituras = flux`
    from(bucket: ${influx.bucket})
      |> ${periodo}
      |> filter(fn: (r) => r._measurement == "leitura" and (r._field == "seq" or r._field == "boot" or r._field == "fila"))
      |> filter(fn: (r) => ${filtroDeProjeto})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;
  for await (const { values, tableMeta } of consulta.iterateRows(consultaDasLeituras)) {
    const r = tableMeta.toObject(values);
    if (!Number.isInteger(r.seq) || !Number.isInteger(r.boot)) continue;
    contador.adicionar({ projeto: r.projeto, no: r.no, boot: r.boot, seq: r.seq, t: Date.parse(r._time) });
    if (r.fila !== true) leiturasAoVivo += 1;
  }

  const consultaDaLatencia = flux`
    from(bucket: ${influx.bucket})
      |> ${periodo}
      |> filter(fn: (r) => r._measurement == "latencia_painel" and r._field == "ms")
      |> filter(fn: (r) => ${filtroDeProjeto})`;
  for await (const { values, tableMeta } of consulta.iterateRows(consultaDaLatencia)) {
    const r = tableMeta.toObject(values);
    medidasDeLatencia.push({ t: Date.parse(r._time), ms: r._value });
  }
} catch (erro) {
  parar(`Não foi possível consultar o InfluxDB em ${influx.url}: ${erro.message}`);
}

// ---------------------------------------------------------------------------
// Verificações do /saude

function lerVerificacoes(pasta) {
  if (!existsSync(pasta)) return [];
  const verificacoes = [];
  for (const nome of readdirSync(pasta).filter((n) => /^disponibilidade-.*\.jsonl$/.test(n))) {
    for (const linha of readFileSync(join(pasta, nome), 'utf8').split('\n')) {
      if (!linha.trim()) continue;
      try {
        const { t, ok, intervaloMs, relogioMs } = JSON.parse(linha);
        if (Number.isFinite(t)) verificacoes.push({ t, ok: ok === true, intervaloMs, relogioMs });
      } catch {
        // linha cortada (o verificador parou no meio da escrita): ignorada
      }
    }
  }
  return verificacoes;
}

const verificacoes = lerVerificacoes(opcoes.dados).filter((v) => v.t >= inicio && v.t < fim);

// O intervalo é o que o verificador gravou (o mais comum, se variou).
const contagemDeIntervalos = new Map();
for (const v of verificacoes) {
  if (Number.isFinite(v.intervaloMs)) contagemDeIntervalos.set(v.intervaloMs, (contagemDeIntervalos.get(v.intervaloMs) ?? 0) + 1);
}
const intervaloGravado = [...contagemDeIntervalos].sort((a, b) => b[1] - a[1])[0]?.[0];
let intervaloDisponibilidadeMs = intervaloGravado ?? INTERVALO_PADRAO_S * 1000;
if (opcoes['intervalo-disponibilidade'] !== undefined) {
  intervaloDisponibilidadeMs = Number(opcoes['intervalo-disponibilidade']) * 1000;
  if (!(intervaloDisponibilidadeMs >= 1000)) parar('O --intervalo-disponibilidade precisa ser de pelo menos 1 s.');
  if (intervaloGravado && intervaloGravado !== intervaloDisponibilidadeMs) {
    avisos.push(`O verificador consultou a cada ${intervaloGravado / 1000} s, mas o relatório usou --intervalo-disponibilidade ${intervaloDisponibilidadeMs / 1000}.`);
  }
}
if (contagemDeIntervalos.size > 1) {
  avisos.push(`As verificações do período usaram intervalos diferentes (${[...contagemDeIntervalos.keys()].map((ms) => `${ms / 1000} s`).join(', ')}); o relatório usou ${intervaloDisponibilidadeMs / 1000} s.`);
}
const longeDoServidor = verificacoes.filter((v) => Number.isFinite(v.relogioMs) && Math.abs(v.relogioMs) > DIFERENCA_DE_RELOGIO_TOLERADA_MS);
if (longeDoServidor.length) {
  const maior = Math.max(...longeDoServidor.map((v) => Math.abs(v.relogioMs)));
  avisos.push(`O relógio do computador do verificador ficou até ${Math.round(maior / 1000)} s diferente do relógio do servidor; ` +
    'as quedas podem aparecer deslocadas e as pontas do período, como "sem verificação".');
}
const disponibilidade = verificacoes.length
  ? calcularDisponibilidade(verificacoes, { inicio, fim, intervaloMs: intervaloDisponibilidadeMs })
  : null;

// ---------------------------------------------------------------------------
// Medidas manuais

let medidasManuais = {};
if (existsSync(opcoes.manuais)) {
  try {
    medidasManuais = JSON.parse(readFileSync(opcoes.manuais, 'utf8'));
  } catch (erro) {
    parar(`O arquivo ${opcoes.manuais} não é um JSON válido: ${erro.message}`);
  }
}

// ---------------------------------------------------------------------------
// Relatório

const texto = montarRelatorio({
  inicio,
  fim,
  geradoEm: Date.now(),
  projetos: projetos.length ? projetos : ['todos, menos teste'],
  perda: contador.resultado({ inicio, fim }),
  latencia: calcularLatencia(medidasDeLatencia, { inicio, fim, leiturasAoVivo }),
  leiturasAoVivo,
  disponibilidade,
  intervaloDisponibilidadeMs,
  pastaDosDados: opcoes.dados,
  manuais: avaliarMedidasManuais(medidasManuais),
  avisos,
  dataHora,
});
writeFileSync(opcoes.saida, texto);

// Resumo no terminal: a tabela do início do relatório e os avisos.
const resumo = texto.split('\n## Resumo\n')[1]?.split('\n## 1.')[0] ?? '';
console.log(resumo.trim());
console.log(`\nRelatório completo em ${opcoes.saida}`);
