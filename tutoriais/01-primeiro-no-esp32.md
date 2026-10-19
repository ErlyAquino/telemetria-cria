# Tutorial: o primeiro nó ESP32 na rede de telemetria

Este tutorial leva um sensor do zero até o painel da rede de telemetria do Espaço CRIA. É também o material do teste de reuso: uma pessoa de fora da equipe precisa, só com ele, colocar um sensor novo publicando em até 30 minutos.

Ao final, o seu nó aparece no painel, on-line, com as leituras chegando a cada 10 segundos.

## 0. O que você precisa

- Uma placa **ESP32 DevKit V1** (30 pinos) e um cabo USB **de dados**. Cabo só de carga não serve.
- Um sensor. O exemplo usa o **DHT22** (temperatura e umidade) e um resistor de **10 kΩ**.
- Um computador com a **Arduino IDE 2**.
- Com o coordenador:
  - o nome e a senha da rede Wi-Fi da telemetria;
  - o endereço IP do servidor;
  - a senha do usuário MQTT `teste`.

## 1. Preparar a Arduino IDE (cerca de 10 min)

1. **Núcleo do ESP32.** Em *Arquivo → Preferências*, no campo *URLs adicionais do Gerenciador de Placas*, cole:

   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

   Depois, em *Ferramentas → Placa → Gerenciador de Placas*, procure **esp32** e instale o da **Espressif Systems**, versão 3 ou mais nova.
2. **Placa.** Em *Ferramentas → Placa → esp32*, escolha **DOIT ESP32 DEVKIT V1**.
3. **Porta.** Ligue a placa no USB e escolha a porta em *Ferramentas → Porta*. Se nenhuma porta nova aparecer, instale o driver do chip USB da placa, que vem escrito perto do conector: **CP210x** (Silicon Labs) ou **CH340** (WCH).
4. **Bibliotecas.** Em *Ferramentas → Gerenciar Bibliotecas*, instale:
   - **PubSubClient**, de Nick O'Leary;
   - **DHT sensor library**, da Adafruit. Quando ela pedir as dependências, clique em *Instalar todas*: a Adafruit Unified Sensor vem junto.
5. **A biblioteca da rede.** Veja em *Arquivo → Preferências* o campo *Local do sketchbook*. Copie a pasta `firmware/biblioteca-cria` do repositório para a subpasta `libraries` desse local e reinicie a IDE. No Windows com OneDrive, esse local pode não ser `Documentos\Arduino`: use o que a IDE mostrar.

## 2. Abrir o exemplo e salvar uma cópia (2 min)

1. Abra *Arquivo → Exemplos → CriaTelemetria → PrimeiroNo*.
2. Use *Arquivo → Salvar como* e dê um nome, por exemplo `meu-primeiro-no`. Exemplos não podem ser editados no lugar.

## 3. Credenciais (3 min)

1. Na seta ao lado das abas, à direita, escolha *Nova aba* e chame-a de `credenciais.h`.
2. Cole nela o conteúdo de `firmware/credenciais.exemplo.h` e preencha:
   - `WIFI_SSID` e `WIFI_SENHA`: a rede da telemetria;
   - `MQTT_HOST`: o IP do servidor, entre aspas, por exemplo `"192.168.0.10"`;
   - `MQTT_USUARIO`: `"teste"`, o mesmo nome do projeto no programa;
   - `MQTT_SENHA`: a senha do usuário `teste`.

Esse arquivo nunca vai para o GitHub: ele está no `.gitignore`.

## 4. Escolher um nó livre (1 min)

Abra o painel no navegador, em `http://IP_DO_SERVIDOR:3000`, e veja quais nós do projeto `teste` já existem. Escolha um número que não apareça ali e troque na linha:

```cpp
CriaNo no("teste", "no1");
```

Por exemplo, `"no7"`. Dois nós com o mesmo nome se derrubam um ao outro no broker. O `no99` é reservado ao autoteste do servidor.

## 5. Montar o sensor (5 min)

DHT22, da esquerda para a direita, com a grade virada para você:

| Pino do DHT22 | Liga em |
| --- | --- |
| 1 (VCC) | 3,3 V do ESP32 |
| 2 (dado) | GPIO 4, e um resistor de 10 kΩ deste pino até o 3,3 V |
| 3 | nada |
| 4 (GND) | GND do ESP32 |

Se o seu DHT22 vier num módulo de 3 pinos, o resistor já está nele: ligue `+` no 3,3 V, `out` no GPIO 4 e `-` no GND.

## 6. Enviar para a placa (2 min)

Clique em *Carregar* (a seta). Se a IDE ficar parada em `Connecting...`, segure o botão **BOOT** da placa até a gravação começar.

## 7. Conferir (2 min)

Abra *Ferramentas → Monitor Serial* em **115200** baud. Depois de reiniciar a placa (botão **EN**), aparece algo assim:

```
[cria] nó cria/teste/no7, biblioteca CriaTelemetria 0.1.0
[cria] boot 1
[cria] aguardando o Wi-Fi "rede-telemetria"...
[cria] Wi-Fi conectado, IP 192.168.0.23
[cria] conectado ao broker; status online em cria/teste/no7/status
[cria] relógio acertado: 2026-11-05 13:05:42 UTC
[cria] cria/teste/no7/temperatura {"valor":27.4,"unidade":"C","seq":1,"boot":1,"t":1793883942113}
[cria] cria/teste/no7/umidade {"valor":61.2,"unidade":"%","seq":2,"boot":1,"t":1793883942118}
```

A hora pode levar até uns 30 segundos para chegar. Antes dela, nada é medido. No painel, o cartão `teste/no7` aparece on-line, com os dois valores e os gráficos.

## 8. Trocar pelo seu sensor (o resto do tempo)

Só o trecho dentro do `if (no.aCada(10000))` muda. Para cada grandeza do seu sensor:

1. Leia o valor com a biblioteca do sensor.
2. Descarte as leituras de falha antes de publicar. O DHT22 devolve `NaN`, que a biblioteca já recusa. O DS18B20 desconectado devolve −127, e o seu programa precisa conferir isso.
3. Chame `no.publicar("grandeza", valor, "unidade")`:
   - a **grandeza** tem o nome da grandeza física, em minúsculas e sem acento: `temperatura`, `pressao`, `iluminancia`;
   - a **unidade** vem da tabela do catálogo (`mqtt/catalogo-topicos.md`, seção 4) e é escrita sem símbolos especiais: `C`, `%`, `kPa`, `lx`, `uS/cm`.

Exemplo com um DS18B20:

```cpp
sensores.requestTemperatures();
float temperatura = sensores.getTempCByIndex(0);
if (temperatura > -100) no.publicar("temperatura", temperatura, "C");  // -127 = desconectado
```

Se a grandeza for nova no catálogo, avise o coordenador para registrá-la. O servidor já grava e mostra qualquer grandeza que siga as regras, sem nenhuma mudança.

## Problemas comuns

| O Monitor Serial mostra | O que fazer |
| --- | --- |
| `rede não encontrada` | Confira o `WIFI_SSID`, letra por letra, e se o ponto de acesso está ligado |
| `o ponto de acesso recusou a conexão` | Confira a `WIFI_SENHA` |
| `usuário ou senha recusados` | Confira `MQTT_USUARIO` e `MQTT_SENHA` |
| `MQTT_USUARIO é ... mas o projeto é ...` | Os dois precisam ser iguais: `"teste"` nos dois |
| `servidor não respondeu` | Confira o `MQTT_HOST` e se o servidor está ligado |
| `esperando a hora do servidor` | O servidor de hora (chrony) não respondeu: avise o coordenador |
| `a conexão cai logo depois de abrir` | Outro nó usa o mesmo nome: troque o número do nó |
| `leitura com falha (NaN ou infinito)` | O sensor não respondeu: confira a fiação e o resistor |
| `grandeza ... fora das regras do catálogo` | Use só letras minúsculas, algarismos e hífen, sem acento |

## Para quem conduz o teste de reuso

Entregue este tutorial, a placa, o sensor e as credenciais. Ligue o cronômetro e observe em silêncio. Anote cada tropeço, com o passo e o tempo. O cronômetro para quando o cartão do nó novo aparece on-line no painel com uma leitura do sensor. O resultado vai para `validacao/relatorio-validacao.md`. Cada tropeço anotado é uma correção para este tutorial ou para a biblioteca.
