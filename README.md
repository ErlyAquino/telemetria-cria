# Rede de Telemetria do Espaço CRIA

Software da **Rede de telemetria do Espaço CRIA**: uma plataforma aberta de monitoramento para projetos de IoT, desenvolvida por professor e estudantes da **ETE Epitácio Pessoa** (Cabo de Santo Agostinho, PE).

Projeto aprovado no **Edital nº 19/2026-FACEPE (Espaços CRIA)**, processo ARC-0645-1.03/26, com vigência de 01/07 a 31/12/2026. Coordenação: Erly José da Costa Aquino.

## O que o sistema faz

Sensores ligados a microcontroladores leem grandezas do ambiente (temperatura, umidade, gases, pH, condutividade, vazão, nível de água etc.) e enviam as medidas para um servidor local. O servidor guarda as séries temporais e mostra tudo em um painel web em tempo real, com exportação em CSV.

O produto é a plataforma, em três peças:

1. **O servidor da escola**: broker MQTT, banco de séries temporais e painel web.
2. **A biblioteca-padrão para ESP32** (`firmware/biblioteca-cria/`): conecta no Wi-Fi, reconecta sozinha, formata a medição, publica e guarda as leituras enquanto a rede ou o servidor estiverem fora.
3. **O catálogo de tópicos** ([`mqtt/catalogo-topicos.md`](mqtt/catalogo-topicos.md)): o endereço e o formato de cada mensagem.

Dois projetos-teste validam a plataforma:

1. **Monitor de qualidade do ar** da sala do Espaço CRIA.
2. **Bancada hidropônica NFT** de 25 posições, com oito grandezas medidas.

## Arquitetura

```
[sensores] -> [ESP32 + biblioteca-cria] -> Wi-Fi -> [Mosquitto] -> [servidor + InfluxDB] -> [painel web]
[sensores] -> [Arduino Uno] -> USB -> [gateway] -> HTTP ------------------^
```

| Camada | Tecnologia | Pasta |
| --- | --- | --- |
| Nós de medição | ESP32 (C++/Arduino), ADS1115 de 16 bits para pH e condutividade | `firmware/` |
| Placas Arduino legadas | Arduino Uno pela USB; gateway em Python que envia as leituras ao servidor por HTTP, com a senha do projeto | `gateway/` |
| Transporte | MQTT com Eclipse Mosquitto, senha e ACL por projeto | `mqtt/` |
| Servidor e banco | Node.js (Fastify + Socket.IO) e InfluxDB 2 | `servidor/src/` |
| Painel web | HTML, CSS e JavaScript | `servidor/painel/` |
| Hora certa | chrony como servidor NTP da rede local | `servidor/base/` |

Toda a plataforma roda na rede local da escola, sem internet e sem serviço pago. Por isso o servidor também fornece a hora certa aos nós (NTP local).

## Instalar o servidor

O servidor base (Mosquitto, chrony e InfluxDB) é instalado por um script, num computador com Ubuntu ou Debian:

```bash
sudo bash servidor/base/instalar.sh
```

O passo a passo, o autoteste e o uso do nó simulado estão em [`servidor/base/README.md`](servidor/base/README.md).

## Tópicos e mensagens

O endereço de cada medição segue o padrão `cria/{projeto}/{no}/{grandeza}`, por exemplo `cria/horta/no1/ph`. Cada leitura é uma linha em JSON:

```json
{"valor": 6.12, "unidade": "pH", "seq": 1834, "boot": 7, "t": 1792345678123}
```

O `seq` e o `boot` permitem medir a perda de pacotes; o `t`, em milissegundos, permite medir a latência. Decisões técnicas como essa ficam registradas em `decisoes/`, com data, motivo e o que se perde com a escolha. As regras completas, os projetos registrados e as grandezas de cada um estão no [catálogo de tópicos](mqtt/catalogo-topicos.md).

## Critérios de aceitação

A plataforma só é considerada entregue quando passa nos seis critérios do plano de trabalho:

| Critério | Exigência |
| --- | --- |
| Perda de pacotes | menos de 1% em 24 h de operação contínua |
| Latência | menos de 2 s entre a leitura no nó e o painel, publicando a cada 10 s |
| Exatidão do pH | ±0,2 frente a tampão de verificação não usado na calibração |
| Exatidão da condutividade | ±5% frente a solução-padrão de verificação |
| Disponibilidade do servidor | pelo menos 95% do período de teste, com no-break |
| Reuso | uma pessoa de fora da equipe coloca um sensor novo publicando em até 30 min, usando apenas a biblioteca-padrão e o catálogo, sem reconfigurar o servidor (no projeto `teste`) |

Os resultados vão para `validacao/relatorio-validacao.md`.

## Estrutura do repositório

```
telemetria-cria/
├── README.md
├── LICENSE                    MIT: todo o código
├── LICENSE-DOCS               CC BY 4.0: textos, dados, vídeos e modelos 3D
├── firmware/                  código dos nós ESP32 (C++/Arduino)
│   ├── biblioteca-cria/       a biblioteca-padrão reutilizável
│   └── credenciais.exemplo.h  modelo sem senha, para copiar
├── gateway/                   ponte USB -> HTTP das placas Arduino legadas (Python)
├── servidor/                  Node.js + Fastify + Socket.IO
│   ├── base/                  instalador do Mosquitto, do chrony e do InfluxDB
│   ├── ferramentas/           nó simulado e, depois, os scripts de validação
│   ├── src/
│   └── painel/                a interface web
├── mqtt/
│   ├── catalogo-topicos.md    endereços e formato das mensagens
│   ├── mosquitto.exemplo.conf configuração do broker, sem senhas
│   └── acl                    quem pode publicar onde
├── modelos-3d/                arquivos STL dos abrigos e suportes
├── calibracao/                pontos brutos e relatório de calibração
├── validacao/                 relatório dos seis critérios de aceitação
├── decisoes/                  uma decisão técnica por arquivo: data, o quê, por quê, o que se perde
├── tutoriais/                 passo a passo para quem vai usar ou replicar
└── caderno/                   o caderno digital do dia a dia
    └── fotos/
```

## Plano de desenvolvimento

As etapas reorganizam o cronograma do estudante (versão de 31/08/2026) a partir do que havia no repositório em 18/10/2026: o servidor base, previsto para setembro, e o nó de ar, previsto para 19 a 25/10, foram deslocados. A calibração, o teste de aceitação e a publicação mantêm as datas do cronograma. O servidor, o painel e os scripts de validação são escritos com um nó simulado, sem esperar a chegada das placas.

| Etapa | Período | Frente | O que fica pronto |
| --- | --- | --- | --- |
| 0. Alinhar o repositório | 19 a 25/10 | Coordenação | Estrutura de pastas, licenças e catálogo de tópicos v0 |
| 1. Servidor base e nó simulado | 19/10 a 01/11 | Servidor e painel | Mosquitto com senha e ACL, InfluxDB e NTP local recebendo o nó simulado |
| 2. Servidor e painel | 26/10 a 08/11 | Servidor e painel | Gráfico ao vivo com menos de 2 s de atraso, estado dos nós, exportação em CSV e rota HTTP |
| 3. biblioteca-cria v0.1 e nó de ar | 26/10 a 08/11 | Firmware e nós | Exemplo que compila; nó de ar publicando sem intervenção |
| 4. Gateway das placas Arduino | quando houver folga | Firmware e nós | Arduino Uno enviando ao servidor pela USB |
| 5. Nó da horta e calibração | 09 a 22/11 | Firmware; instrumentação e horta | Oito grandezas no painel; relatório de calibração |
| 6. Integração e ensaios | 23 a 29/11 | Servidor e painel; todas | Os dois projetos no mesmo painel; scripts de perda, latência e disponibilidade; ensaios preliminares com os nós reais |
| 7. Teste de aceitação | 07 a 13/12 | Todas | Relatório de validação com os seis critérios |
| 8. Publicação e transferência | 14 a 18/12 | Documentação e mídia | Repositório público e versão 1.0; quatro vídeos publicados; oficina interna de transferência, que repete o ensaio do critério de reuso |

## Senhas e credenciais

Nunca versione senha, chave de Wi-Fi ou token. O repositório será público, e senha enviada ao GitHub deve ser considerada comprometida no mesmo instante.

- **Firmware:** copie `firmware/credenciais.exemplo.h` para a pasta do seu sketch com o nome `credenciais.h` e preencha. O `credenciais.h` está no `.gitignore`.
- **Servidor, nó simulado e gateway:** usam o `.env` da raiz, criado a partir do `.env.example`. No servidor, o instalador cria o `.env` e grava nele as senhas e o token. O `.env` também está no `.gitignore`.

## Como contribuir

Este repositório é de todos os participantes do projeto. Para preparar o computador, siga o tutorial [Conta no GitHub e Git no terminal](tutoriais/00-conta-github-e-git.md). Combinados:

- Cada pessoa trabalha em um **branch** próprio e abre um **pull request** para o `main`.
- Commits com mensagem curta em português, descrevendo o que mudou.
- Código comentado em português, nomes de variáveis claros.
- Uma issue por problema, com título específico.
- Antes de abrir o pull request, teste o que mudou e diga no texto como testou.

O fluxo com Git é o tema da **Oficina 1** do plano de formação.

## Hardware de referência

- **ESP32 DevKit V1, 30 pinos**, nos nós. Os pinos GPIO 21 e 22 ficam reservados ao barramento I2C. O ADC2 não funciona com o Wi-Fi ligado.
- **Placas Arduino Uno R3** legadas, ligadas ao gateway pela USB.
- **ESP32-CAM** para o registro em time-lapse da horta.
- **ADS1115** (I2C) para as leituras de pH e condutividade.
- **RTC DS3231** no nó `horta/no1`: fornece a hora quando o nó reinicia sem acesso ao NTP do servidor.
- Monitor de ar: MQ-2 e MQ-135 (com divisor de tensão na saída, porque são alimentados em 5 V) e MH-Z19B (CO₂).
- Horta: módulo de pH PH-4502C com eletrodo, sensor de condutividade, DS18B20, sensor de vazão YF-S201, sensor de pressão de água, sensor de nível por boia, DHT22 e BH1750.

## Licenças

- Código (`firmware/`, `servidor/`, `gateway/` e scripts): **MIT**, no arquivo [`LICENSE`](LICENSE).
- Textos, tutoriais, dados, vídeos e modelos 3D: **Creative Commons CC BY 4.0**, no arquivo [`LICENSE-DOCS`](LICENSE-DOCS).

## Repositórios relacionados

Os dois são de acesso restrito à equipe.

- [mythos-fomento](https://github.com/ErlyAquino/mythos-fomento): proposta, edital, plano de oficinas e documentos administrativos do projeto.
- [arduino-esp32-sensores](https://github.com/ErlyAquino/arduino-esp32-sensores): experimentos anteriores com sensores, notebooks e esquemas Fritzing.
