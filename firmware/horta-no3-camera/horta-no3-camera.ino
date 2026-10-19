// Câmera da bancada hidropônica (projeto-teste 2): nó cria/horta/no3.
//
// Uma ESP32-CAM (AI Thinker, câmera OV2640) fotografa o cultivo em intervalos
// regulares, para o registro em time-lapse, e envia cada foto ao servidor por
// HTTP (POST /api/imagens/no3, com a senha do projeto horta). As imagens não
// passam pelo MQTT; o servidor as guarda em pastas por dia (servidor/README.md).
// Pelo MQTT vai só o estado do nó (online/offline), pela biblioteca CriaTelemetria.
//
// A câmera enquadra o cultivo, não pessoas (compromisso do plano de trabalho).
// Confira o enquadramento na instalação e sempre que a câmera for movida.
//
// Montagem: a ESP32-CAM não tem USB. Para gravar, use o adaptador USB-serial
// (ESP32-CAM-MB ou FTDI a 5 V: TX->U0R, RX->U0T, GND, 5V) com o GPIO 0 ligado
// ao GND durante a gravação. Para rodar, tire o GPIO 0 do GND e reinicie.
// Alimente com uma fonte de 5 V e pelo menos 2 A: com menos, a placa reinicia
// sozinha ao ligar o Wi-Fi e a câmera ao mesmo tempo (brownout).
//
// Placa no Arduino IDE: "AI Thinker ESP32-CAM". Antes de compilar: copie
// firmware/credenciais.exemplo.h para esta pasta com o nome credenciais.h e
// preencha, com MQTT_USUARIO "horta". Bibliotecas: a CriaTelemetria
// (firmware/biblioteca-cria) e a PubSubClient; a da câmera vem com o núcleo esp32.

#include <CriaTelemetria.h>
#include <HTTPClient.h>
#include <esp_camera.h>

#if __has_include("credenciais.h")
#include "credenciais.h"
#else
#error "Falta o credenciais.h: copie firmware/credenciais.exemplo.h para a pasta deste sketch com esse nome."
#endif

// ---------------------------------------------------------------------------
// Ajustes deste nó

const uint32_t INTERVALO_ENTRE_FOTOS_MS = 10UL * 60 * 1000;  // 84 fotos entre 6 h e 20 h
// Só fotografa entre estas horas (hora da escola), para não guardar fotos no
// escuro. Acerte pelo fotoperíodo do painel LED.
const int PRIMEIRA_HORA = 6;
const int ULTIMA_HORA = 20;  // a última foto sai antes das 20:00
const int FUSO_HORAS = -3;   // Cabo de Santo Agostinho: UTC-3, sem horário de verão
const uint16_t PORTA_DO_SERVIDOR = 3000;
const uint32_t PRAZO_DO_ENVIO_MS = 20000;
// 1600 x 1200 com PSRAM; a qualidade vai de 0 (melhor) a 63. Com 12, cada foto
// fica em 150 a 300 KB: de 13 a 25 MB por dia.
const framesize_t TAMANHO_DA_FOTO = FRAMESIZE_UXGA;
const int QUALIDADE_DO_JPEG = 12;

// Pinos da câmera na AI Thinker ESP32-CAM.
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
const int PINO_DO_FLASH = 4;  // LED forte da placa: fica apagado

// ---------------------------------------------------------------------------

CriaNo no("horta", "no3");
bool cameraPronta = false;
uint32_t ultimaTentativaDaCamera = 0;

bool iniciarCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.grab_mode = CAMERA_GRAB_LATEST;  // sempre a imagem mais nova, não uma guardada
  if (psramFound()) {
    c.frame_size = TAMANHO_DA_FOTO;
    c.jpeg_quality = QUALIDADE_DO_JPEG;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    Serial.println("[horta] AVISO: placa sem PSRAM; as fotos saem em 800 x 600.");
    c.frame_size = FRAMESIZE_SVGA;
    c.jpeg_quality = QUALIDADE_DO_JPEG;
    c.fb_count = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
  }
  esp_err_t erro = esp_camera_init(&c);
  if (erro != ESP_OK) {
    Serial.printf("[horta] ERRO: câmera não iniciou (0x%x): confira o cabo plano da câmera.\n", erro);
    return false;
  }
  Serial.println("[horta] câmera pronta.");
  return true;
}

// Hora da escola agora, de 0 a 23.
int horaLocal() {
  time_t agora = time(nullptr);
  struct tm utc;
  gmtime_r(&agora, &utc);
  return (utc.tm_hour + FUSO_HORAS + 24) % 24;
}

void fotografarEEnviar() {
  if (!no.conectado()) {
    Serial.println("[horta] sem conexão com o servidor: foto não tirada (a câmera não guarda fotos).");
    return;
  }
  // A primeira imagem depois de um tempo parada vem com a exposição antiga.
  camera_fb_t* foto = esp_camera_fb_get();
  if (foto) esp_camera_fb_return(foto);
  foto = esp_camera_fb_get();
  if (!foto) {
    Serial.println("[horta] ERRO: a câmera não entregou a foto.");
    return;
  }

  WiFiClient conexao;
  HTTPClient http;
  String endereco = String("http://") + MQTT_HOST + ":" + PORTA_DO_SERVIDOR + "/api/imagens/" + no.nome();
  http.begin(conexao, endereco);
  http.setAuthorization(MQTT_USUARIO, MQTT_SENHA);
  http.addHeader("Content-Type", "image/jpeg");
  http.setTimeout(PRAZO_DO_ENVIO_MS);
  int codigo = http.POST(foto->buf, foto->len);
  size_t tamanho = foto->len;
  esp_camera_fb_return(foto);

  if (codigo == 201) {
    Serial.printf("[horta] foto de %u KB enviada.\n", (unsigned)(tamanho / 1024));
  } else if (codigo == 401) {
    Serial.println("[horta] ERRO: o servidor recusou a senha: confira MQTT_USUARIO e MQTT_SENHA no credenciais.h.");
  } else if (codigo > 0) {
    Serial.printf("[horta] o servidor respondeu %d: %s\n", codigo, http.getString().c_str());
  } else {
    Serial.printf("[horta] envio da foto falhou (%s): confira o servidor na porta %u.\n",
                  http.errorToString(codigo).c_str(), PORTA_DO_SERVIDOR);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(PINO_DO_FLASH, OUTPUT);
  digitalWrite(PINO_DO_FLASH, LOW);
  cameraPronta = iniciarCamera();
  // O envio de uma foto prende o programa por alguns segundos, sem manter() no
  // meio: com o keepalive padrão de 5 s, a conexão MQTT cairia a cada foto e o
  // painel mostraria a câmera off-line à toa.
  no.usarKeepAlive(30);
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  no.manter();
  if (!cameraPronta && millis() - ultimaTentativaDaCamera > 60000) {
    ultimaTentativaDaCamera = millis();
    cameraPronta = iniciarCamera();
  }
  // Sem conexão, o intervalo nem começa a contar: a foto sai assim que o nó
  // voltar a falar com o servidor.
  if (!cameraPronta || !no.conectado()) return;
  if (!no.aCada(INTERVALO_ENTRE_FOTOS_MS)) return;
  int hora = horaLocal();
  if (hora < PRIMEIRA_HORA || hora >= ULTIMA_HORA) return;  // fora do horário das fotos
  fotografarEEnviar();
}
