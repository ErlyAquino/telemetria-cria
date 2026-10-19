// Nó do monitor de qualidade do ar (projeto-teste 1): cria/ar/no1.
//
// Grandezas (mqtt/catalogo-topicos.md, seção 4.1):
//   mq2, mq135   leitura relativa Rs/R0 dos sensores de óxido metálico
//   co2          ppm, do MH-Z19B (infravermelho não dispersivo)
//   temperatura, umidade   do DHT22, opcional (ajuda a interpretar os MQ)
//
// Montagem (ESP32 DevKit V1, 30 pinos):
//   MQ-2   saída AO -> divisor de tensão -> GPIO 34
//   MQ-135 saída AO -> divisor de tensão -> GPIO 35
//          Os MQ são alimentados em 5 V e a saída pode passar de 3,3 V, que o
//          ESP32 não tolera. Divisor: 100 kΩ da saída AO até o pino e 200 kΩ do
//          pino até o GND, com um capacitor de 100 nF do pino ao GND. O pino
//          recebe 2/3 da tensão do sensor. Resistores altos carregam pouco o
//          sensor; o capacitor estabiliza a leitura do ADC.
//   MH-Z19B alimentado em 5 V; TX do sensor -> GPIO 16 (RX2); RX do sensor -> GPIO 17 (TX2).
//   DHT22  dado no GPIO 4, com resistor de 10 kΩ para o 3,3 V.
//   GPIO 21 e 22 ficam livres para o barramento I2C, como manda o projeto.
//
// Alimentação: os dois aquecedores dos MQ (cerca de 150 mA cada), o MH-Z19B
// (picos de 150 mA) e o ESP32 transmitindo passam de 0,6 A, mais do que uma
// porta USB fornece. Use uma fonte de 5 V com pelo menos 2 A, com o GND comum
// a todos. Meça a tensão que chega aos MQ e escreva em TENSAO_DOS_MQ.
//
// Antes de compilar: copie firmware/credenciais.exemplo.h para esta pasta com o
// nome credenciais.h e preencha, com MQTT_USUARIO "ar". Bibliotecas: a
// CriaTelemetria (firmware/biblioteca-cria), PubSubClient e, se usar o DHT22,
// "DHT sensor library" (Adafruit).

#include <CriaTelemetria.h>

#if __has_include("credenciais.h")
#include "credenciais.h"
#else
#error "Falta o credenciais.h: copie firmware/credenciais.exemplo.h para a pasta deste sketch com esse nome."
#endif

// ---------------------------------------------------------------------------
// Ajustes deste nó

#define USAR_DHT22 1  // 0 se o DHT22 não estiver montado

const int PINO_MQ2 = 34;
const int PINO_MQ135 = 35;
const int PINO_CO2_RX = 16;  // recebe do TX do MH-Z19B
const int PINO_CO2_TX = 17;  // envia ao RX do MH-Z19B
const int PINO_DHT = 4;

// Divisor de tensão na saída dos MQ, em kΩ.
const float DIVISOR_SUPERIOR_KOHM = 100.0;  // da saída AO até o pino
const float DIVISOR_INFERIOR_KOHM = 200.0;  // do pino até o GND
// Tensão que chega aos MQ, medida com o multímetro.
const float TENSAO_DOS_MQ = 5.0;

// Resistor de carga (RL) soldado no módulo de cada MQ, em kΩ. Confira na placa:
// "102" é 1 kΩ, "103" é 10 kΩ. Com 1 kΩ, a tensão de ar limpo costuma ficar
// baixa demais para o ADC do ESP32: meça a saída AO em ar limpo, depois do
// aquecimento; se o pino receber menos de 0,3 V, troque o RL do módulo por
// 10 kΩ ou 20 kΩ e escreva o valor novo aqui.
const float RL_MQ2_KOHM = 1.0;
const float RL_MQ135_KOHM = 1.0;

// R0: resistência de cada sensor em ar limpo, medida por este nó (seção 4.1 do
// catálogo). Enquanto valer 0, o nó só mostra o Rs no Monitor Serial e não
// publica o MQ. Para calibrar: com o sensor já estabilizado (24 a 48 h ligado
// na primeira vez, ou depois de muito tempo guardado), leve o nó a um lugar
// arejado, anote a média dos Rs mostrados por uns 10 minutos, escreva aqui e
// registre a calibração em calibracao/ (data, local, valores).
const float R0_MQ2_KOHM = 0.0;
const float R0_MQ135_KOHM = 0.0;

// Faixa do MH-Z19B configurada de fábrica (há modelos de 2000 e de 5000 ppm).
// A autocalibração de linha de base (ABC) vem ligada de fábrica; a decisão de
// mantê-la ou não deve ficar registrada em calibracao/.
const int FAIXA_CO2_PPM = 5000;

// Tempo ligado antes da primeira leitura válida de cada sensor.
const uint32_t PREAQUECIMENTO_CO2_MS = 3UL * 60 * 1000;  // folha de dados do MH-Z19B
const uint32_t PREAQUECIMENTO_MQ_MS = 10UL * 60 * 1000;  // aquecimento do dia a dia

// Faixa em que o ADC do ESP32 lê com confiança (atenuação de 11 dB). Abaixo de
// uns 150 mV ele não distingue os valores; acima de 2450 mV perde a linearidade.
const uint32_t MENOR_TENSAO_NO_PINO_MV = 150;
const uint32_t MAIOR_TENSAO_NO_PINO_MV = 2450;

// ---------------------------------------------------------------------------

CriaNo no("ar", "no1");

#if USAR_DHT22
#include <DHT.h>
DHT dht(PINO_DHT, DHT22);
#endif

bool co2Aquecido = false;
bool mqAquecidos = false;

// Resistência do sensor MQ (Rs), em kΩ, a partir da tensão no pino do ESP32.
// Devolve NaN se a tensão estiver fora da faixa confiável do ADC: sensor
// desligado, fio solto ou RL inadequado. Leitura com falha não é publicada.
float resistenciaDoMq(int pino, float rlKohm) {
  uint32_t soma = 0;
  const int AMOSTRAS = 16;  // média de várias leituras: o ADC do ESP32 é ruidoso
  for (int i = 0; i < AMOSTRAS; i++) soma += analogReadMilliVolts(pino);
  uint32_t milivoltsNoPino = soma / AMOSTRAS;
  if (milivoltsNoPino < MENOR_TENSAO_NO_PINO_MV || milivoltsNoPino > MAIOR_TENSAO_NO_PINO_MV) return NAN;

  float fator = (DIVISOR_SUPERIOR_KOHM + DIVISOR_INFERIOR_KOHM) / DIVISOR_INFERIOR_KOHM;
  float tensaoNoSensor = milivoltsNoPino / 1000.0 * fator;
  if (tensaoNoSensor >= TENSAO_DOS_MQ) return NAN;
  // O divisor fica em paralelo com o RL: a carga real do sensor é a dos dois juntos.
  float cargaDoDivisor = DIVISOR_SUPERIOR_KOHM + DIVISOR_INFERIOR_KOHM;
  float cargaKohm = rlKohm * cargaDoDivisor / (rlKohm + cargaDoDivisor);
  return cargaKohm * (TENSAO_DOS_MQ - tensaoNoSensor) / tensaoNoSensor;
}

// Pede a concentração de CO2 ao MH-Z19B pela serial (comando 0x86 da folha de
// dados). Devolve -1 se não houver resposta ou se o checksum não conferir.
int lerCo2() {
  const uint8_t pedido[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};
  while (Serial2.available()) Serial2.read();  // descarta restos
  Serial2.write(pedido, sizeof(pedido));
  uint8_t resposta[9];
  if (Serial2.readBytes(resposta, sizeof(resposta)) != sizeof(resposta)) return -1;
  if (resposta[0] != 0xFF || resposta[1] != 0x86) return -1;
  uint8_t soma = 0;
  for (int i = 1; i < 8; i++) soma += resposta[i];
  if ((uint8_t)(0xFF - soma + 1) != resposta[8]) return -1;
  return resposta[2] * 256 + resposta[3];
}

// Publica a razão Rs/R0 de um MQ, ou mostra o Rs enquanto o R0 não for calibrado.
void publicarMq(const char* grandeza, const char* nome, float rs, float r0) {
  if (isnan(rs)) {
    Serial.printf("[ar] %s: tensão fora da faixa do ADC (sensor desligado ou RL inadequado), não publicado.\n", nome);
  } else if (r0 > 0) {
    no.publicar(grandeza, rs / r0, "Rs/R0");
  } else {
    Serial.printf("[ar] %s: Rs = %.2f kΩ (R0 ainda não calibrado: nada publicado)\n", nome, rs);
  }
}

void setup() {
  Serial.begin(115200);
  analogSetPinAttenuation(PINO_MQ2, ADC_11db);
  analogSetPinAttenuation(PINO_MQ135, ADC_11db);
  Serial2.begin(9600, SERIAL_8N1, PINO_CO2_RX, PINO_CO2_TX);
  Serial2.setTimeout(200);
#if USAR_DHT22
  dht.begin();
#endif
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  no.manter();
  if (!no.aCada(10000)) return;

#if USAR_DHT22
  no.publicar("temperatura", dht.readTemperature(), "C");
  no.publicar("umidade", dht.readHumidity(), "%");
#endif

  // Durante o pré-aquecimento, o sensor dá número, não medida: nada é publicado.
  // As marcas ficam verdadeiras para sempre, mesmo quando o millis() der a volta.
  if (millis() >= PREAQUECIMENTO_CO2_MS) co2Aquecido = true;
  if (millis() >= PREAQUECIMENTO_MQ_MS) mqAquecidos = true;

  if (co2Aquecido) {
    int co2 = lerCo2();
    if (co2 > 0 && co2 <= FAIXA_CO2_PPM) {
      no.publicar("co2", co2, "ppm");
    } else {
      Serial.printf("[ar] MH-Z19B: sem resposta ou valor fora da faixa (%d), CO2 não publicado.\n", co2);
    }
  }

  if (mqAquecidos) {
    publicarMq("mq2", "MQ-2", resistenciaDoMq(PINO_MQ2, RL_MQ2_KOHM), R0_MQ2_KOHM);
    publicarMq("mq135", "MQ-135", resistenciaDoMq(PINO_MQ135, RL_MQ135_KOHM), R0_MQ135_KOHM);
  } else {
    Serial.printf("[ar] pré-aquecendo os sensores MQ: faltam %lu s\n",
                  (unsigned long)((PREAQUECIMENTO_MQ_MS - millis()) / 1000));
  }
}
