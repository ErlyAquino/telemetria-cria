// Rota HTTP das placas Arduino: publica as leituras no broker com o usuário e a
// senha do próprio projeto.
//
// O servidor não guarda senha de projeto nenhum. Quem confere a senha é o
// broker, ao aceitar ou recusar a conexão, e quem limita o projeto é a ACL,
// exatamente como para um ESP32. As leituras publicadas voltam ao servidor pela
// assinatura de cria/#, pelo mesmo caminho das demais.

import { createHash, randomBytes } from 'node:crypto';
import mqtt from 'mqtt';

// Conexão sem uso por este tempo é fechada.
const MINUTOS_SEM_USO_ATE_FECHAR = 5;
// Toda conexão é refeita depois deste tempo, para uma senha trocada no broker
// deixar de valer aqui também.
const MINUTOS_DE_VIDA = 60;
// Prazo para o broker confirmar as publicações de um pedido.
const SEGUNDOS_PARA_PUBLICAR = 10;

export function criarPublicadorHttp({ host, porta }) {
  // chave: projeto + resumo da senha  ->  { conexao: Promise<cliente>, criadaEm, ultimoUso }
  const conexoes = new Map();

  function chaveDe(projeto, senha) {
    return `${projeto}:${createHash('sha256').update(senha).digest('hex')}`;
  }

  async function conectar(projeto, senha) {
    const cliente = await mqtt.connectAsync(`mqtt://${host}:${porta}`, {
      clientId: `http-${projeto}-${randomBytes(4).toString('hex')}`,
      username: projeto,
      password: senha,
      clean: true,
      reconnectPeriod: 0, // senha errada não deve ficar tentando
      connectTimeout: 5000,
    });
    cliente.on('error', () => {}); // a queda é tratada em obterConexao
    return cliente;
  }

  // Tira a entrada do mapa só se ela ainda for a mesma: outro pedido pode já
  // ter posto uma conexão nova no lugar.
  function remover(chave, entrada) {
    if (conexoes.get(chave) === entrada) conexoes.delete(chave);
  }

  async function obterConexao(projeto, senha) {
    const chave = chaveDe(projeto, senha);
    const existente = conexoes.get(chave);
    if (existente) {
      const cliente = await existente.conexao.catch(() => null);
      const nova = Date.now() - existente.criadaEm < MINUTOS_DE_VIDA * 60 * 1000;
      if (cliente?.connected && nova) {
        existente.ultimoUso = Date.now();
        return cliente;
      }
      remover(chave, existente);
      cliente?.end();
    }
    const entrada = { conexao: conectar(projeto, senha), criadaEm: Date.now(), ultimoUso: Date.now() };
    conexoes.set(chave, entrada);
    try {
      return await entrada.conexao;
    } catch (erro) {
      remover(chave, entrada);
      throw erro;
    }
  }

  // Publica as leituras já conferidas. Devolve quando o broker confirmou todas.
  // Lança um erro com codigo 'recusado' se o broker não aceitar usuário e senha,
  // ou 'indisponivel' se o broker estiver fora ou não confirmar a tempo.
  async function publicar(projeto, senha, leituras) {
    let cliente;
    try {
      cliente = await obterConexao(projeto, senha);
    } catch (erro) {
      if (erro.code === 4 || erro.code === 5) throw Object.assign(new Error('usuário ou senha recusados'), { codigo: 'recusado' });
      throw Object.assign(new Error(`broker indisponível: ${erro.message || erro.code}`), { codigo: 'indisponivel' });
    }
    const publicacoes = Promise.all(
      leituras.map(({ no, grandeza, valor, unidade, seq, boot, t, fila }) => {
        const mensagem = { valor, unidade, seq, boot, t, ...(fila ? { fila: 1 } : {}) };
        return cliente.publishAsync(`cria/${projeto}/${no}/${grandeza}`, JSON.stringify(mensagem), { qos: 1 });
      }),
    );
    // Se a conexão cair no meio, a biblioteca não avisa: o prazo garante a resposta.
    let prazo;
    const estourou = new Promise((_, rejeitar) => {
      prazo = setTimeout(
        () => rejeitar(Object.assign(new Error('o broker não confirmou as leituras a tempo'), { codigo: 'indisponivel' })),
        SEGUNDOS_PARA_PUBLICAR * 1000,
      );
    });
    try {
      await Promise.race([publicacoes, estourou]);
    } catch (erro) {
      cliente.end(true);
      throw erro.codigo ? erro : Object.assign(erro, { codigo: 'indisponivel' });
    } finally {
      clearTimeout(prazo);
    }
  }

  const faxina = setInterval(async () => {
    const agora = Date.now();
    for (const [chave, entrada] of conexoes) {
      const semUso = agora - entrada.ultimoUso > MINUTOS_SEM_USO_ATE_FECHAR * 60 * 1000;
      const velha = agora - entrada.criadaEm > MINUTOS_DE_VIDA * 60 * 1000;
      if (semUso || velha) {
        remover(chave, entrada);
        const cliente = await entrada.conexao.catch(() => null);
        cliente?.end();
      }
    }
  }, 60 * 1000);
  faxina.unref();

  async function fechar() {
    clearInterval(faxina);
    for (const entrada of conexoes.values()) {
      const cliente = await entrada.conexao.catch(() => null);
      cliente?.end();
    }
    conexoes.clear();
  }

  return { publicar, fechar };
}
