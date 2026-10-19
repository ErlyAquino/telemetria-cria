// Nó simulado da rede de telemetria.
//
// Faz o papel de um ESP32 enquanto as placas não chegam, seguindo o catálogo de
// tópicos (mqtt/catalogo-topicos.md): conecta no broker com o usuário do
// projeto, registra o LWT, publica "online" e, a cada intervalo, gera uma
// leitura por grandeza, com seq, boot e t. Se a conexão cair, guarda as leituras
// numa fila e as reenvia com "fila": 1 quando ela voltar.
//
// Uso, na pasta servidor/:
//   npm run simulador
//   npm run simulador -- --no no2 --perfil horta-no2 --intervalo 2
//   npm run simulador -- --perda 0.01
//
// O endereço do broker (MQTT_HOST, MQTT_PORTA), o projeto (SIMULADOR_PROJETO) e
// a senha do projeto (SIMULADOR_SENHA) vêm do .env da raiz do repositório.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';

const PASTA = dirname(fileURLToPath(import.meta.url));
const ARQUIVO_ENV = join(PASTA, '..', '..', '.env');
const PASTA_ESTADO = join(PASTA, '.estado');
const TAMANHO_MAXIMO_DA_FILA = 5000;

// ---------------------------------------------------------------------------
// Configuração: .env e opções da linha de comando

if (existsSync(ARQUIVO_ENV)) process.loadEnvFile(ARQUIVO_ENV);

let opcoes;
try {
  ({ values: opcoes } = parseArgs({
    options: {
      projeto: { type: 'string', default: process.env.SIMULADOR_PROJETO || 'teste' },
      no: { type: 'string', default: 'no1' },
      perfil: { type: 'string' },
      intervalo: { type: 'string', default: '10' },
      perda: { type: 'string', default: '0' },
      ajuda: { type: 'boolean', short: 'h', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (erro) {
  // Opção desconhecida ou sem valor: explica e mostra a ajuda.
  console.error(`${erro.message}\n`);
  opcoes = { ajuda: true, opcaoErrada: true };
}

// ---------------------------------------------------------------------------
// Perfis: as grandezas de cada nó do catálogo, com valores plausíveis.
// "gerar" recebe o instante da leitura e devolve o valor, sem arredondar.

const PERFIS = {
  temperatura: [
    { grandeza: 'temperatura', unidade: 'C', casas: 1, gerar: (d) => diario(d, 26, 2, 15) + ruido(0.1) },
  ],
  'ar-no1': [
    { grandeza: 'mq2', unidade: 'Rs/R0', casas: 2, gerar: () => 1.0 + ruido(0.02) },
    { grandeza: 'mq135', unidade: 'Rs/R0', casas: 2, gerar: (d) => 1.0 - 0.15 * ocupacao(d) + ruido(0.02) },
    { grandeza: 'co2', unidade: 'ppm', casas: 0, gerar: (d) => 450 + 700 * ocupacao(d) + ruido(15) },
    { grandeza: 'temperatura', unidade: 'C', casas: 1, gerar: (d) => diario(d, 27, 3, 15) + ruido(0.2) },
    { grandeza: 'umidade', unidade: '%', casas: 1, gerar: (d) => diario(d, 65, 10, 5) + ruido(1) },
  ],
  'horta-no1': [
    { grandeza: 'ph', unidade: 'pH', casas: 2, gerar: (d) => 6.0 + 0.2 * onda(d, 8) + ruido(0.02) },
    { grandeza: 'condutividade', unidade: 'uS/cm', casas: 0, gerar: (d) => 1500 + 40 * onda(d, 12) + ruido(8) },
    { grandeza: 'temperatura', unidade: 'C', casas: 1, gerar: (d) => diario(d, 24, 2, 15) + ruido(0.1) },
    { grandeza: 'vazao', unidade: 'L/min', casas: 2, gerar: () => 2.0 + ruido(0.05) },
    { grandeza: 'pressao', unidade: 'kPa', casas: 1, gerar: () => 12 + ruido(0.3) },
    { grandeza: 'nivel', unidade: 'estado', casas: 0, gerar: () => 1 },
  ],
  'horta-no2': [
    { grandeza: 'umidade', unidade: '%', casas: 1, gerar: (d) => diario(d, 70, 15, 5) + ruido(1) },
    { grandeza: 'iluminancia', unidade: 'lx', casas: 0, gerar: (d) => (painelLigado(d) ? 9000 + ruido(150) : 0) },
    { grandeza: 'temperatura', unidade: 'C', casas: 1, gerar: (d) => diario(d, 27, 3, 15) + ruido(0.2) },
  ],
};

// Variação ao longo do dia: média, amplitude e hora em que o valor é máximo.
function diario(data, media, amplitude, horaDoPico) {
  const hora = data.getHours() + data.getMinutes() / 60;
  return media + amplitude * Math.cos((2 * Math.PI * (hora - horaDoPico)) / 24);
}

// Oscilação lenta entre -1 e 1, com o período dado em horas.
function onda(data, periodoEmHoras) {
  return Math.sin((2 * Math.PI * data.getTime()) / (periodoEmHoras * 3600 * 1000));
}

// Ruído com distribuição normal (Box-Muller) e o desvio-padrão dado.
function ruido(desvio) {
  const u = 1 - Math.random();
  const v = Math.random();
  return desvio * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 1 nos horários de aula (dias úteis, 7h às 12h e 13h às 17h); 0 fora deles.
function ocupacao(data) {
  const dia = data.getDay();
  const hora = data.getHours();
  const diaUtil = dia >= 1 && dia <= 5;
  return diaUtil && ((hora >= 7 && hora < 12) || (hora >= 13 && hora < 17)) ? 1 : 0;
}

// Fotoperíodo de 12 h: painel de cultivo ligado das 6h às 18h.
function painelLigado(data) {
  const hora = data.getHours();
  return hora >= 6 && hora < 18;
}

function arredondar(valor, casas) {
  return Number(valor.toFixed(casas));
}

// ---------------------------------------------------------------------------
// Conferência das opções

if (opcoes.ajuda || opcoes.help) {
  console.log(`Nó simulado da telemetria.

Opções:
  --projeto NOME     projeto do catálogo; o usuário MQTT é o mesmo nome (padrão: SIMULADOR_PROJETO do .env, ou "teste")
  --no NOME          nó dentro do projeto, ex.: no1 (padrão: no1)
  --perfil NOME      grandezas simuladas: ${Object.keys(PERFIS).join(', ')}
                     (padrão: o perfil projeto-no, se existir; senão "temperatura")
  --intervalo S      segundos entre leituras (padrão: 10)
  --perda F          fração de leituras descartadas de propósito, ex.: 0.01 (padrão: 0)`);
  process.exit(opcoes.opcaoErrada ? 1 : 0);
}

const projeto = opcoes.projeto;
const no = opcoes.no;
const nomePerfil = opcoes.perfil || (PERFIS[`${projeto}-${no}`] ? `${projeto}-${no}` : 'temperatura');
const intervaloEmSegundos = Number(opcoes.intervalo);
const perda = Number(opcoes.perda);
const senha = process.env.SIMULADOR_SENHA;
const host = process.env.MQTT_HOST || 'localhost';
const porta = Number(process.env.MQTT_PORTA || 1883);

function parar(mensagem) {
  console.error(mensagem);
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(projeto) || projeto === 'servidor') parar(`Projeto "${projeto}" fora das regras do catálogo (seção 1).`);
if (!/^no[1-9][0-9]*$/.test(no)) parar(`Nó "${no}" fora das regras do catálogo: use no1, no2, ...`);
if (!PERFIS[nomePerfil]) parar(`Perfil "${nomePerfil}" não existe. Perfis: ${Object.keys(PERFIS).join(', ')}.`);
if (!(intervaloEmSegundos > 0)) parar('O --intervalo precisa ser um número de segundos maior que zero.');
if (!(perda >= 0 && perda < 1)) parar('A --perda precisa ser uma fração entre 0 e 1, ex.: 0.01.');
if (!senha) parar(`Falta a senha do projeto "${projeto}": preencha SIMULADOR_SENHA no .env da raiz do repositório.`);

// ---------------------------------------------------------------------------
// boot: quantas vezes este nó simulado já ligou, guardado num arquivo,
// como o ESP32 guarda na memória não volátil.

mkdirSync(PASTA_ESTADO, { recursive: true });
const arquivoDeEstado = join(PASTA_ESTADO, `${projeto}-${no}.json`);
const estado = existsSync(arquivoDeEstado) ? JSON.parse(readFileSync(arquivoDeEstado, 'utf8')) : { boot: 0 };
estado.boot += 1;
writeFileSync(arquivoDeEstado, JSON.stringify(estado));
const boot = estado.boot;

// ---------------------------------------------------------------------------
// Conexão com o broker

const raiz = `cria/${projeto}/${no}`;
const topicoDeStatus = `${raiz}/status`;

const cliente = mqtt.connect(`mqtt://${host}:${porta}`, {
  clientId: `simulador-${projeto}-${no}`,
  username: projeto,
  password: senha,
  keepalive: 5, // o mesmo da CriaTelemetria, a biblioteca dos ESP32
  reconnectPeriod: 2000,
  queueQoSZero: false, // quem guarda as leituras durante a queda é a nossa fila
  will: { topic: topicoDeStatus, payload: 'offline', qos: 1, retain: true },
});

let seq = 0;
let fila = [];
let descartadasPelaFilaCheia = 0;
let encerrando = false;
let avisouQueda = false; // para avisar a queda uma vez, e não a cada tentativa

cliente.on('connect', () => {
  avisouQueda = false;
  console.log(`${hora()}  conectado a ${host}:${porta} como "${projeto}" (boot ${boot})`);
  cliente.publish(topicoDeStatus, 'online', { qos: 1, retain: true });

  if (fila.length > 0) {
    const pendentes = fila;
    fila = [];
    for (const { topico, leitura } of pendentes) {
      cliente.publish(topico, JSON.stringify({ ...leitura, fila: 1 }), { qos: 0 });
    }
    console.log(`${hora()}  ${pendentes.length} leituras da fila reenviadas`);
  }
});

cliente.on('close', () => {
  if (encerrando || avisouQueda) return;
  avisouQueda = true;
  console.log(`${hora()}  sem conexão com o broker; as leituras vão para a fila até ele voltar`);
});

cliente.on('error', (erro) => {
  // 4 e 5 são as recusas do broker por usuário ou senha.
  if (erro.code === 4 || erro.code === 5) {
    parar(`O broker recusou o usuário "${projeto}": confira a SIMULADOR_SENHA e se o usuário existe.`);
  }
  if (!avisouQueda) console.error(`${hora()}  erro: ${descreverErro(erro)}`);
});

// Algumas falhas de rede chegam sem mensagem, com as causas dentro de "errors".
function descreverErro(erro) {
  const causas = (erro.errors ?? []).map((e) => e.message).join('; ');
  return erro.message || causas || erro.code || 'desconhecido';
}

// ---------------------------------------------------------------------------
// Leituras

function medir() {
  const agora = new Date();
  let publicadas = 0;
  let enfileiradas = 0;
  let perdidas = 0;
  const primeiroSeq = seq + 1;

  for (const sensor of PERFIS[nomePerfil]) {
    // O seq é dado na leitura, antes de saber se ela vai sair.
    seq += 1;
    const topico = `${raiz}/${sensor.grandeza}`;
    const leitura = {
      valor: arredondar(sensor.gerar(agora), sensor.casas),
      unidade: sensor.unidade,
      seq,
      boot,
      t: agora.getTime(),
    };

    if (Math.random() < perda) {
      perdidas += 1;
    } else if (cliente.connected) {
      cliente.publish(topico, JSON.stringify(leitura), { qos: 0 });
      publicadas += 1;
    } else {
      if (fila.length >= TAMANHO_MAXIMO_DA_FILA) {
        fila.shift();
        descartadasPelaFilaCheia += 1;
      }
      fila.push({ topico, leitura });
      enfileiradas += 1;
    }
  }

  const partes = [`seq ${primeiroSeq}-${seq}`];
  if (publicadas) partes.push(`${publicadas} publicadas`);
  if (enfileiradas) partes.push(`${enfileiradas} na fila (total ${fila.length})`);
  if (perdidas) partes.push(`${perdidas} descartadas de propósito`);
  if (descartadasPelaFilaCheia) partes.push(`${descartadasPelaFilaCheia} perdidas por fila cheia`);
  console.log(`${hora()}  ${partes.join(', ')}`);
}

function hora() {
  return new Date().toLocaleTimeString('pt-BR');
}

console.log(
  `Nó simulado ${raiz}, perfil "${nomePerfil}", uma leitura por grandeza a cada ${intervaloEmSegundos} s` +
    (perda > 0 ? `, descartando ${(perda * 100).toFixed(1)}% de propósito` : '') +
    '. Ctrl+C encerra.',
);
const relogio = setInterval(medir, intervaloEmSegundos * 1000);

// Ctrl+C: avisa "offline" antes de sair. Se o processo morrer sem passar por
// aqui, quem publica o "offline" é o broker, pelo LWT.
process.once('SIGINT', () => {
  encerrando = true;
  clearInterval(relogio);
  if (fila.length > 0) {
    console.log(`${hora()}  ${fila.length} leituras da fila perdidas ao encerrar`);
  }
  // Se o broker não responder em 3 s, sai assim mesmo.
  setTimeout(() => process.exit(0), 3000).unref();
  const sair = () => cliente.end(false, () => process.exit(0));
  if (cliente.connected) {
    cliente.publish(topicoDeStatus, 'offline', { qos: 1, retain: true }, sair);
  } else {
    sair();
  }
});
