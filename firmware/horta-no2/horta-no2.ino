// Nó do ambiente da bancada hidropônica (projeto-teste 2): cria/horta/no2.
//
// Grandezas (mqtt/catalogo-topicos.md, seção 4.2):
//   umidade      %, umidade relativa do ar, do DHT22
//   iluminancia  lx, do BH1750 (iluminância, não irradiância: veja o catálogo)
//   temperatura  C, temperatura do ar, do DHT22 (complementar)
//
// Montagem (ESP32 DevKit V1, 30 pinos):
//   DHT22   alimentação no 3,3 V, dado no GPIO 4, resistor de 10 kΩ entre o dado
//           e o 3,3 V (os módulos de 3 pinos já trazem o resistor). Fora da luz
//           direta do painel LED e longe de respingos: o calor do LED e a água
//           falseiam a temperatura e a umidade.
//   BH1750  VCC no 3,3 V, SDA no GPIO 21, SCL no GPIO 22, ADDR solto ou no GND
//           (endereço 0x23). Virado para cima, na altura das folhas.
//
// Antes de compilar: copie firmware/credenciais.exemplo.h para esta pasta com o
// nome credenciais.h e preencha, com MQTT_USUARIO "horta". Bibliotecas: a
// CriaTelemetria (firmware/biblioteca-cria), PubSubClient, "DHT sensor library"
// (Adafruit) e BH1750 (Christopher Laws).

#include <BH1750.h>
#include <CriaTelemetria.h>
#include <DHT.h>
#include <Wire.h>

#if __has_include("credenciais.h")
#include "credenciais.h"
#else
#error "Falta o credenciais.h: copie firmware/credenciais.exemplo.h para a pasta deste sketch com esse nome."
#endif

// ---------------------------------------------------------------------------
// Ajustes deste nó

const uint8_t PINO_DHT = 4;
const uint8_t PINO_SDA = 21;
const uint8_t PINO_SCL = 22;
const uint8_t ENDERECO_BH1750 = 0x23;  // 0x5C com o ADDR no 3,3 V

// ---------------------------------------------------------------------------

CriaNo no("horta", "no2");
DHT dht(PINO_DHT, DHT22);
BH1750 medidorDeLuz(ENDERECO_BH1750);
bool bh1750Presente = false;

void setup() {
  Serial.begin(115200);
  dht.begin();
  Wire.begin(PINO_SDA, PINO_SCL);
  bh1750Presente = medidorDeLuz.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, ENDERECO_BH1750, &Wire);
  if (!bh1750Presente) Serial.println("[horta] ERRO: BH1750 não responde: confira SDA, SCL e a alimentação.");
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  no.manter();
  if (!no.aCada(10000)) return;

  // O DHT22 devolve NaN quando não responde: a biblioteca recusa e avisa.
  no.publicar("umidade", dht.readHumidity(), "%");
  no.publicar("temperatura", dht.readTemperature(), "C");

  if (!bh1750Presente) bh1750Presente = medidorDeLuz.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, ENDERECO_BH1750, &Wire);
  float lux = bh1750Presente ? medidorDeLuz.readLightLevel() : -1;
  // Valor negativo é erro de leitura; 54612 lx é o limite do modo de alta resolução.
  if (lux < 0) {
    Serial.println("[horta] BH1750 sem leitura: confira a fiação.");
    bh1750Presente = false;
  } else {
    no.publicar("iluminancia", lux, "lx");
  }
}
