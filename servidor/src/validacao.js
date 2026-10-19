// Cálculos dos seis critérios de aceitação e montagem do relatório de validação.
//
// Tudo aqui é função pura: recebe os dados já lidos do banco e das verificações
// do /saude e devolve números e texto. Coberto pelos testes em test/validacao.test.js.
// Os números exigidos vêm do plano de trabalho (README, "Critérios de aceitação").
//
// Cada critério recebe um destes resultados:
//   atende / não atende  os dados bastam e o número está dentro ou fora do limite
//   verificar            há números, mas algo nos dados pede o olho de uma pessoa
//                        (nó calado no meio do teste, seq que recomeçou...)
//   pendente             faltam dados para decidir

export const LIMITES = {
  perda: 0.01, // menos de 1% em 24 h
  latenciaMs: 2000, // menos de 2 s, avaliada no percentil 95
  percentilDaLatencia: 0.95,
  ph: 0.2, // ±0,2 unidade de pH
  condutividade: 0.05, // ±5%
  disponibilidade: 0.95, // pelo menos 95%
  reusoMinutos: 30, // sensor novo publicando em até 30 min
};

// Latência: para o resultado valer, o painel com ?medir=1 precisa ter medido
// pelo menos esta fração das leituras ao vivo, e em todas as horas do período.
const COBERTURA_MINIMA_DA_LATENCIA = 0.9;
// Perda: um nó que começa tarde, termina cedo ou passa mais que isto sem
// nenhuma leitura recebe um aviso.
const TOLERANCIA_SEM_LEITURA_MS = 5 * 60 * 1000;
// Recuo do seq, em leituras, que indica que a contagem recomeçou.
const RECUO_QUE_INDICA_RECOMECO = 50;
const HORA_MS = 3600 * 1000;
const HORAS_DO_TESTE = 24;

// Percentil pelo posto mais próximo: o menor valor que deixa pelo menos a
// fração p das medidas abaixo dele ou igual a ele.
export function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  const posicao = Math.ceil(p * ordenados.length) - 1;
  return ordenados[Math.min(ordenados.length - 1, Math.max(0, posicao))];
}

// ---------------------------------------------------------------------------
// Critério 1: perda de pacotes, pelo seq de cada nó em cada boot

// Agrupa números consecutivos em faixas: [3,4,5,9] -> [[3,5],[9,9]].
export function agruparEmFaixas(numeros) {
  const faixas = [];
  for (const n of numeros) {
    const ultima = faixas[faixas.length - 1];
    if (ultima && n === ultima[1] + 1) ultima[1] = n;
    else faixas.push([n, n]);
  }
  return faixas;
}

export function criarContadorDePerda() {
  const nos = new Map(); // "projeto/no" -> Map(boot -> [[t, seq], ...])

  return {
    adicionar({ projeto, no, boot, seq, t }) {
      const chave = `${projeto}/${no}`;
      if (!nos.has(chave)) nos.set(chave, new Map());
      const boots = nos.get(chave);
      if (!boots.has(boot)) boots.set(boot, []);
      boots.get(boot).push([t, seq]);
    },

    // Em cada boot, as leituras esperadas vão do menor ao maior seq. No primeiro
    // boot de cada nó no período, o menor é o primeiro que chegou (o boot pode ter
    // começado antes do período). Nos boots seguintes, que começaram dentro do
    // período, o menor é 1: leituras perdidas no início do boot também contam.
    resultado({ inicio, fim }) {
      const porNo = [];
      const avisos = [];
      const total = { recebidas: 0, esperadas: 0, perdidas: 0 };
      const ordemNatural = ([a], [b]) => a.localeCompare(b, 'pt-BR', { numeric: true });

      for (const [chave, boots] of [...nos].sort(ordemNatural)) {
        const resumoDosBoots = [];
        const todosOsT = [];
        const ordemDosBoots = [...boots].sort(([a], [b]) => a - b);
        ordemDosBoots.forEach(([boot, leituras], indice) => {
          leituras.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          // seq que volta atrás dentro do mesmo boot: o boot não foi gravado
          // (memória não volátil com defeito) ou o gateway errou a conta. Recuos
          // pequenos vêm de acertos do relógio pelo NTP, que podem inverter a
          // ordem de leituras do mesmo ciclo; só um recuo grande é recomeço.
          let recomecos = 0;
          for (let i = 1; i < leituras.length; i++) {
            if (leituras[i][1] < leituras[i - 1][1] - RECUO_QUE_INDICA_RECOMECO) recomecos++;
          }

          const seqs = [...new Set(leituras.map(([, s]) => s))].sort((a, b) => a - b);
          const menor = indice === 0 ? seqs[0] : 1;
          const maior = seqs[seqs.length - 1];
          const esperadas = maior - menor + 1;
          const faltando = [];
          let i = 0;
          for (let s = menor; s <= maior; s++) {
            if (seqs[i] === s) i++;
            else faltando.push(s);
          }
          for (const [t] of leituras) todosOsT.push(t);
          resumoDosBoots.push({
            boot,
            menor,
            maior,
            recebidas: seqs.length,
            esperadas,
            perdidas: esperadas - seqs.length,
            lacunas: agruparEmFaixas(faltando),
            primeira: leituras[0][0],
            ultima: leituras[leituras.length - 1][0],
            recomecos,
          });
          total.recebidas += seqs.length;
          total.esperadas += esperadas;
          total.perdidas += esperadas - seqs.length;
          if (recomecos) {
            avisos.push(`${chave}, boot ${boot}: o seq voltou atrás ${recomecos} vez(es) dentro do mesmo boot; a perda desse boot pode estar subestimada.`);
          }
        });

        todosOsT.sort((a, b) => a - b);
        let maiorBuraco = 0;
        for (let k = 1; k < todosOsT.length; k++) maiorBuraco = Math.max(maiorBuraco, todosOsT[k] - todosOsT[k - 1]);
        const primeira = todosOsT[0];
        const ultima = todosOsT[todosOsT.length - 1];
        if (primeira - inicio > TOLERANCIA_SEM_LEITURA_MS) avisos.push(`${chave}: a primeira leitura chegou ${minutos(primeira - inicio)} depois do início do período.`);
        if (fim - ultima > TOLERANCIA_SEM_LEITURA_MS) avisos.push(`${chave}: a última leitura chegou ${minutos(fim - ultima)} antes do fim do período.`);
        if (maiorBuraco > TOLERANCIA_SEM_LEITURA_MS) avisos.push(`${chave}: passou ${minutos(maiorBuraco)} seguidos sem nenhuma leitura.`);

        const [projeto, no] = chave.split('/');
        porNo.push({ projeto, no, boots: resumoDosBoots, primeira, ultima, maiorBuraco });
      }
      total.fracao = total.esperadas > 0 ? total.perdidas / total.esperadas : null;
      return { porNo, total, avisos };
    },
  };
}

function minutos(ms) {
  return `${Math.round(ms / 60000)} min`;
}

// ---------------------------------------------------------------------------
// Critério 2: latência medida pelo painel com ?medir=1
//
// medidas: [{ t, ms }]. leiturasAoVivo: quantas leituras (sem fila) chegaram no
// período, para saber que fração delas o painel mediu.

export function calcularLatencia(medidas, { inicio, fim, leiturasAoVivo }) {
  const ordenadas = medidas.map((m) => m.ms).sort((a, b) => a - b);
  // Horas inteiras do período sem nenhuma medida: o painel ficou fechado ou oculto.
  const horasSemMedida = [];
  for (let h = inicio; h + HORA_MS <= fim; h += HORA_MS) {
    if (!medidas.some((m) => m.t >= h && m.t < h + HORA_MS)) horasSemMedida.push(h);
  }
  const cobertura = leiturasAoVivo > 0 ? Math.min(1, medidas.length / leiturasAoVivo) : 0;
  const base = {
    amostras: ordenadas.length,
    cobertura,
    horasSemMedida,
    suficiente: ordenadas.length > 0 && cobertura >= COBERTURA_MINIMA_DA_LATENCIA && horasSemMedida.length === 0,
  };
  if (ordenadas.length === 0) return base;
  const abaixo = ordenadas.filter((ms) => ms < LIMITES.latenciaMs).length;
  return {
    ...base,
    mediana: percentil(ordenadas, 0.5),
    p95: percentil(ordenadas, LIMITES.percentilDaLatencia),
    p99: percentil(ordenadas, 0.99),
    maxima: ordenadas[ordenadas.length - 1],
    fracaoAbaixoDoLimite: abaixo / ordenadas.length,
  };
}

// ---------------------------------------------------------------------------
// Critério 5: disponibilidade, pelas verificações periódicas do /saude
//
// O período é dividido em janelas do tamanho do intervalo do verificador. Cada
// janela vale a fração das suas verificações que deram certo; janela sem
// nenhuma verificação vale zero (o verificador parou ou a rede caiu). Assim, um
// segundo verificador rodando junto, ou um intervalo menor, não cobre as falhas.

export function calcularDisponibilidade(verificacoes, { inicio, fim, intervaloMs }) {
  const esperadas = Math.max(1, Math.floor((fim - inicio) / intervaloMs));
  const janelas = Array.from({ length: esperadas }, () => ({ ok: 0, total: 0 }));
  let verificacoesNoPeriodo = 0;
  for (const v of verificacoes) {
    const k = Math.floor((v.t - inicio) / intervaloMs);
    if (k < 0 || k >= esperadas) continue;
    verificacoesNoPeriodo++;
    janelas[k].total++;
    if (v.ok) janelas[k].ok++;
  }
  const valores = janelas.map((j) => (j.total ? j.ok / j.total : 0));
  const bemSucedidas = valores.reduce((s, v) => s + v, 0);

  // Quedas: janelas seguidas sem verificação ou com alguma falha.
  const quedas = [];
  let aberta = null;
  janelas.forEach((j, k) => {
    const motivo = j.total === 0 ? 'sem verificação (verificador parado ou sem rede)' : j.ok < j.total ? 'o /saude não respondeu 200' : null;
    const comeco = inicio + k * intervaloMs;
    if (motivo) {
      if (!aberta) aberta = { inicio: comeco, motivos: new Set() };
      aberta.motivos.add(motivo);
    } else if (aberta) {
      quedas.push({ inicio: aberta.inicio, fim: comeco, duracaoMs: comeco - aberta.inicio, motivo: [...aberta.motivos].join('; ') });
      aberta = null;
    }
  });
  if (aberta) {
    const ate = inicio + esperadas * intervaloMs;
    quedas.push({ inicio: aberta.inicio, fim: ate, duracaoMs: ate - aberta.inicio, motivo: [...aberta.motivos].join('; ') });
  }

  return { verificacoes: verificacoesNoPeriodo, esperadas, bemSucedidas, fracao: bemSucedidas / esperadas, quedas };
}

// ---------------------------------------------------------------------------
// Critérios 3, 4 e 6: medidas feitas pela equipe, em validacao/medidas-manuais.json

// Aceita número ou texto com vírgula ("6,86"); devolve NaN se não for número.
function numeroDoJson(valor) {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string' && valor.trim() !== '') return Number(valor.trim().replace(',', '.'));
  return NaN;
}

export function avaliarMedidasManuais(medidas) {
  const resultado = {};
  const { ph, condutividade, reuso } = medidas ?? {};
  if (ph) {
    const referencia = numeroDoJson(ph.referencia);
    const medido = numeroDoJson(ph.medido);
    if (Number.isFinite(referencia) && Number.isFinite(medido)) {
      const diferenca = medido - referencia;
      resultado.ph = { ...ph, referencia, medido, diferenca, atende: Math.abs(diferenca) <= LIMITES.ph + 1e-9 };
    } else {
      resultado.ph = { invalido: true };
    }
  }
  if (condutividade) {
    const referencia = numeroDoJson(condutividade.referencia);
    const medido = numeroDoJson(condutividade.medido);
    if (Number.isFinite(referencia) && referencia > 0 && Number.isFinite(medido)) {
      const diferencaRelativa = (medido - referencia) / referencia;
      resultado.condutividade = {
        ...condutividade,
        referencia,
        medido,
        diferencaRelativa,
        atende: Math.abs(diferencaRelativa) <= LIMITES.condutividade + 1e-9,
      };
    } else {
      resultado.condutividade = { invalido: true };
    }
  }
  if (reuso) {
    const minutosDoReuso = numeroDoJson(reuso.minutos);
    resultado.reuso = Number.isFinite(minutosDoReuso)
      ? { ...reuso, minutos: minutosDoReuso, atende: minutosDoReuso <= LIMITES.reusoMinutos }
      : { invalido: true };
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Relatório em Markdown

const numero = (valor, casas = 0) =>
  valor.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const porcentagem = (fracao, casas = 2) => `${numero(fracao * 100, casas)}%`;
const comSinal = (valor, casas) => `${valor >= 0 ? '+' : '−'}${numero(Math.abs(valor), casas)}`;
const segundos = (ms) => (ms >= 1000 ? `${numero(ms / 1000, 2)} s` : `${numero(ms)} ms`);
const INVALIDO = 'valor inválido em `medidas-manuais.json`';

function veredito(resultado) {
  return { atende: '**atende**', 'nao atende': '**não atende**', verificar: '**verificar**' }[resultado] ?? 'pendente';
}
const porLimite = (atende) => (atende === undefined ? 'pendente' : atende ? 'atende' : 'nao atende');

// Texto livre do JSON como frase: termina com um ponto só.
const frase = (texto) => `${String(texto).trim().replace(/\.+$/, '')}.`;

function duracao(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

function faixasEmTexto(faixas, maximo = 10) {
  const texto = faixas.slice(0, maximo).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  if (faixas.length > maximo) texto.push(`e mais ${faixas.length - maximo} faixas`);
  return texto.join(', ');
}

// dados: { inicio, fim, geradoEm, projetos, perda, latencia, leiturasAoVivo,
//          disponibilidade, intervaloDisponibilidadeMs, pastaDosDados, manuais,
//          avisos, dataHora }
// dataHora(ms) devolve a data e a hora no fuso da escola.
export function montarRelatorio(dados) {
  const { inicio, fim, perda, latencia, disponibilidade, manuais, dataHora } = dados;
  const horas = (fim - inicio) / HORA_MS;
  const linhas = [];
  const l = (texto = '') => linhas.push(texto);

  const resultadoPerda =
    perda.total.fracao === null ? 'pendente' : perda.avisos.length ? 'verificar' : porLimite(perda.total.fracao < LIMITES.perda);
  const resultadoLatencia = !latencia.amostras || !latencia.suficiente ? 'pendente' : porLimite(latencia.p95 < LIMITES.latenciaMs);
  const resultadoDisponibilidade = disponibilidade ? porLimite(disponibilidade.fracao >= LIMITES.disponibilidade) : 'pendente';
  const manual = (m) => (!m || m.invalido ? 'pendente' : porLimite(m.atende));

  l('# Relatório de validação');
  l();
  l(`Período: de ${dataHora(inicio)} a ${dataHora(fim)} (${numero(horas, 1)} h). ` +
    `Projetos: ${dados.projetos.join(', ')}. ` +
    `Gerado em ${dataHora(dados.geradoEm)} por \`npm run relatorio\`, na pasta \`servidor/\`.`);
  l();
  if (horas < HORAS_DO_TESTE - 0.01) {
    l(`> **Resultado preliminar:** o período tem menos de ${HORAS_DO_TESTE} h. O teste de aceitação exige ${HORAS_DO_TESTE} h de operação contínua.`);
    l();
  }

  l('## Resumo');
  l();
  l('| Critério | Exigido | Medido | Resultado |');
  l('| --- | --- | --- | --- |');
  l(`| 1. Perda de pacotes | menos de 1% | ${perda.total.fracao === null ? 'sem leituras' : `${porcentagem(perda.total.fracao)} (${numero(perda.total.perdidas)} de ${numero(perda.total.esperadas)})${perda.avisos.length ? '; veja os avisos' : ''}`} | ${veredito(resultadoPerda)} |`);
  l(`| 2. Latência | menos de 2 s no percentil 95 | ${latencia.amostras ? `p95 ${segundos(latencia.p95)}; mediana ${segundos(latencia.mediana)}; máxima ${segundos(latencia.maxima)}${latencia.suficiente ? '' : '; medidas insuficientes'}` : 'sem medidas do painel'} | ${veredito(resultadoLatencia)} |`);
  l(`| 3. Exatidão do pH | ±0,2 | ${!manuais.ph ? 'não informado' : manuais.ph.invalido ? INVALIDO : `${comSinal(manuais.ph.diferenca, 2)} (${numero(manuais.ph.medido, 2)} contra ${numero(manuais.ph.referencia, 2)})`} | ${veredito(manual(manuais.ph))} |`);
  l(`| 4. Exatidão da condutividade | ±5% | ${!manuais.condutividade ? 'não informado' : manuais.condutividade.invalido ? INVALIDO : `${comSinal(manuais.condutividade.diferencaRelativa * 100, 2)}% (${numero(manuais.condutividade.medido)} contra ${numero(manuais.condutividade.referencia)} µS/cm)`} | ${veredito(manual(manuais.condutividade))} |`);
  l(`| 5. Disponibilidade do servidor | pelo menos 95% | ${disponibilidade ? `${porcentagem(disponibilidade.fracao)} (${numero(disponibilidade.esperadas)} janelas de ${numero(dados.intervaloDisponibilidadeMs / 1000)} s)` : 'sem verificações'} | ${veredito(resultadoDisponibilidade)} |`);
  l(`| 6. Reuso | até 30 min | ${!manuais.reuso ? 'não informado' : manuais.reuso.invalido ? INVALIDO : `${numero(manuais.reuso.minutos)} min`} | ${veredito(manual(manuais.reuso))} |`);
  l();
  l('"Verificar" quer dizer que há números, mas algo nos dados pede a análise de uma pessoa (veja os avisos). "Pendente" quer dizer que faltam dados para decidir.');
  l();

  const avisos = [...perda.avisos, ...(dados.avisos ?? [])];
  if (avisos.length) {
    l('## Avisos');
    l();
    for (const aviso of avisos) l(`- ${aviso}`);
    l();
  }

  l('## 1. Perda de pacotes');
  l();
  l('Em cada boot de cada nó, as leituras esperadas são todas as de `seq` do menor ao maior. No primeiro boot de um nó, o menor é o primeiro `seq` que chegou, porque o boot pode ter começado antes do período; nos boots seguintes, que começaram dentro do período, o menor é 1. As que faltam foram perdidas.');
  l();
  if (perda.porNo.length === 0) {
    l('Nenhuma leitura no período.');
  } else {
    l('| Nó | Boot | seq | Primeira e última leitura | Recebidas | Esperadas | Perdidas | Perda | Lacunas no seq |');
    l('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const n of perda.porNo) {
      for (const b of n.boots) {
        l(`| ${n.projeto}/${n.no} | ${b.boot} | ${b.menor} a ${b.maior} | ${dataHora(b.primeira)} a ${dataHora(b.ultima)} | ${numero(b.recebidas)} | ${numero(b.esperadas)} | ${numero(b.perdidas)} | ${porcentagem(b.perdidas / b.esperadas)} | ${b.lacunas.length ? faixasEmTexto(b.lacunas) : '—'} |`);
      }
    }
    l();
    l('As leituras perdidas no fim de um boot, logo antes de um reinício, não deixam lacuna e não entram na conta.');
  }
  l();

  l('## 2. Latência');
  l();
  l('Medida pelo painel aberto com `?medir=1`: a hora em que o servidor recebe o aviso de que o ponto foi desenhado, menos o `t` da leitura. Leituras que esperaram na fila do nó ficam de fora. Atrasos acima de 60 s entram como 60 s.');
  l();
  if (latencia.amostras) {
    l(`- Amostras: ${numero(latencia.amostras)}, de ${numero(dados.leiturasAoVivo)} leituras ao vivo no período (${porcentagem(latencia.cobertura, 1)} medidas).`);
    l(`- Mediana: ${segundos(latencia.mediana)}; percentil 95: ${segundos(latencia.p95)}; percentil 99: ${segundos(latencia.p99)}; máxima: ${segundos(latencia.maxima)}.`);
    l(`- Abaixo de 2 s: ${porcentagem(latencia.fracaoAbaixoDoLimite, 1)} das medidas.`);
    if (!latencia.suficiente) {
      l(`- **Medidas insuficientes para decidir:** o painel precisa medir pelo menos ${porcentagem(COBERTURA_MINIMA_DA_LATENCIA, 0)} das leituras ao vivo, em todas as horas do período.` +
        (latencia.horasSemMedida.length ? ` Horas sem nenhuma medida: ${latencia.horasSemMedida.map((h) => dataHora(h)).join('; ')}.` : ''));
    }
  } else {
    l('Nenhuma medida: o painel com `?medir=1` não ficou aberto e à vista durante o período.');
  }
  l();

  l('## 3 e 4. Exatidão do pH e da condutividade');
  l();
  for (const [chave, nome, unidade, casas] of [['ph', 'pH', '', 2], ['condutividade', 'Condutividade', ' µS/cm', 0]]) {
    const m = manuais[chave];
    if (!m) {
      l(`- ${nome}: não informado em \`validacao/medidas-manuais.json\`.`);
      continue;
    }
    if (m.invalido) {
      l(`- ${nome}: referência ou valor medido inválido em \`validacao/medidas-manuais.json\`. Escreva os números com ponto, sem aspas.`);
      continue;
    }
    l(`- ${nome}: referência ${numero(m.referencia, casas)}${unidade}, medido ${numero(m.medido, casas)}${unidade}` +
      (m.quando ? `, em ${m.quando}` : '') + '.' +
      (m.solucao ? ` Solução: ${frase(m.solucao)}` : '') +
      (m.observacoes ? ` Observações: ${frase(m.observacoes)}` : ''));
  }
  l();

  l('## 5. Disponibilidade do servidor');
  l();
  if (disponibilidade) {
    l(`O período foi dividido em ${numero(disponibilidade.esperadas)} janelas de ${numero(dados.intervaloDisponibilidadeMs / 1000)} s. ` +
      'Cada janela vale a fração das suas consultas ao `/saude` que responderam 200; janela sem consulta vale zero. ' +
      `Foram ${numero(disponibilidade.verificacoes)} consultas no período.`);
    l();
    if (disponibilidade.quedas.length) {
      l('| Início | Fim | Duração | Motivo |');
      l('| --- | --- | --- | --- |');
      for (const q of disponibilidade.quedas) {
        l(`| ${dataHora(q.inicio)} | ${dataHora(q.fim)} | ${duracao(q.duracaoMs)} | ${q.motivo} |`);
      }
    } else {
      l('Nenhuma queda no período.');
    }
  } else {
    l(`Nenhum arquivo do verificador com consultas deste período em \`${dados.pastaDosDados}\`. ` +
      'Se o verificador rodou noutro computador, copie para essa pasta os arquivos `disponibilidade-*.jsonl` da pasta `validacao/dados/` dele.');
  }
  l();

  l('## 6. Reuso');
  l();
  if (!manuais.reuso) {
    l('Não informado em `validacao/medidas-manuais.json`.');
  } else if (manuais.reuso.invalido) {
    l('Tempo inválido em `validacao/medidas-manuais.json`. Escreva os minutos como número, sem aspas.');
  } else {
    const r = manuais.reuso;
    l(`${r.pessoa ? `${r.pessoa} ` : 'A pessoa de fora da equipe '}colocou ${r.sensor ? `um ${r.sensor}` : 'um sensor novo'} publicando em ${numero(r.minutos)} min` +
      (r.quando ? `, em ${r.quando}` : '') + ', seguindo `tutoriais/01-primeiro-no-esp32.md`.' +
      (r.observacoes ? ` Observações: ${frase(r.observacoes)}` : ''));
  }
  l();

  l('## Como este relatório foi feito');
  l();
  l('- Perda e latência: consultas ao InfluxDB (medidas `leitura` e `latencia_painel`) no período.');
  l('- Disponibilidade: arquivos do verificador (`npm run disponibilidade`).');
  l('- pH, condutividade e reuso: medidas registradas pela equipe em `validacao/medidas-manuais.json`.');
  l('- Os números exigidos são os do plano de trabalho. A latência é avaliada no percentil 95 (veja `decisoes/2026-10-18-latencia-no-percentil-95.md`).');
  l();
  return linhas.join('\n');
}
