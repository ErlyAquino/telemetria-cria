# Nó da solução nutritiva: `horta/no1`

Mede a solução da bancada hidropônica NFT e protege a bomba. Publica, a cada 10 s:

| Grandeza | Sensor | Unidade | Observação |
| --- | --- | --- | --- |
| `ph` | PH-4502C com eletrodo, pelo ADS1115 | `pH` | Só depois de calibrado |
| `condutividade` | Sensor TDS analógico, pelo ADS1115 | `uS/cm` | Referida a 25 °C; só depois de calibrada |
| `temperatura` | DS18B20 à prova d'água | `C` | Temperatura da solução; compensa a condutividade |
| `vazao` | YF-S201 | `L/min` | Média dos últimos 10 s |
| `pressao` | Sensor de pressão de 0 a 1,2 MPa, pelo ADS1115 | `kPa` | Manométrica |
| `nivel` | Boia | `estado` | `1` = solução acima da boia |
| `bomba` | Relé da bomba | `estado` | `1` = ligada; `0` = cortada pela proteção |

O nó leva também o RTC DS3231: depois de um corte de energia sem rede, ele volta a medir com a hora do DS3231.

## Montagem

ESP32 DevKit V1 de 30 pinos. Os pinos 21 e 22 são o barramento I2C do projeto.

| Peça | Ligação |
| --- | --- |
| **Conversor de nível lógico** (4 canais) | LV no 3,3 V do ESP32, HV no 5 V, GND comum. Canais 1 e 2: SDA (GPIO 21) e SCL (GPIO 22). Canal 3: pulsos do sensor de vazão (GPIO 27) |
| **ADS1115** | VDD no 5 V, GND, SDA e SCL no lado de 5 V (HV) do conversor de nível, ADDR no GND (endereço 0x48). A0: pH; A1: condutividade; A2: pressão |
| **PH-4502C** | V+ no 5 V, G no GND, Po na entrada A0 do ADS1115. O eletrodo no conector BNC |
| **Sensor de condutividade (TDS)** | VCC no **GPIO 32** (não no 3,3 V: o nó desliga o sensor fora da leitura, para ele não desviar o pH), GND, sinal A na entrada A1 do ADS1115 |
| **Sensor de pressão** | Vermelho no 5 V, preto no GND, sinal na entrada A2 do ADS1115 |
| **DS18B20** | Vermelho no 3,3 V, preto no GND, amarelo no GPIO 4, com resistor de 4,7 kΩ entre o amarelo e o 3,3 V |
| **YF-S201** | Vermelho no 5 V, preto no GND, amarelo no lado de 5 V do canal 3 do conversor de nível; o lado de 3,3 V vai ao GPIO 27 |
| **Boia** | Um fio no GPIO 25, o outro no GND. Monte a boia de modo que o contato **feche com a solução acima dela** |
| **DS3231** | VCC no 3,3 V, GND, SDA no GPIO 21 e SCL no GPIO 22 (lado de 3,3 V). Com a bateria CR2032 |
| **Módulo de relés** (optoacoplado) | VCC no 5 V, GND, IN1 no GPIO 26. A bomba passa pelo contato **NF** (normalmente fechado) do relé 1 |

Por que o ADS1115 no 5 V: a saída do PH-4502C e a do sensor de pressão passam de 3,3 V. Alimentado em 5 V, o ADS1115 lê até 5 V nas entradas, mas o I2C dele também fica em 5 V, que o ESP32 não tolera: daí o conversor de nível entre os dois.

**Alimentação.** Uma fonte de 5 V e pelo menos 2 A para o ESP32 e os sensores, e a fonte de 12 V para a bomba, com os GND ligados entre si. A bomba e a fonte de 12 V ficam do lado do relé, longe do protoboard.

**Água e eletricidade.** Os módulos, o ESP32 e as fontes ficam dentro da caixa de proteção, acima do nível do reservatório, com os cabos descendo até os sensores em laço de gotejamento (uma volta para baixo antes de subir para a caixa), para a água que escorre pelo cabo pingar antes de chegar aos conectores. Use os conectores IP67 nas passagens.

## Proteção da bomba

A boia precisa ficar 2 s na mesma posição para o nó aceitar a leitura, o que filtra a ondulação. Com a solução abaixo da boia, o nó corta a bomba cerca de 7 s depois (2 s de confirmação mais 5 s) e escreve `BOMBA CORTADA` no Monitor Serial; o painel mostra `bomba` em "cortada pela proteção". Quando a solução volta, a bomba religa sozinha cerca de 1 minuto depois (2 s mais 60 s). A proteção funciona mesmo sem rede e antes de o nó acertar a hora. Os motivos da montagem pelo contato NF estão em `decisoes/2026-10-18-bomba-pelo-contato-nf.md`.

Se o programa travar (um defeito não previsto, um sensor que prende o barramento I2C), o cão de guarda do ESP32 reinicia o nó em 15 s, e a proteção volta a funcionar. Uma leitura do ADS1115 que não termina em 25 ms é dada como falha, em vez de esperar para sempre.

Se o seu módulo de relés aciona com o pino em nível alto, ou se a sua boia fecha com a solução abaixo dela, troque `RELE_ACIONA_EM_NIVEL_BAIXO` ou `BOIA_FECHADA_COM_SOLUCAO_ACIMA` no começo do programa.

## Primeiros passos

1. Copie `firmware/credenciais.exemplo.h` para esta pasta com o nome `credenciais.h` e preencha, com `MQTT_USUARIO "horta"`.
2. Instale as bibliotecas: CriaTelemetria (`firmware/biblioteca-cria`), PubSubClient, OneWire, DallasTemperature e Adafruit ADS1X15.
3. **Antes de montar os sensores**, mude `SIMULAR_SENSORES` para `1`, grave e confira no painel se chegam a temperatura, a vazão, a pressão, o nível e a bomba. O pH e a condutividade só aparecem depois de calibrados, e com a simulação dá para ensaiar a ferramenta de calibração. As retas do ensaio ficam num espaço separado da memória (`cria-cal-sim`) e não valem quando o programa volta ao modo normal. Volte para `0` antes de instalar.
4. Monte os sensores, grave com `SIMULAR_SENSORES 0` e abra o Monitor Serial a 115200 baud. As mensagens com `[horta]`, `[cal]` e `[cria]` dizem o que falta: ADS1115 que não responde, DS18B20 sem leitura, sensor ainda não calibrado.
5. Calibre o pH e a condutividade com a ferramenta do notebook (`calibracao/README.md`). Só depois disso essas duas grandezas aparecem no painel.

Placa no Arduino IDE: *DOIT ESP32 DEVKIT V1*. Pela linha de comando:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 --library firmware/biblioteca-cria firmware/horta-no1
```

## Limites conhecidos

- **Pressão.** O sensor de 0 a 1,2 MPa tem erro típico de 1% do fundo de escala, cerca de 12 kPa, que é da ordem da pressão de uma linha de recirculação de bancada. Ele mostra bem se a bomba está empurrando ou não, mas não mede pequenas variações.
- **Condutividade.** A curva do sensor TDS genérico vale até cerca de 2000 µS/cm; a solução de alface fica perto de 1500 µS/cm.
- **pH sem compensação de temperatura.** Entre 20 e 30 °C, o erro por temperatura fica abaixo de 0,02 pH perto de pH 6, bem dentro do critério de ±0,2.
