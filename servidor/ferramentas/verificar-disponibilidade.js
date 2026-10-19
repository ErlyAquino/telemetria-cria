// Verificador de disponibilidade do servidor (critério 5).
//
// Consulta o /saude do servidor a cada intervalo e grava cada resposta numa
// linha de validacao/dados/disponibilidade-AAAA-MM-DD.jsonl:
//   {"t":1792345678123,"http":200,"ok":true,"ms":12,"intervaloMs":30000,"relogioMs":-400}
// "relogioMs" é a diferença entre o relógio do servidor e o deste computador,
// medida pelo cabeçalho Date da resposta (precisão de 1 s).
// O relatório de validação (npm run relatorio) lê esses arquivos.
//
// Rode durante todo o teste de aceitação, de preferência noutro computador da
// rede, para que uma queda do servidor não leve o verificador junto:
//   npm run disponibilidade -- --url http://IP_DO_SERVIDOR:3000
//
// Opções: --url (padrão: SERVIDOR_URL do .env, ou http://localhost:3000),
//         --intervalo em segundos (padrão: 30),
//         --pasta onde gravar (padrão: validacao/dados; use outra em ensaios).

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARQUIVO_ENV = join(RAIZ, '.env');
if (existsSync(ARQUIVO_ENV)) process.loadEnvFile(ARQUIVO_ENV);

let opcoes;
try {
  ({ values: opcoes } = parseArgs({
    options: {
      url: { type: 'string', default: process.env.SERVIDOR_URL || 'http://localhost:3000' },
      intervalo: { type: 'string', default: '30' },
      pasta: { type: 'string', default: join(RAIZ, 'validacao', 'dados') },
    },
  }));
} catch (erro) {
  console.error(`${erro.message}\nUso: npm run disponibilidade -- --url http://IP_DO_SERVIDOR:3000 --intervalo 30`);
  process.exit(1);
}

const intervaloS = Number(opcoes.intervalo);
if (!(intervaloS >= 1)) {
  console.error('O --intervalo precisa ser um número de segundos, a partir de 1.');
  process.exit(1);
}
const enderecoDaSaude = `${opcoes.url.replace(/\/$/, '')}/saude`;
const PASTA_DOS_DADOS = opcoes.pasta;
mkdirSync(PASTA_DOS_DADOS, { recursive: true });

// Um arquivo por dia (UTC), para não crescer sem fim.
function arquivoDoDia(t) {
  return join(PASTA_DOS_DADOS, `disponibilidade-${new Date(t).toISOString().slice(0, 10)}.jsonl`);
}

// Acima disso, o relógio deste computador está longe do relógio do servidor, e
// o relatório marcaria as pontas do período como "sem verificação".
const DIFERENCA_DE_RELOGIO_TOLERADA_MS = 5000;

async function verificar() {
  const t = Date.now();
  let http = 0;
  let relogioMs = null;
  try {
    // A resposta tem de chegar antes da próxima verificação.
    const resposta = await fetch(enderecoDaSaude, { signal: AbortSignal.timeout(Math.min(10, intervaloS) * 1000) });
    http = resposta.status;
    const horaDoServidor = Date.parse(resposta.headers.get('date') ?? '');
    if (Number.isFinite(horaDoServidor)) relogioMs = horaDoServidor - Math.round((t + Date.now()) / 2);
  } catch {
    http = 0; // sem resposta: servidor desligado, travado ou fora da rede
  }
  const registro = { t, http, ok: http === 200, ms: Date.now() - t, intervaloMs: intervaloS * 1000, relogioMs };
  try {
    appendFileSync(arquivoDoDia(t), `${JSON.stringify(registro)}\n`);
  } catch (erro) {
    console.error(`Não foi possível gravar a verificação (${erro.message}); o verificador continua.`);
  }
  const hora = new Date(t).toLocaleTimeString('pt-BR');
  console.log(`${hora}  ${registro.ok ? 'OK   ' : 'FALHA'}  HTTP ${http || 'sem resposta'}  (${registro.ms} ms)`);
  if (relogioMs !== null && Math.abs(relogioMs) > DIFERENCA_DE_RELOGIO_TOLERADA_MS) {
    console.warn(`         AVISO: o relógio deste computador está ${Math.round(relogioMs / -1000)} s ` +
      'diferente do servidor. Acerte-o pelo servidor (veja validacao/README.md).');
  }
}

console.log(`Verificando ${enderecoDaSaude} a cada ${intervaloS} s. Dados em ${PASTA_DOS_DADOS}. Ctrl+C encerra.`);
verificar();
const relogio = setInterval(verificar, intervaloS * 1000);
process.once('SIGINT', () => {
  clearInterval(relogio);
  process.exit(0);
});
