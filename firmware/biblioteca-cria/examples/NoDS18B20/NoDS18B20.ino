// Nó com um DS18B20: a temperatura publicada pelo Wi-Fi a cada 10 s.
//
// A calibração do sensor fica guardada no próprio nó. O DS18B20 sai de fábrica
// com erro de até 0,5 °C; para corrigir o zero contra um termômetro de
// referência, ligue o nó no notebook pela USB e rode:
//
//   py calibracao/calibrar.py --porta COM5 temperatura
//
// Montagem: DS18B20 com o fio vermelho no 3,3 V, o preto no GND e o amarelo
// (dado) no GPIO 4, com um resistor de 4,7 kΩ entre o amarelo e o 3,3 V.
//
// Passo a passo completo: tutoriais/02-guia-completo.md. Em resumo:
//   1. use "Arquivo -> Salvar como" para ter uma cópia editável deste exemplo;
//   2. crie a aba credenciais.h com o conteúdo de firmware/credenciais.exemplo.h
//      e preencha (MQTT_USUARIO e o projeto abaixo devem ser o mesmo, "teste");
//   3. troque "no1" por um nó que ainda não apareça no painel;
//   4. instale as bibliotecas PubSubClient, OneWire e DallasTemperature.

#include <CriaTelemetria.h>
#include <DallasTemperature.h>
#include <OneWire.h>

#if __has_include("credenciais.h")
#include "credenciais.h"
#else
#error "Falta o credenciais.h: copie firmware/credenciais.exemplo.h para a pasta deste sketch com esse nome."
#endif

const int PINO_DS18B20 = 4;

// Troque "no1" por um número livre: dois nós com o mesmo nome se derrubam no broker.
CriaNo no("teste", "no1");
CriaCalibracao calibracao(no);
OneWire umFio(PINO_DS18B20);
DallasTemperature ds18b20(&umFio);

// Temperatura medida agora, em °C, antes da calibração. NAN se o sensor falhar.
double temperaturaBruta() {
  ds18b20.requestTemperatures();  // cerca de 750 ms
  float t = ds18b20.getTempCByIndex(0);
  // -127 °C: sensor desconectado. 85 °C: valor de partida, antes da primeira conversão.
  if (t == DEVICE_DISCONNECTED_C || t == 85.0) return NAN;
  return t;
}

void setup() {
  Serial.begin(115200);
  ds18b20.begin();
  // Até a calibração vale a reta da folha de dados: medida = 1 x bruto + 0.
  calibracao.sensor("temperatura", "C", temperaturaBruta, 1.0, 0.0, false);
  calibracao.iniciar();
  no.mostrarPublicacoes(true);  // mostra cada leitura no Monitor Serial
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  calibracao.atender();  // comandos da ferramenta de calibração, pela USB
  no.manter();
  if (no.aCada(10000)) {
    double temperatura = calibracao.ler("temperatura");
    if (isnan(temperatura)) {
      Serial.println("[ds18b20] sem leitura: confira a fiação e o resistor de 4,7 kΩ.");
    } else {
      no.publicar("temperatura", temperatura, "C");
    }
  }
}
