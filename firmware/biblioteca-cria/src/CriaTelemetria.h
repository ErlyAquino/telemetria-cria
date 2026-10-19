// Biblioteca-padrão dos nós ESP32 da Rede de Telemetria do Espaço CRIA.
//
// Com ela, um nó novo só precisa ler o próprio sensor e chamar publicar(): a
// biblioteca cuida do Wi-Fi, do broker MQTT, da hora certa, da numeração das
// leituras e da fila na memória flash. As regras seguem o catálogo de tópicos
// (mqtt/catalogo-topicos.md).
//
//   #include <CriaTelemetria.h>
//   #include "credenciais.h"
//
//   CriaNo no("teste", "no1");   // publica em cria/teste/no1/...
//
//   void setup() {
//     Serial.begin(115200);
//     no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
//   }
//
//   void loop() {
//     no.manter();
//     if (no.aCada(10000)) no.publicar("temperatura", lerTemperatura(), "C");
//   }

#pragma once

#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <Wire.h>

class CriaNo {
 public:
  // projeto e no seguem o catálogo: ex. ("horta", "no1").
  CriaNo(const char* projeto, const char* no);

  // Liga o Wi-Fi, o MQTT, o relógio e a fila. Chame uma vez, no setup().
  // usuarioMqtt precisa ser igual ao projeto (seção 6 do catálogo).
  void iniciar(const char* ssid, const char* senhaWifi, const char* hostMqtt, uint16_t portaMqtt,
               const char* usuarioMqtt, const char* senhaMqtt);

  // Mantém tudo funcionando: reconecta o que caiu e esvazia a fila aos poucos.
  // Chame em todo loop(), sem delay() longo no meio.
  void manter();

  // Verdadeiro uma vez a cada "intervaloMs" (o padrão do catálogo é 10000), e só
  // depois de o relógio estar certo. Use um só aCada por programa.
  bool aCada(uint32_t intervaloMs);

  // Publica uma leitura em cria/{projeto}/{no}/{grandeza}. Sem conexão, guarda a
  // leitura na fila da memória flash, para reenviar quando a conexão voltar.
  // Devolve falso quando a leitura é recusada: valor inválido (NaN ou infinito),
  // nome ou unidade fora do catálogo, relógio ainda sem hora, ou fila cheia.
  bool publicar(const char* grandeza, double valor, const char* unidade);

  // O relógio já foi acertado pelo servidor de hora?
  bool temHora() const;
  // Está conectado ao broker?
  bool conectado();
  // Quantas vezes este nó já ligou (vai em toda mensagem como "boot").
  uint32_t boot() const { return _boot; }
  // Leituras esperando na fila.
  uint32_t leiturasNaFila() const { return _linhasNaFila; }
  // Mostra no Monitor Serial cada leitura publicada (padrão: desligado).
  void mostrarPublicacoes(bool mostrar) { _mostrarPublicacoes = mostrar; }
  // Servidor de hora (NTP). Padrão: o próprio broker, que é o servidor da escola.
  // Chame antes de iniciar().
  void usarServidorDeHora(const char* host) { _servidorDeHora = host; }
  // Usa o RTC DS3231 (relógio com bateria) do barramento I2C: depois de um corte
  // de energia sem rede, o nó volta a medir com a hora dele, e cada acerto pelo
  // servidor corrige o DS3231. Chame antes de iniciar(), com o Wire já ligado
  // (Wire.begin(21, 22)).
  void usarRelogioDS3231(TwoWire& barramento = Wire) { _relogio = &barramento; }
  // Intervalo do keepalive do MQTT, em segundos (padrão: 5). Um nó que passa
  // muito tempo sem chamar manter(), como a câmera enviando uma foto, precisa de
  // um intervalo maior, senão a conexão cai a cada envio. Chame antes de iniciar().
  void usarKeepAlive(uint16_t segundos) { _keepAlive = segundos; }

  // Projeto e nó, como no catálogo: ("horta", "no1").
  const String& projeto() const { return _projeto; }
  const String& nome() const { return _no; }

 private:
  void cuidarDoWifi(uint32_t agora);
  void conectarMqtt();
  void derrubarConexao(const char* motivo);
  bool guardarNaFila(const char* topico, const char* mensagem);
  void esvaziarFila(uint8_t maximo);
  void contarFila();
  void avisar(const char* mensagem);
  void acertarPeloDS3231();
  void corrigirDS3231();

  String _projeto;
  String _no;
  String _servidorDeHora;
  String _usuarioMqtt;
  String _senhaMqtt;
  String _topicoStatus;
  String _idDoCliente;
  bool _nomesValidos = false;
  bool _iniciado = false;

  WiFiClient _wifi;
  PubSubClient _mqtt;

  uint32_t _boot = 0;
  uint32_t _seq = 0;

  bool _filaDisponivel = false;
  uint32_t _linhasNaFila = 0;
  size_t _posicaoNaFila = 0;  // até onde a fila já foi reenviada

  bool _wifiConectado = false;
  uint32_t _semWifiDesde = 0;
  uint32_t _ultimaTentativaWifi = 0;
  bool _mqttConectado = false;
  uint32_t _conectadoAoBrokerEm = 0;
  uint8_t _quedasRapidas = 0;
  bool _jaTentouMqtt = false;
  uint32_t _fimDaUltimaTentativaMqtt = 0;
  uint32_t _ultimoDisparo = 0;
  bool _jaDisparou = false;
  bool _avisouHoraCerta = false;
  bool _jaAvisou = false;
  uint32_t _ultimoAviso = 0;
  bool _mostrarPublicacoes = false;
  TwoWire* _relogio = nullptr;  // DS3231, quando o nó tem um
  uint16_t _keepAlive = 5;
};

// Calibração dos sensores (opcional): CriaCalibracao calibracao(no);
#include "CriaCalibracao.h"
