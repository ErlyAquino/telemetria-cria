#include "CriaTelemetria.h"

#include <LittleFS.h>
#include <Preferences.h>
#include <esp_sntp.h>
#include <math.h>
#include <sys/time.h>
#include <time.h>

#include "CriaFormato.h"

// Antes de 01/01/2020 o relógio certamente não foi acertado.
static const time_t MENOR_HORA_ACEITA = 1577836800;

// Fila na memória flash: uma leitura por linha, "tópico<TAB>mensagem".
static const char* ARQUIVO_DA_FILA = "/fila.txt";
// Até 600 KB esperando envio: cerca de 6000 leituras, mais de 2 h de um nó com
// 6 grandezas a cada 10 s. O arquivo inteiro nunca passa de 1 MB.
static const size_t MAXIMO_ESPERANDO_ENVIO = 600 * 1024;
static const size_t MAXIMO_DO_ARQUIVO = 1024 * 1024;
// Leituras da fila reenviadas por volta do loop, para não travar o programa.
static const uint8_t LEITURAS_DA_FILA_POR_VOLTA = 20;

// keepalive de 5 s: se o servidor sumir sem avisar (desligado, cabo solto), o
// nó percebe em 5 a 10 s e passa a guardar as leituras na fila. O broker, por
// sua vez, publica o "offline" (LWT) em até cerca de 8 s (seção 3 do catálogo).
static const uint16_t KEEPALIVE_S = 5;
static const uint32_t INTERVALO_ENTRE_TENTATIVAS_MQTT = 5000;
static const uint32_t TEMPO_PARA_DESISTIR_DO_TCP_MS = 1500;
// Sem Wi-Fi por este tempo, o nó pede uma nova conexão (o ESP32 não tenta
// sozinho depois de alguns erros, como senha recusada pelo ponto de acesso).
static const uint32_t TEMPO_SEM_WIFI_ATE_RECONECTAR = 30000;
// A hora é conferida com o servidor a cada 15 min (padrão do ESP32: 3 h).
static const uint32_t INTERVALO_DO_NTP_MS = 15UL * 60 * 1000;
// Estados de espera (sem Wi-Fi, sem broker, sem hora) são repetidos no Monitor
// Serial a cada 30 s, para quem abrir o monitor depois ver o que acontece.
static const uint32_t INTERVALO_ENTRE_AVISOS = 30000;
// Conexão que cai menos de 15 s depois de abrir, três vezes seguidas, quase
// sempre é outro nó usando o mesmo nome e derrubando este no broker.
static const uint32_t QUEDA_RAPIDA_MS = 15000;
static const uint8_t QUEDAS_RAPIDAS_ATE_AVISAR = 3;

static int64_t agoraEmMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static const char* explicarWifi(wl_status_t estado) {
  switch (estado) {
    case WL_NO_SSID_AVAIL:
      return "rede não encontrada (confira o WIFI_SSID e se o ponto de acesso está ligado)";
    case WL_CONNECT_FAILED:
      return "o ponto de acesso recusou a conexão (confira a WIFI_SENHA)";
    case WL_CONNECTION_LOST:
      return "conexão perdida";
    default:
      return "conectando";
  }
}

CriaNo::CriaNo(const char* projeto, const char* no) : _projeto(projeto), _no(no), _mqtt(_wifi) {
  _nomesValidos = cria::nomeValido(projeto) && strcmp(projeto, "servidor") != 0 && cria::noValido(no);
}

void CriaNo::iniciar(const char* ssid, const char* senhaWifi, const char* hostMqtt, uint16_t portaMqtt,
                     const char* usuarioMqtt, const char* senhaMqtt) {
  Serial.printf("\n[cria] nó cria/%s/%s, biblioteca CriaTelemetria 0.1.0\n", _projeto.c_str(), _no.c_str());
  if (!_nomesValidos) {
    Serial.println("[cria] ERRO: projeto ou nó fora das regras do catálogo (veja mqtt/catalogo-topicos.md).");
    Serial.println("[cria]       Exemplo certo: CriaNo no(\"horta\", \"no1\");  Nada será publicado.");
    return;
  }
  if (strcmp(usuarioMqtt, _projeto.c_str()) != 0) {
    Serial.printf("[cria] ERRO: MQTT_USUARIO é \"%s\", mas o projeto é \"%s\". Eles precisam ser iguais\n",
                  usuarioMqtt, _projeto.c_str());
    Serial.println("[cria]       (seção 6 do catálogo). Corrija o credenciais.h. Nada será publicado.");
    return;
  }

  // boot: quantas vezes o nó já ligou, guardado na memória não volátil.
  Preferences memoria;
  if (memoria.begin("cria", false)) {
    _boot = memoria.getUInt("boot", 0) + 1;
    if (memoria.putUInt("boot", _boot) == 0) Serial.println("[cria] AVISO: não foi possível gravar o boot.");
    memoria.end();
  } else {
    _boot = 1;
    Serial.println("[cria] AVISO: memória não volátil indisponível; o boot fica sempre 1.");
  }
  Serial.printf("[cria] boot %u\n", (unsigned)_boot);

  // Fila na memória flash. "true" formata a partição na primeira vez.
  _filaDisponivel = LittleFS.begin(true);
  if (_filaDisponivel) {
    contarFila();
    if (_linhasNaFila > 0) Serial.printf("[cria] %u leituras na fila, de antes de ligar\n", (unsigned)_linhasNaFila);
  } else {
    Serial.println("[cria] AVISO: sem LittleFS; leituras feitas sem conexão serão perdidas.");
  }

  // Wi-Fi. O modo de economia de energia fica desligado: o nó é ligado na
  // tomada, e a economia atrasa as mensagens e o relógio.
  String nomeNaRede = "cria-" + _projeto + "-" + _no;
  WiFi.setHostname(nomeNaRede.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, senhaWifi);
  _semWifiDesde = millis();
  Serial.printf("[cria] aguardando o Wi-Fi \"%s\"...\n", ssid);

  // Hora: o servidor da escola fornece a hora (NTP) mesmo sem internet.
  if (_servidorDeHora.length() == 0) _servidorDeHora = hostMqtt;
  sntp_set_sync_interval(INTERVALO_DO_NTP_MS);
  configTime(0, 0, _servidorDeHora.c_str());

  // MQTT. O LWT faz o broker publicar "offline" se o nó cair sem avisar.
  _usuarioMqtt = usuarioMqtt;
  _senhaMqtt = senhaMqtt;
  _topicoStatus = "cria/" + _projeto + "/" + _no + "/status";
  _idDoCliente = nomeNaRede;
  _wifi.setConnectionTimeout(TEMPO_PARA_DESISTIR_DO_TCP_MS);
  _mqtt.setServer(hostMqtt, portaMqtt);
  _mqtt.setBufferSize(512);
  _mqtt.setKeepAlive(KEEPALIVE_S);
  _mqtt.setSocketTimeout(5);
  _iniciado = true;
}

// Escreve um aviso no Monitor Serial no máximo a cada INTERVALO_ENTRE_AVISOS.
void CriaNo::avisar(const char* mensagem) {
  uint32_t agora = millis();
  if (_jaAvisou && agora - _ultimoAviso < INTERVALO_ENTRE_AVISOS) return;
  _jaAvisou = true;
  _ultimoAviso = agora;
  Serial.printf("[cria] %s\n", mensagem);
}

void CriaNo::cuidarDoWifi(uint32_t agora) {
  if (WiFi.status() == WL_CONNECTED) {
    if (!_wifiConectado) {
      _wifiConectado = true;
      Serial.printf("[cria] Wi-Fi conectado, IP %s\n", WiFi.localIP().toString().c_str());
      // Sem hora ainda: pede ao servidor agora, sem esperar a próxima tentativa.
      if (!temHora()) sntp_restart();
    }
    return;
  }
  if (_wifiConectado) {
    _wifiConectado = false;
    _semWifiDesde = agora;
    Serial.println("[cria] Wi-Fi caiu; as leituras vão para a fila até a rede voltar.");
  }
  if (agora - _semWifiDesde >= TEMPO_SEM_WIFI_ATE_RECONECTAR &&
      agora - _ultimaTentativaWifi >= TEMPO_SEM_WIFI_ATE_RECONECTAR) {
    _ultimaTentativaWifi = agora;
    WiFi.reconnect();
  }
  char aviso[160];
  snprintf(aviso, sizeof(aviso), "sem Wi-Fi: %s.", explicarWifi(WiFi.status()));
  avisar(aviso);
}

void CriaNo::manter() {
  if (!_iniciado) return;
  uint32_t agora = millis();

  if (temHora() && !_avisouHoraCerta) {
    time_t segundos = time(nullptr);
    struct tm utc;
    gmtime_r(&segundos, &utc);
    Serial.printf("[cria] relógio acertado: %04d-%02d-%02d %02d:%02d:%02d UTC\n", utc.tm_year + 1900,
                  utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec);
    _avisouHoraCerta = true;
  }

  cuidarDoWifi(agora);
  if (!_wifiConectado) return;

  // A conexão com o broker caiu desde a última volta?
  if (_mqttConectado && !_mqtt.connected()) {
    _mqttConectado = false;
    _quedasRapidas = (agora - _conectadoAoBrokerEm < QUEDA_RAPIDA_MS) ? _quedasRapidas + 1 : 0;
    Serial.println("[cria] conexão com o broker caiu; as leituras vão para a fila.");
    if (_quedasRapidas >= QUEDAS_RAPIDAS_ATE_AVISAR) {
      Serial.printf("[cria] AVISO: a conexão cai logo depois de abrir. Outro nó pode estar usando o mesmo\n"
                    "[cria]        nome, cria/%s/%s: confira o número do nó no painel.\n",
                    _projeto.c_str(), _no.c_str());
    }
  }

  if (!_mqtt.connected()) {
    // O intervalo conta do fim da última tentativa, que pode demorar alguns segundos.
    if (!_jaTentouMqtt || agora - _fimDaUltimaTentativaMqtt >= INTERVALO_ENTRE_TENTATIVAS_MQTT) {
      conectarMqtt();
      _jaTentouMqtt = true;
      _fimDaUltimaTentativaMqtt = millis();
    }
    return;
  }

  _mqtt.loop();
  // loop() pode ter acabado de perceber a queda: confere de novo antes da fila.
  if (_mqtt.connected()) esvaziarFila(LEITURAS_DA_FILA_POR_VOLTA);
}

void CriaNo::conectarMqtt() {
  // Registra o LWT: "offline", com retain, publicado pelo broker se o nó sumir.
  bool ok = _mqtt.connect(_idDoCliente.c_str(), _usuarioMqtt.c_str(), _senhaMqtt.c_str(), _topicoStatus.c_str(),
                          1, true, "offline");
  if (!ok) {
    int estado = _mqtt.state();
    const char* motivo =
        estado == 4 || estado == 5
            ? "usuário ou senha recusados (confira MQTT_USUARIO e MQTT_SENHA no credenciais.h)"
        : estado == -2 ? "servidor não respondeu (confira o MQTT_HOST, se o broker está ligado e a porta 1883)"
                       : "falha de conexão";
    char aviso[200];
    snprintf(aviso, sizeof(aviso), "broker MQTT: %s, código %d. Tentando de novo a cada 5 s.", motivo, estado);
    avisar(aviso);
    return;
  }
  _mqtt.publish(_topicoStatus.c_str(), "online", true);
  _mqttConectado = true;
  _conectadoAoBrokerEm = millis();
  Serial.printf("[cria] conectado ao broker; status online em %s\n", _topicoStatus.c_str());
}

// Fecha o socket sem avisar o broker: assim ele publica o LWT, e o próximo
// manter() reconecta. Usado quando um envio falha com a conexão "aberta", que é
// o sinal de que ela morreu sem o ESP32 perceber.
void CriaNo::derrubarConexao(const char* motivo) {
  Serial.printf("[cria] %s: refazendo a conexão com o broker.\n", motivo);
  _wifi.stop();
}

bool CriaNo::conectado() {
  return _mqtt.connected();
}

bool CriaNo::temHora() const {
  return time(nullptr) > MENOR_HORA_ACEITA;
}

bool CriaNo::aCada(uint32_t intervaloMs) {
  if (!_iniciado) return false;
  if (!temHora()) {
    if (_wifiConectado) {
      avisar("esperando a hora do servidor para começar a medir (confira o chrony e a porta 123/udp do servidor).");
    }
    return false;
  }
  uint32_t agora = millis();
  if (_jaDisparou && agora - _ultimoDisparo < intervaloMs) return false;
  _jaDisparou = true;
  _ultimoDisparo = agora;
  return true;
}

bool CriaNo::publicar(const char* grandeza, double valor, const char* unidade) {
  if (!_iniciado) return false;
  if (!cria::grandezaValida(grandeza)) {
    Serial.printf("[cria] grandeza \"%s\" fora das regras do catálogo: leitura não publicada.\n", grandeza);
    return false;
  }
  if (!cria::unidadeValida(unidade)) {
    Serial.printf("[cria] unidade \"%s\" fora das regras do catálogo: leitura não publicada.\n", unidade);
    return false;
  }
  // Leitura com falha não é publicada e não recebe seq (seção 2 do catálogo).
  if (isnan(valor) || isinf(valor)) {
    Serial.printf("[cria] %s: leitura com falha (NaN ou infinito), não publicada.\n", grandeza);
    return false;
  }
  if (!temHora()) return false;

  // O seq é dado aqui, na leitura, antes de saber se ela vai sair.
  uint32_t seq = ++_seq;
  char topico[96];
  snprintf(topico, sizeof(topico), "cria/%s/%s/%s", _projeto.c_str(), _no.c_str(), grandeza);
  char mensagem[160];
  if (cria::montarMensagem(mensagem, sizeof(mensagem), valor, unidade, seq, _boot, agoraEmMs()) == 0) return false;

  if (_mqtt.connected()) {
    if (_mqtt.publish(topico, mensagem)) {
      if (_mostrarPublicacoes) Serial.printf("[cria] %s %s\n", topico, mensagem);
      return true;
    }
    derrubarConexao("envio falhou");
  }
  return guardarNaFila(topico, mensagem);
}

bool CriaNo::guardarNaFila(const char* topico, const char* mensagem) {
  if (!_filaDisponivel) return false;
  File arquivo = LittleFS.open(ARQUIVO_DA_FILA, FILE_APPEND);
  if (!arquivo) return false;
  // Conta o que ainda falta enviar, e não o que já foi reenviado.
  size_t tamanho = arquivo.size();
  size_t esperandoEnvio = tamanho > _posicaoNaFila ? tamanho - _posicaoNaFila : 0;
  if (esperandoEnvio >= MAXIMO_ESPERANDO_ENVIO || tamanho >= MAXIMO_DO_ARQUIVO) {
    arquivo.close();
    // A leitura já recebeu seq: a perda aparece como lacuna, como deve ser.
    avisar("fila cheia: leituras novas estão sendo descartadas até a conexão voltar.");
    return false;
  }
  arquivo.printf("%s\t%s\n", topico, mensagem);
  arquivo.close();
  _linhasNaFila++;
  return true;
}

void CriaNo::esvaziarFila(uint8_t maximo) {
  if (!_filaDisponivel || _linhasNaFila == 0) return;
  File arquivo = LittleFS.open(ARQUIVO_DA_FILA, FILE_READ);
  if (!arquivo) {
    _linhasNaFila = 0;
    return;
  }
  arquivo.seek(_posicaoNaFila);
  char linha[260];
  char mensagemDaFila[180];
  bool falhou = false;
  for (uint8_t n = 0; n < maximo && arquivo.available(); n++) {
    size_t lidos = arquivo.readBytesUntil('\n', linha, sizeof(linha) - 1);
    linha[lidos] = '\0';
    char* tab = strchr(linha, '\t');
    if (tab != nullptr) {
      *tab = '\0';
      const char* topico = linha;
      const char* mensagem = tab + 1;
      if (cria::marcarComoFila(mensagemDaFila, sizeof(mensagemDaFila), mensagem) > 0 &&
          !_mqtt.publish(topico, mensagemDaFila)) {
        // A posição não avança: esta linha é reenviada quando a conexão voltar.
        falhou = true;
        break;
      }
    }
    // Linha corrompida (sem TAB ou grande demais) é pulada.
    _posicaoNaFila = arquivo.position();
    if (_linhasNaFila > 0) _linhasNaFila--;
  }
  bool terminou = !falhou && !arquivo.available();
  arquivo.close();
  if (falhou) {
    derrubarConexao("reenvio da fila falhou");
    return;
  }
  if (terminou) {
    LittleFS.remove(ARQUIVO_DA_FILA);
    _posicaoNaFila = 0;
    _linhasNaFila = 0;
    Serial.println("[cria] fila esvaziada: todas as leituras guardadas foram reenviadas.");
  }
}

void CriaNo::contarFila() {
  _linhasNaFila = 0;
  _posicaoNaFila = 0;
  File arquivo = LittleFS.open(ARQUIVO_DA_FILA, FILE_READ);
  if (!arquivo) return;
  uint8_t bloco[512];
  size_t lidos;
  while ((lidos = arquivo.read(bloco, sizeof(bloco))) > 0) {
    for (size_t i = 0; i < lidos; i++) {
      if (bloco[i] == '\n') _linhasNaFila++;
    }
  }
  arquivo.close();
}
