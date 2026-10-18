# Servidor e painel

O servidor da telemetria, em Node.js. Ele:

- assina `cria/#` no broker, numa sessão persistente, e confere cada mensagem contra o [catálogo de tópicos](../mqtt/catalogo-topicos.md);
- grava cada leitura no InfluxDB, com a hora em que o nó mediu;
- repassa as leituras ao painel em tempo real, pelo Socket.IO;
- serve o painel, a exportação em CSV, a rota HTTP das placas Arduino e o `/saude`.

O servidor base (Mosquitto, chrony e InfluxDB) precisa estar instalado antes: veja [`base/README.md`](base/README.md).

## Como rodar

Precisa do Node.js 22 ou mais novo e do `.env` na raiz do repositório, que o instalador do servidor base cria. Na pasta `servidor/`:

```bash
npm install
npm start
```

O painel abre em `http://IP_DO_SERVIDOR:3000`, em qualquer computador ou celular da rede.

Para ver leituras sem placa nenhuma, rode o nó simulado em outro terminal (`npm run simulador`; opções em `base/README.md`).

Os testes automáticos das regras do catálogo e do CSV rodam com:

```bash
npm test
```

## Pastas

| Arquivo | O que faz |
| --- | --- |
| `src/servidor.js` | Liga as peças: rotas, Socket.IO, tarefas periódicas, partida e parada |
| `src/catalogo.js` | Regras do catálogo: confere tópico e mensagem. Funções puras, cobertas por testes |
| `src/assinante.js` | Conexão com o broker, assinando `cria/#` |
| `src/banco.js` | Gravação e consultas no InfluxDB |
| `src/estado.js` | Estado de cada nó na memória: status, último valor, perda estimada |
| `src/publicador-http.js` | Publica no broker as leituras recebidas pela rota HTTP |
| `src/csv.js` | Formata as leituras em CSV. Coberto por testes |
| `src/config.js` | Lê o `.env` |
| `painel/` | O painel: HTML, CSS e JavaScript, sem etapa de compilação |
| `ferramentas/no-simulado.js` | O nó simulado |
| `test/` | Testes automáticos (`npm test`) |

## Rotas

| Rota | O que devolve |
| --- | --- |
| `GET /` | O painel. Com `?medir=1`, o painel também mede a latência (veja abaixo) |
| `GET /saude` | Estado do servidor em JSON. Dá HTTP 200 quando o broker está conectado, o InfluxDB responde e a última gravação deu certo; senão, 503. Traz as contagens de leituras, de linhas gravadas e descartadas, e a latência medida pelo painel. É o que o teste de disponibilidade consulta |
| `GET /api/nos` | Lista dos nós com status, último valor de cada grandeza e perda estimada |
| `GET /api/historico?projeto=&no=&grandeza=&minutos=60` | Pontos de uma grandeza (até 1440 minutos), para os gráficos |
| `GET /api/exportar.csv?horas=24&formato=br` | As leituras do período em CSV, agrupadas por série (projeto, nó, grandeza) e, dentro de cada uma, em ordem de hora. Filtros opcionais: `projeto`, `no` e `grandeza`. `formato=br` (padrão) usa ponto e vírgula e vírgula decimal; `formato=internacional` usa vírgula e ponto decimal. Até 744 horas (31 dias). Uma exportação por vez: um pedido durante outra recebe 429 |
| `POST /api/leituras` | Recebe leituras das placas Arduino (veja abaixo) |

### Rota HTTP das placas Arduino

O gateway envia uma lista JSON de até 1000 leituras (no máximo 256 KiB), com o usuário e a senha MQTT do projeto em autenticação Basic. Cada leitura segue o formato da seção 2 do catálogo, com o nó e a grandeza dentro do objeto:

```bash
curl -u horta:SENHA_DA_HORTA -H 'Content-Type: application/json' \
  -d '[{"no":"no3","grandeza":"temperatura","valor":27.4,"unidade":"C","seq":12,"boot":3,"t":1792345678123}]' \
  http://IP_DO_SERVIDOR:3000/api/leituras
```

A resposta diz quantas leituras foram aceitas e por que as outras foram recusadas. O servidor não guarda senha de projeto: ele publica as leituras no broker com esse usuário e essa senha, e quem confere a senha e limita o projeto é o próprio broker, com a ACL. As leituras voltam ao servidor pela assinatura de `cria/#`, pelo mesmo caminho das que vêm dos ESP32. A conexão com o broker de cada projeto é reaproveitada por até 1 hora; depois de trocar a senha de um projeto no broker, a antiga pode valer na rota HTTP até essa hora terminar.

| Resposta | Quando |
| --- | --- |
| 200 | Pelo menos uma leitura aceita |
| 400 | Corpo que não é uma lista, lista vazia ou nenhuma leitura válida |
| 401 | Sem usuário e senha, ou o broker os recusou |
| 403 | Usuário que não é projeto (por exemplo, `servidor`) |
| 503 | Broker fora do ar, ou não confirmou as leituras em 10 s |

Uma placa Arduino não tem LWT: o nó que passa 30 s sem enviar leitura fica off-line no painel.

## Eventos do Socket.IO

| Evento | Sentido | Conteúdo |
| --- | --- | --- |
| `nos` | servidor → painel | `{ agora, nos }`: a hora do servidor e a lista dos nós, igual a `/api/nos`. Enviado ao conectar |
| `no` | servidor → painel | Um nó cujo status mudou, ou cuja perda estimada mudou (no máximo a cada 5 s) |
| `leitura` | servidor → painel | Uma leitura: `projeto`, `no`, `grandeza`, `valor`, `unidade`, `seq`, `boot`, `t`, `fila` |
| `desenhado` | painel → servidor | `projeto`, `no`, `grandeza` e `t` de um ponto que acabou de aparecer na tela |

O painel usa a hora do servidor para escrever "última leitura há X s" e corta o gráfico pela hora dos próprios dados. Um celular com o relógio errado mostra o mesmo que os outros.

### Medida de latência (critério 2)

O painel aberto com `http://IP_DO_SERVIDOR:3000/?medir=1` envia um `desenhado` depois de desenhar cada leitura nova. O servidor anota a hora em que o aviso chega, no próprio relógio, e subtrai o `t` da leitura. O resultado vai para a medida `latencia_painel` do InfluxDB e para o resumo no `/saude`. Os outros painéis (celulares, sala de aula) não medem, para não multiplicar as gravações.

Para a medida valer:

- o painel com `?medir=1` precisa ficar aberto e à vista durante todo o teste, porque uma aba oculta adia o desenho;
- só conta o aviso da última leitura de cada série, uma vez por painel, e com atraso entre 0 e 60 s. Avisos fora disso são recusados e contados em `avisosRecusados` no `/saude`. Leituras que esperaram na fila do nó (`fila: 1`) ficam de fora.

## Variáveis do `.env`

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `MQTT_HOST`, `MQTT_PORTA` | `localhost`, `1883` | Endereço do broker |
| `MQTT_USUARIO`, `MQTT_SENHA` | `servidor`, obrigatória | Usuário do servidor no broker |
| `MQTT_CLIENT_ID` | `servidor-telemetria` | Identificador da sessão persistente. Dois servidores com o mesmo identificador se derrubam um ao outro |
| `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_BUCKET` | `http://localhost:8086`, `cria`, `telemetria` | Onde gravar |
| `INFLUX_TOKEN` | obrigatória | Token do bucket, criado pelo instalador |
| `PORTA_HTTP` | `3000` | Porta do painel e das rotas |
| `FUSO_HORARIO` | `America/Recife` | Fuso da coluna `data_hora` e do nome do arquivo CSV |

## Limitações conhecidas

Medidas no teste de 18/10/2026, contra o servidor base instalado no Ubuntu 26.04:

- **Servidor fora do ar.** Se o servidor cair e voltar, o broker entrega as leituras feitas enquanto ele estava fora. No teste, as cerca de 60 leituras de 22 s com o servidor desligado chegaram todas.
- **Lote na memória.** As leituras esperam até 250 ms na memória antes de serem gravadas no InfluxDB. Se o processo morrer de repente (falta de energia sem no-break, `kill -9`), esse lote se perde e aparece como lacuna no `seq`. No teste com o processo derrubado à força, perdeu-se um ciclo de leituras de cada nó. Numa parada normal (Ctrl+C ou `systemctl stop`), o lote é gravado antes de sair.
- **InfluxDB fora do ar.** As leituras continuam chegando ao painel. As que não puderam ser gravadas esperam na memória, até 50000 linhas, e o servidor tenta gravá-las de novo por até 2 horas. Passado isso, ou se o banco recusar o lote (token revogado, por exemplo), elas são descartadas, contadas em `linhasDescartadas` e anunciadas no terminal. Enquanto a gravação estiver falhando, o `/saude` responde 503.
- **Latência só com o painel visível.** Veja a seção acima. Sem o navegador, do nó até a chegada no Socket.IO, a latência medida foi de 48 ms na mediana e 50 ms no p95.
- **Assinatura em QoS 0.** O servidor assina com QoS 0 por causa de um comportamento do Mosquitto 2.0 descrito em [`decisoes/2026-10-18-servidor-assina-com-qos-0.md`](../decisoes/2026-10-18-servidor-assina-com-qos-0.md).
