// Gravação e consulta no InfluxDB 2.
//
// Cada leitura vira um ponto da medida "leitura":
//   etiquetas (tags): projeto, no, grandeza, unidade
//   campos (fields):  valor (decimal), seq e boot (inteiros), fila (só quando veio da fila)
//   hora:             o t da leitura, isto é, a hora em que o nó mediu
// A latência medida pelo painel vai para a medida "latencia_painel", campo ms.

import {
  InfluxDB,
  Point,
  canRetryHttpCall,
  flux,
  fluxDateTime,
  fluxDuration,
  fluxExpression,
  setLogger,
} from '@influxdata/influxdb-client';

// Limite de pontos devolvidos ao gráfico do painel, para não pesar no celular.
const PONTOS_MAXIMOS_NO_GRAFICO = 720;
// Tempo máximo tentando gravar um lote com o InfluxDB fora do ar.
const HORAS_TENTANDO_GRAVAR = 2;
const MAXIMO_DE_TENTATIVAS = 500;

// As mensagens internas da biblioteca, com o prefixo do banco. As falhas de
// gravação já são avisadas em português pelo writeFailed, abaixo.
setLogger({
  error: (mensagem, erro) => console.error(`InfluxDB: ${mensagem}${erro ? ` (${erro.message ?? erro})` : ''}`),
  warn: (mensagem, erro) => {
    if (mensagem.startsWith('Write to InfluxDB failed')) return;
    console.warn(`InfluxDB: ${mensagem}${erro ? ` (${erro.message ?? erro})` : ''}`);
  },
});

export function criarBanco({ url, org, bucket, token }) {
  const influx = new InfluxDB({ url, token, timeout: 10000 });
  // A exportação de muitos dias pode demorar a começar: cliente com prazo maior.
  const influxExportacao = new InfluxDB({ url, token, timeout: 5 * 60 * 1000 });

  const contagem = {
    linhasGravadas: 0, // leituras e medidas de latência
    linhasDescartadas: 0, // perdidas depois de esgotar as tentativas, ou recusadas pelo banco
    tentativasComFalha: 0,
    ultimaFalha: null,
    ultimoSucesso: null,
  };

  // A gravação é feita em lotes: no máximo 250 ms de espera ou 100 pontos.
  // O lote fica na memória até ser enviado: se o processo morrer de repente
  // (falta de energia sem no-break, por exemplo), perde-se o que estava nele.
  // Numa parada normal, fechar() envia o lote antes de sair.
  // Com o InfluxDB fora do ar, o cliente guarda até 50000 linhas e tenta de novo
  // por até HORAS_TENTANDO_GRAVAR horas, com no máximo 30 s entre tentativas.
  const escrita = influx.getWriteApi(org, bucket, 'ms', {
    batchSize: 100,
    flushInterval: 250,
    maxRetries: MAXIMO_DE_TENTATIVAS,
    maxRetryTime: HORAS_TENTANDO_GRAVAR * 3600 * 1000,
    maxRetryDelay: 30000,
    maxBufferLines: 50000,
    writeSuccess(linhas) {
      contagem.linhasGravadas += linhas.length;
      contagem.ultimoSucesso = Date.now();
    },
    writeFailed(erro, linhas, tentativa, expira) {
      contagem.tentativasComFalha += 1;
      contagem.ultimaFalha = { quando: Date.now(), erro: erro.message };
      const vaiTentarDeNovo = canRetryHttpCall(erro) && tentativa <= MAXIMO_DE_TENTATIVAS && Date.now() < expira;
      if (vaiTentarDeNovo) {
        console.error(`InfluxDB: falha ao gravar ${linhas.length} linhas (${erro.message}); nova tentativa automática.`);
      } else {
        contagem.linhasDescartadas += linhas.length;
        console.error(`InfluxDB: ${linhas.length} linhas DESCARTADAS (${erro.message}).`);
      }
    },
    writeRetrySkipped({ lines: linhas }) {
      contagem.linhasDescartadas += linhas.length;
      console.error(`InfluxDB: ${linhas.length} linhas DESCARTADAS: o buffer de espera encheu.`);
    },
  });
  const consulta = influx.getQueryApi(org);
  const consultaExportacao = influxExportacao.getQueryApi(org);

  function gravarLeitura(l) {
    const ponto = new Point('leitura')
      .tag('projeto', l.projeto)
      .tag('no', l.no)
      .tag('grandeza', l.grandeza)
      .tag('unidade', l.unidade)
      .floatField('valor', l.valor)
      .intField('seq', l.seq)
      .intField('boot', l.boot)
      .timestamp(new Date(l.t));
    if (l.fila) ponto.booleanField('fila', true);
    escrita.writePoint(ponto);
  }

  function gravarLatencia({ projeto, no, grandeza, ms }) {
    escrita.writePoint(
      new Point('latencia_painel').tag('projeto', projeto).tag('no', no).tag('grandeza', grandeza).intField('ms', ms),
    );
  }

  // A gravação está em dia? Falso se a última falha é mais nova que o último sucesso.
  function gravacaoEmDia() {
    const falha = contagem.ultimaFalha?.quando ?? 0;
    return falha === 0 || (contagem.ultimoSucesso ?? 0) > falha;
  }

  // Pontos de uma grandeza nos últimos "minutos", para o gráfico do painel.
  // Períodos longos são resumidos em médias, até PONTOS_MAXIMOS_NO_GRAFICO.
  async function consultarSerie({ projeto, no, grandeza, minutos }) {
    const inicio = fluxDateTime(new Date(Date.now() - minutos * 60 * 1000).toISOString());
    // A 10 s por leitura, cabem PONTOS_MAXIMOS_NO_GRAFICO em 2 h; acima disso, resume em médias.
    const resumir = minutos * 6 > PONTOS_MAXIMOS_NO_GRAFICO;
    const janela = fluxDuration(`${Math.ceil((minutos * 60) / PONTOS_MAXIMOS_NO_GRAFICO)}s`);
    const consultaFlux = resumir
      ? flux`
      from(bucket: ${bucket})
        |> range(start: ${inicio})
        |> filter(fn: (r) => r._measurement == "leitura" and r._field == "valor")
        |> filter(fn: (r) => r.projeto == ${projeto} and r.no == ${no} and r.grandeza == ${grandeza})
        |> aggregateWindow(every: ${janela}, fn: mean, createEmpty: false)
        |> keep(columns: ["_time", "_value"])`
      : flux`
      from(bucket: ${bucket})
        |> range(start: ${inicio})
        |> filter(fn: (r) => r._measurement == "leitura" and r._field == "valor")
        |> filter(fn: (r) => r.projeto == ${projeto} and r.no == ${no} and r.grandeza == ${grandeza})
        |> keep(columns: ["_time", "_value"])`;
    const pontos = [];
    for await (const { values, tableMeta } of consulta.iterateRows(consultaFlux)) {
      const linha = tableMeta.toObject(values);
      pontos.push({ t: Date.parse(linha._time), valor: linha._value });
    }
    // Se a unidade de uma grandeza mudou, o banco devolve uma tabela por unidade.
    return pontos.sort((a, b) => a.t - b.t);
  }

  // Todas as leituras do período, com os filtros opcionais, para o CSV.
  // É um gerador: as linhas saem conforme chegam do banco, sem montar tudo na
  // memória, nem no servidor nem no InfluxDB. Por isso vêm agrupadas por série
  // (projeto, nó, grandeza) e, dentro de cada série, em ordem de hora.
  async function* consultarParaExportar({ projeto = '', no = '', grandeza = '', inicio, fim }) {
    // Só as condições pedidas entram no filtro, para o banco usar os índices.
    const condicoes = [flux`r._measurement == "leitura"`];
    if (projeto) condicoes.push(flux`r.projeto == ${projeto}`);
    if (no) condicoes.push(flux`r.no == ${no}`);
    if (grandeza) condicoes.push(flux`r.grandeza == ${grandeza}`);
    const consultaFlux = flux`
      from(bucket: ${bucket})
        |> range(start: ${fluxDateTime(inicio.toISOString())}, stop: ${fluxDateTime(fim.toISOString())})
        |> filter(fn: (r) => ${fluxExpression(condicoes.join(' and '))})
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;
    for await (const { values, tableMeta } of consultaExportacao.iterateRows(consultaFlux)) {
      const r = tableMeta.toObject(values);
      yield {
        t: Date.parse(r._time),
        projeto: r.projeto,
        no: r.no,
        grandeza: r.grandeza,
        valor: r.valor,
        unidade: r.unidade,
        seq: r.seq,
        boot: r.boot,
      };
    }
  }

  // Último valor de cada grandeza nos últimos 7 dias, para o painel não
  // começar vazio depois de um reinício do servidor.
  async function consultarUltimasLeituras() {
    const consultaFlux = flux`
      from(bucket: ${bucket})
        |> range(start: -7d)
        |> filter(fn: (r) => r._measurement == "leitura" and r._field == "valor")
        |> last()`;
    const ultimas = [];
    for await (const { values, tableMeta } of consulta.iterateRows(consultaFlux)) {
      const r = tableMeta.toObject(values);
      ultimas.push({
        projeto: r.projeto,
        no: r.no,
        grandeza: r.grandeza,
        unidade: r.unidade,
        valor: r._value,
        t: Date.parse(r._time),
      });
    }
    return ultimas;
  }

  // O InfluxDB responde em /health? Usado pelo /saude do servidor.
  async function estaRespondendo() {
    try {
      const resposta = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return resposta.ok;
    } catch {
      return false;
    }
  }

  return {
    contagem,
    gravacaoEmDia,
    gravarLeitura,
    gravarLatencia,
    consultarSerie,
    consultarParaExportar,
    consultarUltimasLeituras,
    estaRespondendo,
    fechar: () => escrita.close(),
  };
}
