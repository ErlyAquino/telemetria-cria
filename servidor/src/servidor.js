// Servidor da Rede de Telemetria do Espaço CRIA.
//
// Assina cria/# no broker, grava cada leitura no InfluxDB e a repassa ao painel
// em tempo real pelo Socket.IO. Também serve o painel, a exportação em CSV, a
// rota HTTP das placas Arduino e o /saude, consultado no teste de disponibilidade.
//
// Uso, na pasta servidor/:  npm start
// Rotas e eventos: servidor/README.md.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { conectarAssinante } from './assinante.js';
import { criarBanco } from './banco.js';
import { NOME_VALIDO, NO_VALIDO, PROJETOS_RESERVADOS, interpretarMensagem, lerLeituraHttp } from './catalogo.js';
import { lerConfig } from './config.js';
import { criarFormatador } from './csv.js';
import { criarEstado } from './estado.js';
import { criarPublicadorHttp } from './publicador-http.js';

const PASTA_SERVIDOR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA_CHART_JS = dirname(createRequire(import.meta.url).resolve('chart.js'));
const LEITURAS_POR_ENVIO_HTTP = 1000;
const LATENCIAS_GUARDADAS = 500;
// Acima disso, o aviso "desenhado" não é de uma leitura recente: é descartado.
const LATENCIA_MAXIMA_ACEITA_MS = 60000;

let config;
try {
  config = lerConfig();
} catch (erro) {
  console.error(erro.message);
  process.exit(1);
}

const banco = criarBanco(config.influx);
const estado = criarEstado({ segundosAteOfflineHttp: config.segundosAteOfflineHttp });
const publicadorHttp = criarPublicadorHttp(config.mqtt);
const app = Fastify();
const io = new Server(app.server);

const iniciadoEm = new Date();
const contadores = { recebidas: 0, invalidas: 0, recebidasPorHttp: 0 };
let mqttConectado = false;
let influxRespondendo = false;
let assinante = null;

// Latência do critério 2: últimas medidas e quantos avisos foram recusados.
const latencias = [];
let avisosDeDesenhoRecusados = 0;
// t da última leitura enviada ao painel, por série "projeto/no/grandeza".
const ultimoTEnviado = new Map();

// Erros inesperados nas rotas aparecem no terminal; os de validação (400) não.
app.setErrorHandler((erro, pedido, resposta) => {
  if (!erro.statusCode || erro.statusCode >= 500) {
    console.error(`Erro em ${pedido.method} ${pedido.url}: ${erro.message}`);
  }
  resposta.send(erro);
});

// ---------------------------------------------------------------------------
// Mensagens do broker

let ultimoAvisoDeInvalida = 0;
let invalidasSemAviso = 0;

function aoReceber(topico, texto) {
  const m = interpretarMensagem(topico, texto);
  if (m.tipo === 'leitura') {
    contadores.recebidas += 1;
    const statusMudou = estado.registrarLeitura(m);
    banco.gravarLeitura(m);
    if (!m.fila) ultimoTEnviado.set(`${m.projeto}/${m.no}/${m.grandeza}`, m.t);
    io.emit('leitura', m);
    if (statusMudou) io.emit('no', estado.resumoDoNo(m.projeto, m.no));
  } else if (m.tipo === 'status') {
    if (estado.registrarStatus(m.projeto, m.no, m.status)) io.emit('no', estado.resumoDoNo(m.projeto, m.no));
  } else if (m.tipo === 'invalida') {
    contadores.invalidas += 1;
    // Um nó com defeito pode mandar a mesma mensagem errada a cada 10 s:
    // avisa no máximo uma vez a cada 10 s, com a contagem do que foi calado.
    const agora = Date.now();
    if (agora - ultimoAvisoDeInvalida > 10000) {
      const extra = invalidasSemAviso ? ` (e mais ${invalidasSemAviso} inválidas desde o último aviso)` : '';
      console.warn(`Mensagem fora do catálogo: ${m.motivo}${extra}`);
      ultimoAvisoDeInvalida = agora;
      invalidasSemAviso = 0;
    } else {
      invalidasSemAviso += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Painel em tempo real

io.on('connection', (socket) => {
  // "agora" deixa o painel corrigir a diferença entre o relógio dele e o do servidor.
  socket.emit('nos', { agora: Date.now(), nos: estado.resumo() });
  socket.data.medidos = new Map(); // série -> t já medido por este painel

  // O painel avisa quando desenhou um ponto; a diferença entre essa hora e o t
  // da leitura é a latência do critério 2 (mqtt/catalogo-topicos.md, seção 2).
  // Só vale para a última leitura enviada daquela série, uma vez por painel:
  // assim ninguém inventa medidas nem multiplica as gravações.
  socket.on('desenhado', (dados) => {
    try {
      const { projeto, no, grandeza, t } = dados ?? {};
      if (typeof projeto !== 'string' || typeof no !== 'string' || typeof grandeza !== 'string') return;
      if (!Number.isSafeInteger(t)) return;
      const serie = `${projeto}/${no}/${grandeza}`;
      if (ultimoTEnviado.get(serie) !== t || socket.data.medidos.get(serie) === t) {
        avisosDeDesenhoRecusados += 1;
        return;
      }
      socket.data.medidos.set(serie, t);
      const ms = Date.now() - t;
      if (ms < 0 || ms > LATENCIA_MAXIMA_ACEITA_MS) {
        avisosDeDesenhoRecusados += 1;
        return;
      }
      latencias.push(ms);
      if (latencias.length > LATENCIAS_GUARDADAS) latencias.shift();
      banco.gravarLatencia({ projeto, no, grandeza, ms });
    } catch (erro) {
      console.error(`Erro ao registrar latência: ${erro.message}`);
    }
  });
});

function resumoDasLatencias() {
  const resumo = { amostras: latencias.length, avisosRecusados: avisosDeDesenhoRecusados };
  if (latencias.length === 0) return resumo;
  const ordenadas = [...latencias].sort((a, b) => a - b);
  const percentil = (p) => ordenadas[Math.min(ordenadas.length - 1, Math.floor(p * ordenadas.length))];
  return { ...resumo, mediana: percentil(0.5), p95: percentil(0.95), maxima: ordenadas[ordenadas.length - 1] };
}

// ---------------------------------------------------------------------------
// Rotas

await app.register(fastifyStatic, { root: join(PASTA_SERVIDOR, 'painel') });
await app.register(fastifyStatic, { root: PASTA_CHART_JS, prefix: '/vendor/chart.js/', decorateReply: false });

app.get('/saude', async (_pedido, resposta) => {
  const gravacaoEmDia = banco.gravacaoEmDia();
  const ok = mqttConectado && influxRespondendo && gravacaoEmDia;
  resposta.code(ok ? 200 : 503);
  return {
    ok,
    mqtt: { conectado: mqttConectado },
    influx: { respondendo: influxRespondendo, gravacaoEmDia, ...banco.contagem },
    leituras: contadores,
    latenciaPainelMs: resumoDasLatencias(),
    iniciadoEm: iniciadoEm.toISOString(),
    segundosNoAr: Math.round((Date.now() - iniciadoEm) / 1000),
  };
});

app.get('/api/nos', async () => estado.resumo());

const NOME = { type: 'string', pattern: NOME_VALIDO.source };
const NO = { type: 'string', pattern: NO_VALIDO.source };

app.get(
  '/api/historico',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['projeto', 'no', 'grandeza'],
        properties: { projeto: NOME, no: NO, grandeza: NOME, minutos: { type: 'integer', minimum: 1, maximum: 1440, default: 60 } },
      },
    },
  },
  async (pedido, resposta) => {
    try {
      return await banco.consultarSerie(pedido.query);
    } catch (erro) {
      console.error(`Histórico: o InfluxDB falhou (${erro.message}).`);
      resposta.code(503);
      return { erro: 'o banco de dados não respondeu; tente de novo em instantes' };
    }
  },
);

// Uma exportação por vez: um CSV de 31 dias pesa no servidor e no banco.
let exportando = false;

app.get(
  '/api/exportar.csv',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          projeto: NOME,
          no: NO,
          grandeza: NOME,
          horas: { type: 'integer', minimum: 1, maximum: 24 * 31, default: 24 },
          formato: { type: 'string', enum: ['br', 'internacional'], default: 'br' },
        },
      },
    },
  },
  async (pedido, resposta) => {
    if (exportando) {
      resposta.code(429);
      return { erro: 'outra exportação está em andamento; tente de novo em instantes' };
    }
    const { projeto = '', no = '', grandeza = '', horas, formato } = pedido.query;
    const fim = new Date();
    const inicio = new Date(fim.getTime() - horas * 3600 * 1000);
    const csv = criarFormatador({ formato, fusoHorario: config.fusoHorario });
    const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: config.fusoHorario }).format(fim);
    const nome = ['telemetria', projeto, no, grandeza, hoje].filter(Boolean).join('-');

    exportando = true;
    const registros = banco.consultarParaExportar({ projeto, no, grandeza, inicio, fim })[Symbol.asyncIterator]();
    // Busca a primeira linha antes de responder: se o banco estiver fora, a
    // resposta é um erro, e não um arquivo só com o cabeçalho.
    let primeiro;
    try {
      primeiro = await registros.next();
    } catch (erro) {
      exportando = false;
      console.error(`Exportação: o InfluxDB falhou (${erro.message}).`);
      resposta.code(503);
      return { erro: 'o banco de dados não respondeu; tente de novo em instantes' };
    }

    async function* linhas() {
      try {
        yield csv.cabecalho();
        if (!primeiro.done) yield csv.linha(primeiro.value);
        for (let r = await registros.next(); !r.done; r = await registros.next()) yield csv.linha(r.value);
      } catch (erro) {
        console.error(`Exportação interrompida no meio: ${erro.message}`);
        throw erro;
      } finally {
        exportando = false;
      }
    }
    resposta
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${nome}.csv"`);
    return resposta.send(Readable.from(linhas()));
  },
);

// Rota HTTP das placas Arduino (gateway). Usuário e senha são os do projeto no
// broker, enviados por autenticação Basic. O corpo é uma lista de leituras no
// formato da seção 2 do catálogo, com "no" e "grandeza" em cada uma.
app.decorateRequest('credencial', null);

app.post(
  '/api/leituras',
  {
    bodyLimit: 256 * 1024,
    // Confere usuário e senha antes de ler o corpo.
    onRequest: async (pedido, resposta) => {
      const credencial = lerAutenticacaoBasic(pedido.headers.authorization);
      if (!credencial) {
        return resposta
          .code(401)
          .header('WWW-Authenticate', 'Basic realm="telemetria-cria"')
          .send({ erro: 'envie o usuário e a senha do projeto (autenticação Basic)' });
      }
      if (!NOME_VALIDO.test(credencial.usuario) || PROJETOS_RESERVADOS.has(credencial.usuario)) {
        return resposta.code(403).send({ erro: `"${credencial.usuario.slice(0, 40)}" não é um projeto do catálogo` });
      }
      pedido.credencial = credencial;
    },
  },
  async (pedido, resposta) => {
    const { usuario: projeto, senha } = pedido.credencial;
    const itens = pedido.body;
    if (!Array.isArray(itens) || itens.length === 0 || itens.length > LEITURAS_POR_ENVIO_HTTP) {
      resposta.code(400);
      return { erro: `o corpo deve ser uma lista JSON com 1 a ${LEITURAS_POR_ENVIO_HTTP} leituras` };
    }

    const aceitas = [];
    const recusadas = [];
    itens.forEach((item, indice) => {
      const { leitura, erro } = lerLeituraHttp(item);
      if (erro) recusadas.push({ indice, motivo: erro });
      else aceitas.push(leitura);
    });
    if (aceitas.length === 0) {
      resposta.code(400);
      return { aceitas: 0, recusadas };
    }

    try {
      await publicadorHttp.publicar(projeto, senha, aceitas);
    } catch (erro) {
      if (erro.codigo === 'recusado') {
        resposta.code(401).header('WWW-Authenticate', 'Basic realm="telemetria-cria"');
        return { erro: `o broker recusou o usuário "${projeto}" com essa senha` };
      }
      resposta.code(503);
      return { erro: erro.message };
    }

    contadores.recebidasPorHttp += aceitas.length;
    for (const no of new Set(aceitas.map((l) => l.no))) estado.marcarOrigemHttp(projeto, no);
    return { aceitas: aceitas.length, recusadas };
  },
);

function lerAutenticacaoBasic(cabecalho) {
  if (typeof cabecalho !== 'string' || !cabecalho.startsWith('Basic ')) return null;
  const texto = Buffer.from(cabecalho.slice(6), 'base64').toString('utf8');
  const separador = texto.indexOf(':');
  if (separador <= 0) return null;
  return { usuario: texto.slice(0, separador), senha: texto.slice(separador + 1) };
}

// ---------------------------------------------------------------------------
// Tarefas periódicas

async function verificarInflux() {
  const antes = influxRespondendo;
  influxRespondendo = await banco.estaRespondendo();
  if (antes && !influxRespondendo) console.error('InfluxDB: não está respondendo.');
  if (!antes && influxRespondendo) console.log(`InfluxDB: respondendo em ${config.influx.url}`);
}
setInterval(verificarInflux, 15000).unref();

// A cada 5 s: nós das placas Arduino que se calaram, e a perda estimada dos
// nós que receberam leituras, para o painel não ficar com o número parado.
setInterval(() => {
  const mudaram = new Set([...estado.verificarSilencio(), ...estado.retirarAlterados()]);
  for (const n of mudaram) io.emit('no', estado.resumoDe(n));
}, 5000).unref();

// ---------------------------------------------------------------------------
// Partida e parada
//
// A assinatura do broker é o último passo: as leituras guardadas pelo broker
// só chegam quando o banco, o estado e a porta HTTP já estão prontos. Se a porta
// estiver ocupada (outro servidor rodando), o processo para antes de tomar a
// sessão do broker do servidor que já está no ar.

await verificarInflux();
if (influxRespondendo) {
  try {
    estado.carregarUltimas(await banco.consultarUltimasLeituras());
  } catch (erro) {
    console.warn(`InfluxDB: não foi possível carregar as últimas leituras (${erro.message}).`);
  }
}

await app.listen({ port: config.portaHttp, host: '0.0.0.0' });
console.log(`Painel: http://localhost:${config.portaHttp}  (saúde em /saude)`);

assinante = conectarAssinante(config.mqtt, {
  aoReceber,
  aoMudarConexao: (conectado) => {
    mqttConectado = conectado;
  },
});

async function encerrar() {
  console.log('Encerrando: gravando o que falta no banco...');
  setTimeout(() => process.exit(1), 10000).unref();
  // Primeiro os painéis, para nenhum "desenhado" chegar com o banco já fechado.
  io.disconnectSockets(true);
  try {
    await assinante?.fechar();
    await publicadorHttp.fechar();
  } finally {
    await banco.fechar().catch((erro) => console.error(`InfluxDB: ${erro.message}`));
    await app.close(); // fecha também o servidor HTTP que o Socket.IO usa
    process.exit(0);
  }
}
process.once('SIGINT', encerrar);
process.once('SIGTERM', encerrar);
