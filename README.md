# Rede de Telemetria do Espaço CRIA

Software da **Rede de telemetria do Espaço CRIA**: uma plataforma aberta de monitoramento para projetos de IoT, desenvolvida por professor e estudantes da **ETE Epitácio Pessoa** (Cabo de Santo Agostinho, PE).

Projeto aprovado no **Edital nº 19/2026-FACEPE (Espaços CRIA)**, processo ARC-0645-1.03/26. Coordenação: Erly José da Costa Aquino.

## O que o sistema faz

Sensores ligados a microcontroladores leem grandezas do ambiente (temperatura, umidade, gases, pH, condutividade, nível de água etc.) e enviam as medidas para um servidor local. O servidor guarda as séries temporais e mostra tudo em um painel web em tempo real.

Dois projetos-teste validam a plataforma:

1. **Monitor de qualidade do ar** da sala do Espaço CRIA.
2. **Bancada hidropônica NFT** de 25 plantas, com sensores de pH, condutividade, temperatura e nível do reservatório.

## Arquitetura

```
[sensores] -> [Arduino / ESP32] -> [gateway] -> [MQTT (Mosquitto)] -> [backend + InfluxDB] -> [painel web]
```

| Camada | Tecnologia prevista | Pasta |
| --- | --- | --- |
| Firmware dos nós | Arduino (C++), depois ESP32 com Wi-Fi | `firmware/` |
| Gateway serial (fase 1) | Python, lê a porta USB e publica no MQTT | `gateway/` |
| Mensageria | MQTT com Mosquitto | `docs/` (configuração) |
| Backend e banco | Node.js (Fastify + Socket.IO) e InfluxDB | `backend/` |
| Painel web | HTML, CSS e JavaScript | `frontend/` |

## Plano de desenvolvimento

O trabalho começa **offline, em rede local**, sem depender de internet. As etapas são incrementais: cada uma funciona sozinha antes de passar para a próxima.

### Fase 1: sensores no Arduino, dados pela porta USB

- Ligar os sensores a um Arduino e ler os valores no Monitor Serial.
- Definir o formato das mensagens (uma linha por leitura, em JSON ou CSV).
- Escrever o gateway em Python que lê a porta USB e repassa as leituras.
- Guardar as leituras em arquivo e depois no banco de séries temporais.
- Mostrar os primeiros gráficos no painel web.

### Fase 2: ESP32 enviando pelo Wi-Fi

- Portar o firmware para o ESP32.
- Publicar as leituras diretamente no broker MQTT pela rede local.
- Vários nós ao mesmo tempo, cada um com seu identificador.
- Painel mostrando todos os nós, com alertas por faixa de valor.

### Fase 3: projetos-teste

- Instalar o monitor de qualidade do ar.
- Instrumentar a bancada hidropônica NFT.
- Documentar a montagem para que outras escolas possam reproduzir.

## Formato das mensagens (proposta inicial)

Cada leitura é uma linha de texto em JSON:

```json
{"no": "ar-01", "sensor": "temperatura", "valor": 27.4, "unidade": "C", "t": 1727272800}
```

Esse formato vale tanto para a porta serial (fase 1) quanto para o MQTT (fase 2). O tópico MQTT segue o padrão `cria/<no>/<sensor>`.

## Como contribuir

Este repositório é de todos os participantes do projeto. Combinados:

- Cada pessoa trabalha em um **branch** próprio e abre um **pull request** para o `main`.
- Commits com mensagem curta em português, descrevendo o que mudou.
- Código comentado em português, nomes de variáveis claros.
- Nunca versionar senhas, chaves de Wi-Fi ou tokens: use o arquivo `.env` (ignorado pelo git) e mantenha um `.env.example` atualizado.
- Antes de abrir o pull request, teste o que mudou e diga no texto como testou.

O fluxo com Git é o tema da **Oficina 1** do plano de formação.

## Hardware de referência

- Arduino Uno ou Nano (fase 1).
- ESP32 DevKit V1, 30 pinos (fase 2). Os pinos GPIO 21 e 22 ficam reservados ao barramento I2C. O ADC2 não funciona com o Wi-Fi ligado.
- Conversor ADS1115 (I2C) para leituras analógicas de precisão.
- Sensores: DHT22, série MQ (com divisor de tensão), sensor de pH com eletrodo, sensor de condutividade, DS18B20, sensor de nível.

## Licenças

- Código: **MIT** (ver `LICENSE`).
- Textos, vídeos e modelos 3D: **Creative Commons CC BY 4.0**.

## Repositórios relacionados

- [mythos-fomento](https://github.com/ErlyAquino/mythos-fomento): proposta, edital, plano de oficinas e documentos administrativos do projeto.
- [arduino-esp32-sensores](https://github.com/ErlyAquino/arduino-esp32-sensores): experimentos anteriores com sensores, notebooks e esquemas Fritzing.
