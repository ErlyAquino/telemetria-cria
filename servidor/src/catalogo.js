// As regras do catálogo de tópicos (mqtt/catalogo-topicos.md), em código.
//
// Tudo aqui é função pura: recebe texto e devolve um objeto, sem rede nem banco.
// Por isso é a parte do servidor coberta pelos testes em test/catalogo.test.js.

// Projeto e grandeza: começa com letra ou algarismo; depois letras, algarismos
// e hífen; até 32 caracteres. Começar com hífen faria a planilha ler uma fórmula.
export const NOME_VALIDO = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const NO_VALIDO = /^no[1-9][0-9]{0,3}$/;
export const GRANDEZAS_RESERVADAS = new Set(['status', 'cmd']);
// "servidor" é o usuário do servidor no broker, não um projeto (seção 6).
export const PROJETOS_RESERVADOS = new Set(['servidor']);
// Unidade: começa com letra ou %, sem sinais que a planilha leia como fórmula.
const UNIDADE_VALIDA = /^[A-Za-z%][A-Za-z0-9%/._-]{0,19}$/;
// seq e boot cabem num inteiro de 32 bits, como no ESP32.
const MAIOR_CONTADOR = 2 ** 31 - 1;

// Antes disso, o relógio do nó certamente não foi acertado (01/01/2020).
const MENOR_T_ACEITO = 1577836800000;
// Uma leitura pode vir do futuro por diferença pequena de relógio, não mais.
const ADIANTAMENTO_MAXIMO_MS = 60 * 1000;

// Desmonta cria/{projeto}/{no}/{grandeza}. Devolve null se o tópico não
// seguir o catálogo.
export function lerTopico(topico) {
  const partes = topico.split('/');
  if (partes.length !== 4 || partes[0] !== 'cria') return null;
  const [, projeto, no, grandeza] = partes;
  if (!NOME_VALIDO.test(projeto) || PROJETOS_RESERVADOS.has(projeto)) return null;
  if (!NO_VALIDO.test(no) || !NOME_VALIDO.test(grandeza)) return null;
  return { projeto, no, grandeza };
}

function contadorValido(n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAIOR_CONTADOR;
}

// Confere os campos de uma leitura (seção 2 do catálogo).
// Devolve { leitura } com os campos normalizados, ou { erro } com o motivo.
export function lerCamposDaLeitura(dados, agora = Date.now()) {
  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
    return { erro: 'a mensagem não é um objeto JSON' };
  }
  const { valor, unidade, seq, boot, t, fila } = dados;

  if (typeof valor !== 'number' || !Number.isFinite(valor)) return { erro: 'valor ausente ou não numérico' };
  if (typeof unidade !== 'string' || !UNIDADE_VALIDA.test(unidade)) {
    return { erro: 'unidade ausente ou fora da regra (letra ou % no início; só letras, algarismos e % / . _ -)' };
  }
  if (!contadorValido(seq)) return { erro: 'seq ausente ou fora de 1 a 2147483647' };
  if (!contadorValido(boot)) return { erro: 'boot ausente ou fora de 1 a 2147483647' };
  if (!Number.isSafeInteger(t)) return { erro: 't ausente ou não é inteiro' };
  if (t < MENOR_T_ACEITO) return { erro: 't anterior a 2020: o relógio do nó não foi acertado' };
  if (t > agora + ADIANTAMENTO_MAXIMO_MS) return { erro: 't no futuro: o relógio do nó está adiantado' };
  if (fila !== undefined && fila !== 0 && fila !== 1) return { erro: 'fila deve ser 0 ou 1' };

  return { leitura: { valor, unidade, seq, boot, t, fila: fila === 1 } };
}

// Interpreta uma mensagem que chegou do broker.
// Devolve um objeto com "tipo":
//   leitura  — { projeto, no, grandeza, valor, unidade, seq, boot, t, fila }
//   status   — { projeto, no, status: 'online' | 'offline' }
//   ignorada — tópico reservado (cmd) ou mensagem vazia (retain apagado)
//   invalida — fora do catálogo, com o motivo
export function interpretarMensagem(topico, texto, agora = Date.now()) {
  const endereco = lerTopico(topico);
  if (!endereco) return { tipo: 'invalida', motivo: `tópico fora do catálogo: ${topico.slice(0, 80)}` };
  const { projeto, no, grandeza } = endereco;

  // Mensagem vazia é como se apaga uma mensagem retida; não é leitura.
  if (texto === '') return { tipo: 'ignorada', motivo: 'mensagem vazia' };

  if (grandeza === 'status') {
    if (texto === 'online' || texto === 'offline') return { tipo: 'status', projeto, no, status: texto };
    return { tipo: 'invalida', motivo: `status desconhecido em ${topico}: ${texto.slice(0, 20)}` };
  }
  if (grandeza === 'cmd') return { tipo: 'ignorada', motivo: 'tópico de comandos' };

  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    return { tipo: 'invalida', motivo: `JSON inválido em ${topico}` };
  }
  const { leitura, erro } = lerCamposDaLeitura(dados, agora);
  if (erro) return { tipo: 'invalida', motivo: `${topico}: ${erro}` };
  return { tipo: 'leitura', projeto, no, grandeza, ...leitura };
}

// Confere uma leitura enviada pela rota HTTP (gateway das placas Arduino).
// Além dos campos da seção 2, ela traz o nó e a grandeza dentro do objeto.
export function lerLeituraHttp(item, agora = Date.now()) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { erro: 'item não é um objeto JSON' };
  }
  const { no, grandeza } = item;
  if (typeof no !== 'string' || !NO_VALIDO.test(no)) return { erro: 'no ausente ou fora do catálogo (no1, no2, ...)' };
  if (typeof grandeza !== 'string' || !NOME_VALIDO.test(grandeza)) return { erro: 'grandeza ausente ou fora do catálogo' };
  if (GRANDEZAS_RESERVADAS.has(grandeza)) return { erro: `"${grandeza}" é um nome reservado` };
  const { leitura, erro } = lerCamposDaLeitura(item, agora);
  if (erro) return { erro };
  return { leitura: { no, grandeza, ...leitura } };
}
