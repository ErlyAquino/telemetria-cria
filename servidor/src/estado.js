// Estado de cada nó na memória do servidor: on-line ou off-line, último valor
// de cada grandeza e uma estimativa da perda de pacotes no boot atual.
// É o que o painel recebe ao abrir e o que /api/nos devolve.

export function criarEstado({ segundosAteOfflineHttp }) {
  const nos = new Map(); // chave "projeto/no"

  function obter(projeto, no) {
    const chave = `${projeto}/${no}`;
    let n = nos.get(chave);
    if (!n) {
      n = {
        projeto,
        no,
        status: 'desconhecido',
        origem: 'mqtt', // 'http' quando as leituras chegam pelo gateway das placas Arduino
        ultimaRecepcao: null,
        grandezas: {},
        contagem: null, // { boot, recebidas, menorSeq, maiorSeq }
        alterado: false, // a contagem mudou desde o último envio ao painel
        ultimaImagem: null, // { caminho, t }, nos nós com câmera
      };
      nos.set(chave, n);
    }
    return n;
  }

  function existe(projeto, no) {
    return nos.has(`${projeto}/${no}`);
  }

  // Devolve true se o status do nó mudou.
  function registrarLeitura(l) {
    const n = obter(l.projeto, l.no);
    const atual = n.grandezas[l.grandeza];
    // Uma leitura da fila pode ser mais antiga que a última exibida.
    if (!atual || l.t >= atual.t) {
      n.grandezas[l.grandeza] = { valor: l.valor, unidade: l.unidade, t: l.t };
    }
    contar(n, l);

    if (l.fila) return false;
    n.ultimaRecepcao = Date.now();
    if (n.status !== 'online') {
      n.status = 'online';
      return true;
    }
    return false;
  }

  // Estimativa da perda no boot atual: leituras recebidas contra o intervalo de
  // seq visto desde que o servidor ligou. A conta oficial do critério 1 é feita
  // depois, no banco, pelos scripts de validação.
  function contar(n, l) {
    const c = n.contagem;
    if (!c || l.boot > c.boot) {
      n.contagem = { boot: l.boot, recebidas: 1, menorSeq: l.seq, maiorSeq: l.seq };
    } else if (l.boot === c.boot) {
      c.recebidas += 1;
      c.menorSeq = Math.min(c.menorSeq, l.seq);
      c.maiorSeq = Math.max(c.maiorSeq, l.seq);
    }
    n.alterado = true;
  }

  // Devolve true se o status mudou.
  function registrarStatus(projeto, no, status) {
    const n = obter(projeto, no);
    if (n.status === status) return false;
    n.status = status;
    return true;
  }

  function marcarOrigemHttp(projeto, no) {
    obter(projeto, no).origem = 'http';
  }

  // Imagem nova da câmera (ou a última encontrada no disco, ao ligar). Não mexe
  // no status: o nó da câmera tem o próprio LWT pelo MQTT.
  function registrarImagem(projeto, no, { caminho, t }) {
    const n = obter(projeto, no);
    if (!n.ultimaImagem || t >= n.ultimaImagem.t) n.ultimaImagem = { caminho, t };
  }

  // Valores lidos do banco ao ligar o servidor; não mexem no status e não
  // apagam um valor mais novo que já tenha chegado.
  function carregarUltimas(ultimas) {
    for (const u of ultimas) {
      const n = obter(u.projeto, u.no);
      const atual = n.grandezas[u.grandeza];
      if (!atual || u.t > atual.t) n.grandezas[u.grandeza] = { valor: u.valor, unidade: u.unidade, t: u.t };
    }
  }

  // As placas Arduino não têm LWT: o nó delas que se calar fica off-line.
  // Devolve os nós que mudaram.
  function verificarSilencio(agora = Date.now()) {
    const mudaram = [];
    for (const n of nos.values()) {
      const calado = n.ultimaRecepcao === null || agora - n.ultimaRecepcao > segundosAteOfflineHttp * 1000;
      if (n.origem === 'http' && n.status === 'online' && calado) {
        n.status = 'offline';
        mudaram.push(n);
      }
    }
    return mudaram;
  }

  // Nós cuja contagem mudou desde a última chamada, para o painel atualizar a perda.
  function retirarAlterados() {
    const alterados = [...nos.values()].filter((n) => n.alterado);
    for (const n of alterados) n.alterado = false;
    return alterados;
  }

  function resumir(n) {
    const c = n.contagem;
    const esperadas = c ? c.maiorSeq - c.menorSeq + 1 : 0;
    return {
      projeto: n.projeto,
      no: n.no,
      status: n.status,
      origem: n.origem,
      ultimaRecepcao: n.ultimaRecepcao,
      grandezas: n.grandezas,
      perda: c ? { boot: c.boot, recebidas: c.recebidas, esperadas } : null,
      ultimaImagem: n.ultimaImagem,
    };
  }

  // Ordem natural: no2 antes de no10.
  const ordem = (a, b) => `${a.projeto}/${a.no}`.localeCompare(`${b.projeto}/${b.no}`, 'pt-BR', { numeric: true });

  return {
    existe,
    registrarLeitura,
    registrarStatus,
    marcarOrigemHttp,
    registrarImagem,
    carregarUltimas,
    verificarSilencio,
    retirarAlterados,
    resumoDoNo: (projeto, no) => resumir(obter(projeto, no)),
    resumoDe: resumir,
    resumo: () => [...nos.values()].map(resumir).sort(ordem),
  };
}
