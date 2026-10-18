// Painel da telemetria: recebe as leituras pelo Socket.IO e desenha.
//
// Eventos que chegam do servidor:
//   nos      — { agora, nos }: todos os nós, ao conectar
//   no       — um nó mudou (status ou perda estimada)
//   leitura  — uma leitura nova, no formato do catálogo
// Evento que o painel manda, só quando aberto com ?medir=1:
//   desenhado — avisa que o ponto apareceu na tela, para medir a latência

const MINUTOS_NO_GRAFICO = 60;
// O painel do teste de aceitação é aberto com ?medir=1 e fica à vista na tela.
// Os outros (celulares, sala de aula) não medem, para não encher o banco.
const MEDIR_LATENCIA = new URLSearchParams(location.search).get('medir') === '1';

// Nomes e unidades só para exibição; o catálogo usa a forma sem acento.
const NOMES = {
  ph: 'pH',
  condutividade: 'Condutividade',
  temperatura: 'Temperatura',
  vazao: 'Vazão',
  pressao: 'Pressão',
  nivel: 'Nível do reservatório',
  umidade: 'Umidade do ar',
  iluminancia: 'Iluminância',
  co2: 'CO₂',
  mq2: 'MQ-2 (relativo)',
  mq135: 'MQ-135 (relativo)',
};
const UNIDADES = { C: '°C', 'uS/cm': 'µS/cm', 'Rs/R0': 'Rs/R₀', estado: '', pH: '' };

const nos = new Map(); // "projeto/no" -> { elemento, dados, grandezas: Map }
const socket = io();
// Diferença entre o relógio do servidor e o deste aparelho, em ms.
let diferencaDeRelogio = 0;
let jaConectou = false;

// ---------------------------------------------------------------------------
// Conexão com o servidor

const conexao = document.getElementById('conexao');
socket.on('connect', () => {
  conexao.dataset.estado = 'conectado';
  conexao.textContent = MEDIR_LATENCIA ? 'Conectado: medindo a latência' : 'Conectado: atualizando ao vivo';
  // Numa reconexão, recarrega o que se perdeu enquanto o painel esteve fora.
  if (jaConectou) {
    for (const no of nos.values()) {
      for (const [grandeza, item] of no.grandezas) carregarHistorico(item, no.dados.projeto, no.dados.no, grandeza);
    }
  }
  jaConectou = true;
});
socket.on('disconnect', () => {
  conexao.dataset.estado = 'desconectado';
  conexao.textContent = 'Sem conexão com o servidor: tentando de novo';
});

socket.on('nos', ({ agora, nos: lista }) => {
  diferencaDeRelogio = agora - Date.now();
  lista.forEach(atualizarNo);
});
socket.on('no', atualizarNo);
socket.on('leitura', receberLeitura);

// Hora "do servidor", que é a mesma dos nós.
function agoraNoServidor() {
  return Date.now() + diferencaDeRelogio;
}

// ---------------------------------------------------------------------------
// Nós

function atualizarNo(resumo) {
  const no = garantirNo(resumo.projeto, resumo.no);
  no.dados = { ...no.dados, ...resumo };

  const status = no.elemento.querySelector('.status');
  status.dataset.status = resumo.status;
  status.textContent = { online: 'on-line', offline: 'off-line' }[resumo.status] ?? 'sem notícia';

  const perda = no.elemento.querySelector('.perda');
  if (resumo.perda && resumo.perda.esperadas > 0) {
    const { boot, recebidas, esperadas } = resumo.perda;
    // Leituras repetidas (reenvio do gateway) poderiam dar perda negativa.
    const fracao = Math.max(0, (esperadas - recebidas) / esperadas);
    perda.textContent = `perda estimada ${formatar(fracao * 100, 1)}% (boot ${boot}, ${recebidas} leituras)`;
  }

  for (const [grandeza, g] of Object.entries(resumo.grandezas ?? {})) {
    const item = garantirGrandeza(no, resumo.projeto, resumo.no, grandeza);
    mostrarValor(item, grandeza, g.valor, g.unidade);
  }
  atualizarTempos();
}

function garantirNo(projeto, nomeDoNo) {
  const chave = `${projeto}/${nomeDoNo}`;
  let no = nos.get(chave);
  if (no) return no;

  const elemento = document.getElementById('modelo-no').content.firstElementChild.cloneNode(true);
  elemento.querySelector('.no-nome').textContent = chave;
  elemento.querySelector('.baixar').dataset.filtro = `projeto=${projeto}&no=${nomeDoNo}`;
  document.getElementById('vazio').hidden = true;

  // Mantém os nós em ordem na página, com no2 antes de no10.
  const ordem = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true });
  const depois = [...nos.keys()].sort(ordem).find((k) => ordem(k, chave) > 0);
  document.getElementById('nos').insertBefore(elemento, depois ? nos.get(depois).elemento : null);

  no = { elemento, dados: { projeto, no: nomeDoNo }, grandezas: new Map() };
  nos.set(chave, no);
  atualizarLinksDeExportacao();
  return no;
}

// ---------------------------------------------------------------------------
// Grandezas e gráficos

function garantirGrandeza(no, projeto, nomeDoNo, grandeza) {
  let item = no.grandezas.get(grandeza);
  if (item) return item;

  const elemento = document.getElementById('modelo-grandeza').content.firstElementChild.cloneNode(true);
  elemento.querySelector('.grandeza-nome').textContent = NOMES[grandeza] ?? grandeza;
  no.elemento.querySelector('.grandezas').append(elemento);

  const cor = getComputedStyle(document.documentElement).getPropertyValue('--linha').trim();
  const grafico = new Chart(elemento.querySelector('canvas'), {
    type: 'line',
    data: { datasets: [{ data: [], borderColor: cor, borderWidth: 1.5, pointRadius: 0, tension: 0 }] },
    options: {
      animation: false,
      parsing: false,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (itens) => hora(itens[0].parsed.x) } } },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            maxTicksLimit: 4,
            // Com poucos minutos no gráfico, mostra também os segundos.
            callback(t) {
              return hora(t, this.max - this.min < 10 * 60 * 1000);
            },
          },
        },
        y: { ticks: { maxTicksLimit: 4 } },
      },
    },
  });

  item = { elemento, grafico };
  no.grandezas.set(grandeza, item);
  carregarHistorico(item, projeto, nomeDoNo, grandeza);
  return item;
}

async function carregarHistorico(item, projeto, no, grandeza) {
  const resposta = await fetch(
    `/api/historico?projeto=${projeto}&no=${no}&grandeza=${grandeza}&minutos=${MINUTOS_NO_GRAFICO}`,
  );
  if (!resposta.ok) return;
  const historico = (await resposta.json()).map((p) => ({ x: p.t, y: p.valor }));
  const pontos = item.grafico.data.datasets[0].data;
  // Junta o histórico com o que já chegou ao vivo enquanto ele carregava.
  const vistos = new Set(pontos.map((p) => p.x));
  pontos.push(...historico.filter((p) => !vistos.has(p.x)));
  pontos.sort((a, b) => a.x - b.x);
  cortarAntigos(pontos);
  agendarDesenho(item);
}

function receberLeitura(l) {
  const no = garantirNo(l.projeto, l.no);
  const item = garantirGrandeza(no, l.projeto, l.no, l.grandeza);
  const pontos = item.grafico.data.datasets[0].data;

  const foraDeOrdem = pontos.length > 0 && l.t < pontos[pontos.length - 1].x;
  pontos.push({ x: l.t, y: l.valor });
  // O gráfico supõe pontos em ordem de hora: uma leitura da fila, ou um lote
  // atrasado do gateway, entra no lugar certo.
  if (foraDeOrdem) pontos.sort((a, b) => a.x - b.x);
  cortarAntigos(pontos);

  if (!l.fila) {
    mostrarValor(item, l.grandeza, l.valor, l.unidade);
    no.dados.ultimaRecepcao = agoraNoServidor();
    no.dados.status = 'online';
  }
  agendarDesenho(item);

  // Leituras da fila ficam fora da latência: o atraso delas é o da queda.
  if (MEDIR_LATENCIA && !l.fila && !document.hidden) {
    avisosPendentes.push({ projeto: l.projeto, no: l.no, grandeza: l.grandeza, t: l.t, geracao: geracaoVisivel });
  }
}

// O gráfico mostra a última hora contada a partir do ponto mais novo, e não do
// relógio deste aparelho, que pode estar errado.
function cortarAntigos(pontos) {
  if (pontos.length === 0) return;
  const limite = pontos[pontos.length - 1].x - MINUTOS_NO_GRAFICO * 60 * 1000;
  let antigos = 0;
  while (antigos < pontos.length && pontos[antigos].x < limite) antigos += 1;
  if (antigos > 0) pontos.splice(0, antigos);
}

// ---------------------------------------------------------------------------
// Desenho agrupado e aviso de latência
//
// Um nó que esvazia a fila manda milhares de leituras de uma vez. Em vez de
// redesenhar a cada uma, o painel marca o gráfico e redesenha uma vez por quadro.
// Depois do desenho, avisa o servidor dos pontos que acabaram de aparecer.

const graficosParaDesenhar = new Set();
let avisosPendentes = [];
let desenhoAgendado = false;
// Muda sempre que a aba é ocultada ou volta: aviso de antes disso não vale.
let geracaoVisivel = 0;
document.addEventListener('visibilitychange', () => {
  geracaoVisivel += 1;
});

function agendarDesenho(item) {
  graficosParaDesenhar.add(item);
  if (desenhoAgendado) return;
  desenhoAgendado = true;
  requestAnimationFrame(() => {
    desenhoAgendado = false;
    for (const g of graficosParaDesenhar) g.grafico.update('none');
    graficosParaDesenhar.clear();
    const avisos = avisosPendentes;
    avisosPendentes = [];
    if (document.hidden) return;
    for (const { geracao, ...aviso } of avisos) {
      if (geracao === geracaoVisivel) socket.emit('desenhado', aviso);
    }
  });
}

function mostrarValor(item, grandeza, valor, unidade) {
  const numero = item.elemento.querySelector('.numero');
  if (grandeza === 'nivel' && unidade === 'estado') {
    numero.textContent = valor === 1 ? 'acima da boia' : 'abaixo da boia';
  } else {
    numero.textContent = formatar(valor, 2);
  }
  item.elemento.querySelector('.unidade').textContent = UNIDADES[unidade] ?? unidade;
}

// ---------------------------------------------------------------------------
// "há 5 s" e exportação

function atualizarTempos() {
  for (const no of nos.values()) {
    const ultima = no.elemento.querySelector('.ultima');
    const t = no.dados.ultimaRecepcao;
    ultima.textContent = t ? `última leitura há ${tempoDesde(t)}` : '';
  }
}
setInterval(atualizarTempos, 1000);

function atualizarLinksDeExportacao() {
  const horas = document.getElementById('periodo').value;
  const formato = document.getElementById('formato').value;
  const base = `/api/exportar.csv?horas=${horas}&formato=${formato}`;
  document.getElementById('exportar-tudo').href = base;
  for (const link of document.querySelectorAll('.baixar')) link.href = `${base}&${link.dataset.filtro}`;
}
document.getElementById('periodo').addEventListener('change', atualizarLinksDeExportacao);
document.getElementById('formato').addEventListener('change', atualizarLinksDeExportacao);
atualizarLinksDeExportacao();

// ---------------------------------------------------------------------------
// Formatação em português

function formatar(numero, casas) {
  return numero.toLocaleString('pt-BR', { maximumFractionDigits: casas });
}

function hora(t, comSegundos = true) {
  return new Date(t).toLocaleTimeString('pt-BR', comSegundos ? {} : { hour: '2-digit', minute: '2-digit' });
}

// Tempo desde um instante medido no relógio do servidor.
function tempoDesde(t) {
  const segundos = Math.max(0, Math.round((agoraNoServidor() - t) / 1000));
  if (segundos < 60) return `${segundos} s`;
  if (segundos < 3600) return `${Math.floor(segundos / 60)} min`;
  return `${Math.floor(segundos / 3600)} h`;
}
