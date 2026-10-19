// Primeiro nó da rede de telemetria: um DHT22 publicando temperatura e umidade.
//
// É o desafio final da Oficina 4 feito com a biblioteca-padrão: tudo o que não
// é ler o sensor (Wi-Fi, broker, hora, numeração, fila) fica com a CriaTelemetria.
//
// Montagem: DHT22 com o pino de dados no GPIO 4, um resistor de 10 kΩ entre o
// dado e o 3,3 V (pull-up), VCC no 3,3 V e GND no GND.
//
// Passo a passo completo: tutoriais/01-primeiro-no-esp32.md. Em resumo:
//   1. use "Arquivo -> Salvar como" para ter uma cópia editável deste exemplo;
//   2. crie a aba credenciais.h com o conteúdo de firmware/credenciais.exemplo.h
//      e preencha (MQTT_USUARIO e o projeto abaixo devem ser o mesmo, "teste");
//   3. troque "no1" por um nó que ainda não apareça no painel;
//   4. instale as bibliotecas PubSubClient e "DHT sensor library" (Adafruit).

#include <CriaTelemetria.h>
#include <DHT.h>

#if __has_include("credenciais.h")
#include "credenciais.h"
#else
#error "Falta o credenciais.h: copie firmware/credenciais.exemplo.h para a pasta deste sketch com esse nome."
#endif

const int PINO_DHT = 4;

// Troque "no1" por um número livre: dois nós com o mesmo nome se derrubam no broker.
CriaNo no("teste", "no1");
DHT dht(PINO_DHT, DHT22);

void setup() {
  Serial.begin(115200);
  dht.begin();
  no.mostrarPublicacoes(true);  // mostra cada leitura no Monitor Serial
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  no.manter();

  if (no.aCada(10000)) {
    // Se o DHT22 não responder, ele devolve NaN e a biblioteca não publica.
    no.publicar("temperatura", dht.readTemperature(), "C");
    no.publicar("umidade", dht.readHumidity(), "%");
  }
}
