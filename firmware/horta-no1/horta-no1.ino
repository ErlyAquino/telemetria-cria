// Nó da solução nutritiva da bancada hidropônica (projeto-teste 2): cria/horta/no1.
//
// Grandezas (mqtt/catalogo-topicos.md, seção 4.2):
//   ph             pH, do PH-4502C pelo ADS1115; calibrado com os tampões 4,00 e 7,00
//   condutividade  uS/cm referida a 25 °C, do sensor TDS pelo ADS1115; calibrada com 1413 uS/cm
//   temperatura    C, do DS18B20 mergulhado na solução (compensa a condutividade)
//   vazao          L/min, do YF-S201, pelo fator de pulsos por litro
//   pressao        kPa manométrica, do sensor de pressão pelo ADS1115
//   nivel          estado: 1 com a solução acima da boia, 0 abaixo
//   bomba          estado: 1 ligada, 0 cortada pela proteção (complementar)
//
// O nó também protege a bomba: se a solução ficar abaixo da boia, ele corta a
// bomba pelo relé, sem depender da rede nem do servidor, e a religa quando o
// nível volta. A montagem, pino a pino, está no README.md desta pasta.
//
// Calibração: pela USB, com a ferramenta calibracao/calibrar.py no notebook.
// Enquanto o pH e a condutividade não forem calibrados, eles não são
// publicados. As retas ficam na memória do nó e sobrevivem a desligar e a
// gravar um programa novo.
//
// Antes de compilar: copie firmware/credenciais.exemplo.h para esta pasta com o
// nome credenciais.h e preencha, com MQTT_USUARIO "horta". Bibliotecas: a
// CriaTelemetria (firmware/biblioteca-cria), PubSubClient, OneWire,
// DallasTemperature e "Adafruit ADS1X15".

#include <Adafruit_ADS1X15.h>
#include <CriaTelemetria.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Wire.h>
#include <esp_task_wdt.h>

#if __has_include("credenciais.h")
#include "credenciais.h"
#else
#error "Falta o credenciais.h: copie firmware/credenciais.exemplo.h para a pasta deste sketch com esse nome."
#endif

// ---------------------------------------------------------------------------
// Ajustes deste nó

// 1: o nó inventa leituras plausíveis, sem nenhum sensor ligado. Serve para
// testar a rede, o painel e a ferramenta de calibração antes da montagem.
// Volte para 0 antes de instalar o nó na bancada.
#define SIMULAR_SENSORES 0

const uint8_t PINO_SDA = 21;  // I2C: ADS1115 (0x48) e DS3231 (0x68)
const uint8_t PINO_SCL = 22;
const uint8_t PINO_DS18B20 = 4;
const uint8_t PINO_VAZAO = 27;            // pulsos do YF-S201, pelo conversor de nível
const uint8_t PINO_BOIA = 25;             // boia entre o pino e o GND
const uint8_t PINO_RELE_BOMBA = 26;       // entrada IN1 do módulo de relés
const uint8_t PINO_ALIMENTACAO_TDS = 32;  // VCC do sensor de condutividade

const uint8_t CANAL_PH = 0;  // entradas do ADS1115
const uint8_t CANAL_CONDUTIVIDADE = 1;
const uint8_t CANAL_PRESSAO = 2;

// Os eletrodos de pH e de condutividade na mesma solução se atrapalham: o
// sensor de condutividade injeta corrente na água e desvia a leitura do pH.
// Com isto em true, o sensor de condutividade só fica ligado (pelo GPIO 32)
// durante a própria leitura.
const bool DESLIGAR_CONDUTIVIDADE_ENTRE_LEITURAS = true;
const uint32_t ESPERA_DA_CONDUTIVIDADE_LIGADA_MS = 800;

// Boia: com o contato fechado quando a solução está acima dela, um fio solto
// lê "abaixo" e corta a bomba, que é o lado seguro da falha. Se a sua boia
// funcionar ao contrário, vire-a na haste ou mude para false.
const bool BOIA_FECHADA_COM_SOLUCAO_ACIMA = true;
const uint32_t BOIA_ESTAVEL_MS = 2000;  // ignora a ondulação da superfície

// Relé da bomba. Os módulos optoacoplados de 4 canais acionam com o pino em
// nível baixo. A bomba passa pelo contato NF (normalmente fechado): com o nó
// desligado ou travado, ela continua funcionando como sem a telemetria, e o nó
// só aciona o relé para cortá-la. Com false, ligue a bomba no contato NA.
const bool RELE_ACIONA_EM_NIVEL_BAIXO = true;
const bool BOMBA_NO_CONTATO_NF = true;
const uint32_t ABAIXO_DA_BOIA_ATE_CORTAR_MS = 5000;
const uint32_t ACIMA_DA_BOIA_ATE_RELIGAR_MS = 60000;

// Retas da folha de dados, usadas até a calibração.
const double PH_INCLINACAO_TIPICA = -5.63;  // pH por volt, módulo PH-4502C
const double PH_DESLOCAMENTO_TIPICO = 21.10;
const double PULSOS_POR_LITRO = 450;  // YF-S201: frequência = 7,5 x vazão em L/min
const double PRESSAO_TENSAO_NO_ZERO_V = 0.5;
const double PRESSAO_TENSAO_NO_MAXIMO_V = 4.5;
const double PRESSAO_FAIXA_KPA = 1200;  // sensor de 0 a 1,2 MPa
// Compensação de temperatura da condutividade: cerca de 2% por °C, referida a 25 °C.
const double COEFICIENTE_DE_TEMPERATURA = 0.02;

// ---------------------------------------------------------------------------

CriaNo no("horta", "no1");
// No modo simulado, as retas ficam noutro espaço da memória: a reta de um
// ensaio nunca vale depois com os sensores de verdade.
CriaCalibracao calibracao(no, SIMULAR_SENSORES ? "cria-cal-sim" : "cria-cal");
Adafruit_ADS1115 ads;
OneWire umFio(PINO_DS18B20);
DallasTemperature ds18b20(&umFio);

bool adsPresente = false;
double ultimaTemperatura = NAN;  // bruta, do DS18B20
uint32_t horaDaUltimaTemperatura = 0;
// A condutividade usa uma temperatura de no máximo 5 s atrás.
const uint32_t IDADE_MAXIMA_DA_TEMPERATURA_MS = 5000;
// Uma conversão do ADS1115 leva 8 ms; um fio solto no I2C não pode travar o nó.
const uint32_t PRAZO_DA_CONVERSAO_MS = 25;
const uint32_t PRAZO_DO_CAO_DE_GUARDA_MS = 15000;

// Vazão: os pulsos são contados numa interrupção.
volatile uint32_t pulsosDaVazao = 0;
void IRAM_ATTR contarPulso() {
  pulsosDaVazao = pulsosDaVazao + 1;  // "++" em volatile está obsoleto no C++20
}
uint32_t pulsosNaUltimaPublicacao = 0;
uint32_t horaDaUltimaPublicacao = 0;
uint32_t pulsosNoInicioDaJanela = 0;
uint32_t inicioDaJanela = 0;
double frequenciaDaUltimaJanela = NAN;  // Hz no último segundo, usada na calibração

// Boia e bomba.
int8_t nivelEstavel = -1;  // -1 enquanto a boia não ficou estável desde que o nó ligou
uint32_t nivelEstavelDesde = 0;
bool ultimaLeituraDaBoia = false;
uint32_t ultimaLeituraDaBoiaDesde = 0;
bool bombaLigada = BOMBA_NO_CONTATO_NF;  // no contato NF a bomba já parte ligada
bool bombaJaFoiLigada = BOMBA_NO_CONTATO_NF;

#if SIMULAR_SENSORES
double ruido(double amplitude) {
  return amplitude * (random(-1000, 1001) / 1000.0);
}
#endif

// ---------------------------------------------------------------------------
// Leituras brutas (as que a calibração converte em medida)

// Tensão numa entrada do ADS1115, média de 8 conversões. NAN se o ADS1115 não responder.
double tensaoNoCanal(uint8_t canal) {
#if SIMULAR_SENSORES
  if (canal == CANAL_PH) return 2.52 + ruido(0.003);
  if (canal == CANAL_CONDUTIVIDADE) return 1.15 + ruido(0.004);
  return 0.62 + ruido(0.002);
#else
  if (!adsPresente) return NAN;
  // Cada conversão tem prazo: o readADC_SingleEnded() da biblioteca espera para
  // sempre se o I2C falhar no meio, e o nó deixaria de proteger a bomba.
  int32_t soma = 0;
  const int CONVERSOES = 8;
  for (int i = 0; i < CONVERSOES; i++) {
    ads.startADCReading(MUX_BY_CHANNEL[canal], false);
    uint32_t inicio = millis();
    while (!ads.conversionComplete()) {
      if (millis() - inicio > PRAZO_DA_CONVERSAO_MS) return NAN;  // fio solto ou ADS1115 desligado
    }
    soma += ads.getLastConversionResults();
  }
  return ads.computeVolts((int16_t)(soma / CONVERSOES));
#endif
}

void alimentarCondutividade(bool ligar) {
  if (!DESLIGAR_CONDUTIVIDADE_ENTRE_LEITURAS) return;
  digitalWrite(PINO_ALIMENTACAO_TDS, ligar ? HIGH : LOW);
  if (ligar) delay(ESPERA_DA_CONDUTIVIDADE_LIGADA_MS);
}

// Temperatura bruta do DS18B20 (a calibração dele vem depois, pela reta).
double lerTemperatura() {
  horaDaUltimaTemperatura = millis();
#if SIMULAR_SENSORES
  ultimaTemperatura = 25.0 + ruido(0.05);
  return ultimaTemperatura;
#else
  ds18b20.requestTemperatures();  // cerca de 750 ms em 12 bits
  float t = ds18b20.getTempCByIndex(0);
  // -127 °C: sensor desconectado. 85 °C: valor de partida, antes da primeira conversão.
  ultimaTemperatura = (t == DEVICE_DISCONNECTED_C || t == 85.0) ? NAN : t;
  return ultimaTemperatura;
#endif
}

double tensaoDoPh() {
  return tensaoNoCanal(CANAL_PH);  // o sensor de condutividade já está desligado
}

// Condutividade a 25 °C, em uS/cm, pela curva do sensor TDS analógico (a mesma
// do fabricante do módulo, sem o fator 0,5 que a transforma em ppm). A
// calibração com a solução de 1413 uS/cm corrige o que a curva genérica erra.
double condutividadeSemCalibrar() {
  // Na calibração a sonda acabou de entrar na solução: a temperatura precisa
  // ser a de agora, e não a da última publicação.
  if (isnan(ultimaTemperatura) || millis() - horaDaUltimaTemperatura > IDADE_MAXIMA_DA_TEMPERATURA_MS) lerTemperatura();
  double temperatura = calibracao.converter("temperatura", ultimaTemperatura);  // já com a calibração do DS18B20
  if (isnan(temperatura)) return NAN;  // sem temperatura não há compensação
  alimentarCondutividade(true);
  double tensao = tensaoNoCanal(CANAL_CONDUTIVIDADE);
  alimentarCondutividade(false);
  if (isnan(tensao)) return NAN;
  double v = tensao / (1.0 + COEFICIENTE_DE_TEMPERATURA * (temperatura - 25.0));
  return 133.42 * v * v * v - 255.86 * v * v + 857.39 * v;
}

double tensaoDaPressao() {
  return tensaoNoCanal(CANAL_PRESSAO);
}

double frequenciaDaVazao() {
  return frequenciaDaUltimaJanela;
}

double temperaturaAgora() {
  return lerTemperatura();
}

// ---------------------------------------------------------------------------
// Vazão, boia e bomba: conferidas em toda volta do loop

void atualizarVazao() {
  uint32_t agora = millis();
  if (agora - inicioDaJanela < 1000) return;
#if SIMULAR_SENSORES
  frequenciaDaUltimaJanela = 15.0 + ruido(0.3);
#else
  uint32_t pulsos = pulsosDaVazao;
  frequenciaDaUltimaJanela = (pulsos - pulsosNoInicioDaJanela) * 1000.0 / (agora - inicioDaJanela);
  pulsosNoInicioDaJanela = pulsos;
#endif
  inicioDaJanela = agora;
}

bool boiaComSolucaoAcima() {
#if SIMULAR_SENSORES
  return true;
#else
  bool fechada = digitalRead(PINO_BOIA) == LOW;
  return fechada == BOIA_FECHADA_COM_SOLUCAO_ACIMA;
#endif
}

void atualizarBoia() {
  uint32_t agora = millis();
  bool acima = boiaComSolucaoAcima();
  if (acima != ultimaLeituraDaBoia) {
    ultimaLeituraDaBoia = acima;
    ultimaLeituraDaBoiaDesde = agora;
    return;
  }
  int8_t nivel = acima ? 1 : 0;
  if (nivel != nivelEstavel && agora - ultimaLeituraDaBoiaDesde >= BOIA_ESTAVEL_MS) {
    nivelEstavel = nivel;
    nivelEstavelDesde = agora;
    Serial.printf("[horta] nível: solução %s da boia\n", acima ? "acima" : "abaixo");
  }
}

void aplicarRele() {
  bool acionar = BOMBA_NO_CONTATO_NF ? !bombaLigada : bombaLigada;
  digitalWrite(PINO_RELE_BOMBA, acionar == RELE_ACIONA_EM_NIVEL_BAIXO ? LOW : HIGH);
}

void protegerBomba() {
  if (nivelEstavel < 0) return;
  uint32_t tempoNoNivel = millis() - nivelEstavelDesde;
  if (bombaLigada && nivelEstavel == 0 && tempoNoNivel >= ABAIXO_DA_BOIA_ATE_CORTAR_MS) {
    bombaLigada = false;
    aplicarRele();
    Serial.println("[horta] BOMBA CORTADA: solução abaixo da boia. Reponha a solução; a bomba volta sozinha.");
  }
  // Na primeira vez (contato NA), basta o nível estável; depois, espera o
  // nível se firmar por 1 min antes de religar, para a bomba não ficar
  // ligando e desligando com a solução no limite da boia.
  uint32_t espera = bombaJaFoiLigada ? ACIMA_DA_BOIA_ATE_RELIGAR_MS : 0;
  if (!bombaLigada && nivelEstavel == 1 && tempoNoNivel >= espera) {
    bombaLigada = true;
    bombaJaFoiLigada = true;
    aplicarRele();
    Serial.println("[horta] bomba ligada: solução acima da boia.");
  }
}

// ---------------------------------------------------------------------------

// Publica uma grandeza calibrada, ou diz no Monitor Serial por que não publicou.
void publicarCalibrado(const char* grandeza, const char* unidade, double valor, double menor, double maior) {
  if (calibracao.aguardandoCalibracao(grandeza)) {
    Serial.printf("[horta] %s: ainda não calibrado, não publicado (calibracao/README.md).\n", grandeza);
    return;
  }
  if (isnan(valor) || valor < menor || valor > maior) {
    Serial.printf("[horta] %s: leitura com falha ou fora da faixa, não publicada.\n", grandeza);
    return;
  }
  no.publicar(grandeza, valor, unidade);
}

void setup() {
  Serial.begin(115200);
  // O pino do relé vira saída e recebe o nível certo logo em seguida. No meio,
  // fica em nível baixo por alguns microssegundos: pouco demais para o relé mexer.
  pinMode(PINO_RELE_BOMBA, OUTPUT);
  aplicarRele();
  pinMode(PINO_BOIA, INPUT_PULLUP);
  ultimaLeituraDaBoia = boiaComSolucaoAcima();  // o debounce conta a partir de agora
  ultimaLeituraDaBoiaDesde = millis();
  pinMode(PINO_ALIMENTACAO_TDS, OUTPUT);
  digitalWrite(PINO_ALIMENTACAO_TDS, DESLIGAR_CONDUTIVIDADE_ENTRE_LEITURAS ? LOW : HIGH);
  pinMode(PINO_VAZAO, INPUT);
  attachInterrupt(digitalPinToInterrupt(PINO_VAZAO), contarPulso, FALLING);

  Wire.begin(PINO_SDA, PINO_SCL);
#if SIMULAR_SENSORES
  Serial.println("[horta] ATENÇÃO: SIMULAR_SENSORES está ligado; as leituras são inventadas.");
#else
  adsPresente = ads.begin(0x48, &Wire);
  if (adsPresente) {
    ads.setGain(GAIN_TWOTHIRDS);  // entradas de até 6,144 V; o ADS1115 é alimentado em 5 V
  } else {
    Serial.println("[horta] ERRO: ADS1115 não responde em 0x48: pH, condutividade e pressão ficam sem leitura.");
  }
  ds18b20.begin();
#endif

  calibracao.sensor("ph", "V", tensaoDoPh, PH_INCLINACAO_TIPICA, PH_DESLOCAMENTO_TIPICO, true);
  calibracao.sensor("condutividade", "uS/cm", condutividadeSemCalibrar, 1.0, 0.0, true);
  calibracao.sensor("temperatura", "C", temperaturaAgora, 1.0, 0.0, false);
  calibracao.sensor("vazao", "Hz", frequenciaDaVazao, 60.0 / PULSOS_POR_LITRO, 0.0, false);
  double inclinacaoDaPressao = PRESSAO_FAIXA_KPA / (PRESSAO_TENSAO_NO_MAXIMO_V - PRESSAO_TENSAO_NO_ZERO_V);
  calibracao.sensor("pressao", "V", tensaoDaPressao, inclinacaoDaPressao,
                    -inclinacaoDaPressao * PRESSAO_TENSAO_NO_ZERO_V, false);
  calibracao.iniciar();

  no.usarRelogioDS3231(Wire);
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
  inicioDaJanela = horaDaUltimaPublicacao = millis();

  // Cão de guarda: se o loop travar por mais de 15 s (um defeito não previsto,
  // um sensor que prende o barramento), o ESP32 reinicia e volta a proteger a
  // bomba. O pior caso normal do loop, com o broker demorando a responder, fica
  // em cerca de 8 s.
  esp_task_wdt_config_t caoDeGuarda = {.timeout_ms = PRAZO_DO_CAO_DE_GUARDA_MS, .idle_core_mask = 1, .trigger_panic = true};
  esp_task_wdt_reconfigure(&caoDeGuarda);
  enableLoopWDT();
}

void loop() {
  calibracao.atender();
  no.manter();
  atualizarVazao();
  atualizarBoia();
  protegerBomba();  // funciona mesmo sem rede e sem hora
  if (!no.aCada(10000)) return;

  double temperatura = lerTemperatura();
  if (isnan(temperatura)) Serial.println("[horta] DS18B20 sem leitura: confira a fiação e o resistor de 4,7 kΩ.");
  else no.publicar("temperatura", calibracao.converter("temperatura", temperatura), "C");

  publicarCalibrado("ph", "pH", calibracao.ler("ph"), 0, 14);

  // Em água quase pura, a reta pode dar uns poucos uS/cm negativos: vale zero.
  double condutividade = calibracao.ler("condutividade");
  if (condutividade < 0 && condutividade > -50) condutividade = 0;
  publicarCalibrado("condutividade", "uS/cm", condutividade, 0, 20000);

  // Vazão média desde a última publicação.
  uint32_t agora = millis();
#if SIMULAR_SENSORES
  double frequenciaMedia = frequenciaDaUltimaJanela;
#else
  uint32_t pulsos = pulsosDaVazao;
  double frequenciaMedia = (pulsos - pulsosNaUltimaPublicacao) * 1000.0 / (agora - horaDaUltimaPublicacao);
  pulsosNaUltimaPublicacao = pulsos;
#endif
  horaDaUltimaPublicacao = agora;
  publicarCalibrado("vazao", "L/min", calibracao.converter("vazao", frequenciaMedia), 0, 100);

  double pressao = calibracao.ler("pressao");
  if (pressao < 0 && pressao > -20) pressao = 0;  // pequeno erro de zero do sensor
  publicarCalibrado("pressao", "kPa", pressao, 0, PRESSAO_FAIXA_KPA * 1.1);

  if (nivelEstavel >= 0) no.publicar("nivel", nivelEstavel, "estado");
  no.publicar("bomba", bombaLigada ? 1 : 0, "estado");
}
