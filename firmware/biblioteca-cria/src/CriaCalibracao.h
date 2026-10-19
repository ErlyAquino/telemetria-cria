// Calibração dos sensores de um nó: a reta de cada sensor fica guardada na
// memória não volátil do ESP32, e a ferramenta de calibração do notebook
// (calibracao/calibrar.py) conversa com o nó pela USB.
//
// Cada sensor tem um valor bruto (a tensão do eletrodo de pH, a frequência do
// sensor de vazão) e uma reta que converte o bruto na medida:
//
//   medida = inclinacao * bruto + deslocamento
//
// Até a primeira calibração, vale a reta da folha de dados. O sensor que
// "exige calibração", como o pH, não dá medida nenhuma enquanto não for
// calibrado: sensor sem calibração dá número, não medida.
//
//   CriaNo no("horta", "no1");
//   CriaCalibracao calibracao(no);
//
//   double tensaoDoPh() { ... }   // devolve o bruto agora, ou NAN se falhar
//
//   void setup() {
//     calibracao.sensor("ph", "V", tensaoDoPh, -5.63, 21.10, true);
//     calibracao.iniciar();
//     ...
//   }
//   void loop() {
//     calibracao.atender();        // comandos da ferramenta, pela USB
//     no.manter();
//     if (no.aCada(10000)) no.publicar("ph", calibracao.ler("ph"), "pH");
//   }
//
// Os comandos chegam pela serial, um por linha, começando com "cal". As
// respostas são linhas JSON que começam com {"cal": (veja calibracao/README.md).

#pragma once

#include <Arduino.h>

class CriaNo;

class CriaCalibracao {
 public:
  typedef double (*LeitorBruto)();
  static const uint8_t MAXIMO_DE_SENSORES = 8;

  // espacoNaMemoria: onde as retas ficam na memória não volátil. Um programa em
  // modo simulado usa outro espaço ("cria-cal-sim"), para a reta de um ensaio
  // nunca valer depois com os sensores de verdade.
  explicit CriaCalibracao(CriaNo& no, const char* espacoNaMemoria = "cria-cal");

  // Registra um sensor, antes de iniciar(). O nome tem até 15 caracteres e em
  // geral é a grandeza do catálogo ("ph"). unidadeBruta é a do valor bruto
  // ("V", "Hz"). ler devolve o bruto naquele instante, ou NAN se falhar.
  // Devolve falso se o nome for inválido, repetido ou se não couber mais sensor.
  bool sensor(const char* nome, const char* unidadeBruta, LeitorBruto ler, double inclinacao,
              double deslocamento, bool exigeCalibracao);

  // Lê da memória as retas gravadas e mostra no Monitor Serial a situação de
  // cada sensor. Chame uma vez, no setup(), depois de registrar os sensores.
  void iniciar();

  // Atende os comandos da ferramenta de calibração. Chame em todo loop().
  // Não trava: as amostras pedidas pela ferramenta saem uma por volta.
  void atender(Stream& porta = Serial);

  // Lê o bruto e aplica a reta. Devolve NAN se a leitura falhar ou se o sensor
  // exigir calibração e ainda não tiver sido calibrado.
  double ler(const char* nome);
  // Só aplica a reta a um bruto já lido.
  double converter(const char* nome, double bruto);
  // O sensor já foi calibrado neste nó?
  bool calibrado(const char* nome);
  // O sensor exige calibração e ainda não foi calibrado?
  bool aguardandoCalibracao(const char* nome);

 private:
  struct Sensor {
    char nome[16];
    char unidade[12];
    LeitorBruto ler;
    double inclinacao;
    double deslocamento;
    double inclinacaoPadrao;
    double deslocamentoPadrao;
    uint32_t calibradoEm;  // segundos desde 1970; 0 enquanto valer a reta padrão
    bool exigeCalibracao;
  };

  Sensor* procurar(const char* nome);
  void executar(char* linha, Stream& porta);
  void listar(Stream& porta);
  void amostrar(Stream& porta);
  void erro(Stream& porta, const char* motivo);

  CriaNo& _no;
  const char* _espaco;
  Sensor _sensores[MAXIMO_DE_SENSORES];
  uint8_t _quantos = 0;

  // Linha de comando que está chegando pela serial.
  char _linha[96];
  uint8_t _tamanho = 0;
  bool _linhaLonga = false;

  // Amostragem pedida pela ferramenta (média e desvio pelo método de Welford).
  Sensor* _amostrando = nullptr;
  uint16_t _amostrasPedidas = 0;
  uint16_t _amostrasFeitas = 0;
  uint32_t _intervaloMs = 1000;
  uint32_t _ultimaAmostra = 0;
  double _media = 0;
  double _somaDosQuadrados = 0;
  double _menor = 0;
  double _maior = 0;
};
