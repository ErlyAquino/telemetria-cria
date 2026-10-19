// Placa ligada ao gateway pela USB: o caminho das placas Arduino legadas.
//
// A placa não tem rede. Ela escreve na USB uma linha JSON por leitura, e o
// gateway (gateway/gateway.py), no computador ao lado, acrescenta o projeto, a
// hora e o boot e envia tudo ao servidor (mqtt/catalogo-topicos.md, seção 2):
//
//   {"no":"no1","grandeza":"temperatura","valor":27.44,"unidade":"C","seq":12}
//
// O exemplo lê um DS18B20 (temperatura) a cada 10 s. Para outro sensor, troque
// a leitura em loop() e chame publicar() uma vez por grandeza.
//
// Montagem do DS18B20: vermelho no 5 V (Uno) ou 3,3 V (ESP32); preto no GND;
// amarelo (dados) no pino 2 (Uno) ou no GPIO 4 (ESP32), com um resistor de
// 4,7 kΩ entre o dado e a alimentação.
//
// Compila para o Arduino Uno e para o ESP32. Bibliotecas: OneWire e
// DallasTemperature. Monitor Serial e gateway a 115200 baud.

#include <DallasTemperature.h>
#include <OneWire.h>

// Nome deste nó no catálogo. O projeto fica no .env do gateway. Cada placa do
// projeto precisa de um nó só seu: confira no catálogo (mqtt/catalogo-topicos.md)
// e no painel quais nós já existem e escolha um livre. Dois programas com o
// mesmo NO misturam as leituras e o seq, e a perda medida sai errada.
const char* NO = "no1";

#if defined(ARDUINO_ARCH_ESP32)
const uint8_t PINO_DS18B20 = 4;
#else
const uint8_t PINO_DS18B20 = 2;
#endif

const unsigned long INTERVALO_MS = 10000;  // o padrão do catálogo

OneWire barramento(PINO_DS18B20);
DallasTemperature ds18b20(&barramento);

unsigned long seq = 0;            // número da leitura; recomeça em 1 quando a placa liga
unsigned long ultimaLeitura = 0;
bool jaLeu = false;

// Escreve uma leitura em uma linha JSON. Leitura com falha não sai e não recebe seq.
// No Uno, Serial.print escreve "ovf" para valores acima de 4,29 bilhões, o que
// quebraria o JSON: por isso o limite de 4e9.
void publicar(const char* grandeza, float valor, uint8_t casas, const char* unidade) {
  if (isnan(valor) || isinf(valor) || fabs(valor) > 4.0e9) return;
  seq++;
  Serial.print(F("{\"no\":\""));
  Serial.print(NO);
  Serial.print(F("\",\"grandeza\":\""));
  Serial.print(grandeza);
  Serial.print(F("\",\"valor\":"));
  Serial.print(valor, casas);
  Serial.print(F(",\"unidade\":\""));
  Serial.print(unidade);
  Serial.print(F("\",\"seq\":"));
  Serial.print(seq);
  Serial.println(F("}"));
}

void setup() {
  Serial.begin(115200);
  ds18b20.begin();
  // Mensagem para quem abrir o Monitor Serial. Linhas sem "{" não são leituras:
  // o gateway só as mostra no terminal, como "placa: telemetria: no1".
  Serial.print(F("telemetria: "));
  Serial.println(NO);
}

void loop() {
  if (jaLeu && millis() - ultimaLeitura < INTERVALO_MS) return;
  jaLeu = true;
  ultimaLeitura = millis();

  ds18b20.requestTemperatures();
  float temperatura = ds18b20.getTempCByIndex(0);
  // -127 °C: sensor desconectado. 85 °C: valor de partida do DS18B20, antes da
  // primeira conversão. Os dois são falha, não medida.
  if (temperatura == DEVICE_DISCONNECTED_C || temperatura == 85.0) {
    Serial.println(F("DS18B20 sem leitura valida: confira a fiacao e o resistor de 4,7 kOhm."));
    return;
  }
  publicar("temperatura", temperatura, 2, "C");
}
