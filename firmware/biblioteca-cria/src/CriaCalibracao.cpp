#include "CriaCalibracao.h"

#include <Preferences.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "CriaFormato.h"
#include "CriaTelemetria.h"

static const uint16_t MAXIMO_DE_AMOSTRAS = 600;
static const uint32_t MENOR_INTERVALO_MS = 100;
static const uint32_t MAIOR_INTERVALO_MS = 60000;

// Como cada reta fica gravada, com o nome do sensor como chave.
struct RetaGravada {
  double inclinacao;
  double deslocamento;
  uint32_t calibradoEm;
};

static char sinal(double x) {
  return x < 0 ? '-' : '+';
}

CriaCalibracao::CriaCalibracao(CriaNo& no, const char* espacoNaMemoria) : _no(no), _espaco(espacoNaMemoria) {}

bool CriaCalibracao::sensor(const char* nome, const char* unidadeBruta, LeitorBruto ler, double inclinacao,
                            double deslocamento, bool exigeCalibracao) {
  // A chave da memória não volátil tem no máximo 15 caracteres.
  bool valido = strlen(nome) <= 15 && cria::nomeValido(nome) && strlen(unidadeBruta) < sizeof(Sensor::unidade) &&
                cria::unidadeValida(unidadeBruta) && ler != nullptr && isfinite(inclinacao) && inclinacao != 0 &&
                isfinite(deslocamento);
  if (!valido || procurar(nome) != nullptr || _quantos >= MAXIMO_DE_SENSORES) {
    Serial.printf("[cal] ERRO: sensor \"%s\" recusado (nome inválido ou repetido, ou sensores demais).\n", nome);
    return false;
  }
  Sensor& s = _sensores[_quantos++];
  strncpy(s.nome, nome, sizeof(s.nome) - 1);
  s.nome[sizeof(s.nome) - 1] = '\0';
  strncpy(s.unidade, unidadeBruta, sizeof(s.unidade) - 1);
  s.unidade[sizeof(s.unidade) - 1] = '\0';
  s.ler = ler;
  s.inclinacao = s.inclinacaoPadrao = inclinacao;
  s.deslocamento = s.deslocamentoPadrao = deslocamento;
  s.calibradoEm = 0;
  s.exigeCalibracao = exigeCalibracao;
  return true;
}

void CriaCalibracao::iniciar() {
  Preferences memoria;
  bool aberta = memoria.begin(_espaco, false);
  for (uint8_t i = 0; i < _quantos; i++) {
    Sensor& s = _sensores[i];
    RetaGravada reta;
    if (aberta && memoria.getBytesLength(s.nome) == sizeof(reta) &&
        memoria.getBytes(s.nome, &reta, sizeof(reta)) == sizeof(reta) && isfinite(reta.inclinacao) &&
        reta.inclinacao != 0 && isfinite(reta.deslocamento)) {
      s.inclinacao = reta.inclinacao;
      s.deslocamento = reta.deslocamento;
      s.calibradoEm = reta.calibradoEm > 0 ? reta.calibradoEm : 1;
    }
    if (s.calibradoEm > 0) {
      time_t quando = s.calibradoEm;
      struct tm utc;
      gmtime_r(&quando, &utc);
      Serial.printf("[cal] %s: calibrado em %04d-%02d-%02d UTC (medida = %.6g * %s %c %.6g)\n", s.nome,
                    utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, s.inclinacao, s.unidade, sinal(s.deslocamento),
                    fabs(s.deslocamento));
    } else if (s.exigeCalibracao) {
      Serial.printf("[cal] %s: ainda não calibrado; não será publicado até a calibração (calibracao/README.md).\n",
                    s.nome);
    } else {
      Serial.printf("[cal] %s: reta da folha de dados (medida = %.6g * %s %c %.6g)\n", s.nome, s.inclinacao,
                    s.unidade, sinal(s.deslocamento), fabs(s.deslocamento));
    }
  }
  if (aberta) memoria.end();
}

CriaCalibracao::Sensor* CriaCalibracao::procurar(const char* nome) {
  if (nome == nullptr) return nullptr;
  for (uint8_t i = 0; i < _quantos; i++) {
    if (strcmp(_sensores[i].nome, nome) == 0) return &_sensores[i];
  }
  return nullptr;
}

double CriaCalibracao::converter(const char* nome, double bruto) {
  Sensor* s = procurar(nome);
  if (s == nullptr || !isfinite(bruto)) return NAN;
  if (s->exigeCalibracao && s->calibradoEm == 0) return NAN;
  return s->inclinacao * bruto + s->deslocamento;
}

double CriaCalibracao::ler(const char* nome) {
  Sensor* s = procurar(nome);
  if (s == nullptr) return NAN;
  return converter(nome, s->ler());
}

bool CriaCalibracao::aguardandoCalibracao(const char* nome) {
  Sensor* s = procurar(nome);
  return s != nullptr && s->exigeCalibracao && s->calibradoEm == 0;
}

bool CriaCalibracao::calibrado(const char* nome) {
  Sensor* s = procurar(nome);
  return s != nullptr && s->calibradoEm > 0;
}

// ---------------------------------------------------------------------------
// Comandos da ferramenta de calibração

void CriaCalibracao::atender(Stream& porta) {
  while (porta.available()) {
    char c = (char)porta.read();
    if (c == '\n' || c == '\r') {
      if (_tamanho > 0 && !_linhaLonga) {
        _linha[_tamanho] = '\0';
        executar(_linha, porta);
      }
      _tamanho = 0;
      _linhaLonga = false;
    } else if (_tamanho < sizeof(_linha) - 1) {
      _linha[_tamanho++] = c;
    } else {
      _linhaLonga = true;  // linha grande demais não é comando: é descartada inteira
    }
  }
  if (_amostrando != nullptr) amostrar(porta);
}

void CriaCalibracao::erro(Stream& porta, const char* motivo) {
  porta.printf("{\"cal\":\"erro\",\"motivo\":\"%s\"}\n", motivo);
}

static bool lerNumero(const char* texto, double& numero) {
  if (texto == nullptr) return false;
  char* fim;
  numero = strtod(texto, &fim);
  return fim != texto && *fim == '\0' && isfinite(numero);
}

void CriaCalibracao::executar(char* linha, Stream& porta) {
  char* resto;
  char* palavra = strtok_r(linha, " \t", &resto);
  if (palavra == nullptr || strcmp(palavra, "cal") != 0) return;  // não é comando de calibração
  const char* comando = strtok_r(nullptr, " \t", &resto);
  const char* nome = strtok_r(nullptr, " \t", &resto);
  const char* arg1 = strtok_r(nullptr, " \t", &resto);
  const char* arg2 = strtok_r(nullptr, " \t", &resto);
  const char* arg3 = strtok_r(nullptr, " \t", &resto);

  if (comando == nullptr || strcmp(comando, "ajuda") == 0) {
    porta.println("{\"cal\":\"ajuda\",\"comandos\":[\"cal sensores\",\"cal ler SENSOR\","
                  "\"cal amostrar SENSOR N [INTERVALO_MS]\",\"cal gravar SENSOR INCLINACAO DESLOCAMENTO [SEGUNDOS]\","
                  "\"cal apagar SENSOR\",\"cal cancelar\"]}");
    return;
  }
  if (strcmp(comando, "sensores") == 0) {
    listar(porta);
    return;
  }
  if (strcmp(comando, "cancelar") == 0) {
    _amostrando = nullptr;
    porta.println("{\"cal\":\"cancelado\"}");
    return;
  }

  Sensor* s = procurar(nome);
  if (s == nullptr) {
    erro(porta, "sensor desconhecido: use cal sensores para ver os nomes");
    return;
  }

  if (strcmp(comando, "ler") == 0) {
    double bruto = s->ler();
    if (!isfinite(bruto)) {
      erro(porta, "leitura com falha: confira a ligação do sensor");
      return;
    }
    double valor = converter(s->nome, bruto);
    porta.printf("{\"cal\":\"bruto\",\"sensor\":\"%s\",\"bruto\":%.7g,\"unidade\":\"%s\",\"valor\":", s->nome, bruto,
                 s->unidade);
    if (isfinite(valor)) porta.printf("%.7g}\n", valor);
    else porta.println("null}");
    return;
  }

  if (strcmp(comando, "amostrar") == 0) {
    double n, intervalo = 1000;
    if (!lerNumero(arg1, n) || n < 1 || n > MAXIMO_DE_AMOSTRAS || n != floor(n) ||
        (arg2 != nullptr && (!lerNumero(arg2, intervalo) || intervalo < MENOR_INTERVALO_MS ||
                             intervalo > MAIOR_INTERVALO_MS))) {
      erro(porta, "use cal amostrar SENSOR N [INTERVALO_MS], com N de 1 a 600 e intervalo de 100 a 60000 ms");
      return;
    }
    if (_amostrando != nullptr) {
      erro(porta, "já há uma amostragem em andamento: use cal cancelar");
      return;
    }
    _amostrando = s;
    _amostrasPedidas = (uint16_t)n;
    _amostrasFeitas = 0;
    _intervaloMs = (uint32_t)intervalo;
    _ultimaAmostra = millis() - _intervaloMs;  // a primeira sai já na próxima volta
    _media = 0;
    _somaDosQuadrados = 0;
    porta.printf("{\"cal\":\"amostrando\",\"sensor\":\"%s\",\"n\":%u,\"intervalo_ms\":%u}\n", s->nome,
                 (unsigned)_amostrasPedidas, (unsigned)_intervaloMs);
    return;
  }

  if (strcmp(comando, "gravar") == 0) {
    double inclinacao, deslocamento, segundos = (double)time(nullptr);
    if (!lerNumero(arg1, inclinacao) || inclinacao == 0 || !lerNumero(arg2, deslocamento) ||
        (arg3 != nullptr && (!lerNumero(arg3, segundos) || segundos < 1 || segundos > 4294967295.0))) {
      erro(porta, "use cal gravar SENSOR INCLINACAO DESLOCAMENTO [SEGUNDOS], com inclinação diferente de zero");
      return;
    }
    RetaGravada reta = {inclinacao, deslocamento, segundos >= 1 ? (uint32_t)segundos : 1};
    Preferences memoria;
    bool gravou = memoria.begin(_espaco, false) && memoria.putBytes(s->nome, &reta, sizeof(reta)) == sizeof(reta);
    memoria.end();
    if (!gravou) {
      erro(porta, "não foi possível gravar na memória do nó");
      return;
    }
    s->inclinacao = reta.inclinacao;
    s->deslocamento = reta.deslocamento;
    s->calibradoEm = reta.calibradoEm;
    porta.printf("{\"cal\":\"gravado\",\"sensor\":\"%s\",\"inclinacao\":%.9g,\"deslocamento\":%.9g,\"calibrado_em\":%u}\n",
                 s->nome, s->inclinacao, s->deslocamento, (unsigned)s->calibradoEm);
    Serial.printf("[cal] %s: nova calibração gravada (medida = %.6g * %s %c %.6g)\n", s->nome, s->inclinacao,
                  s->unidade, sinal(s->deslocamento), fabs(s->deslocamento));
    return;
  }

  if (strcmp(comando, "apagar") == 0) {
    Preferences memoria;
    if (memoria.begin(_espaco, false)) {
      if (memoria.isKey(s->nome)) memoria.remove(s->nome);
      memoria.end();
    }
    s->inclinacao = s->inclinacaoPadrao;
    s->deslocamento = s->deslocamentoPadrao;
    s->calibradoEm = 0;
    porta.printf("{\"cal\":\"apagado\",\"sensor\":\"%s\"}\n", s->nome);
    return;
  }

  erro(porta, "comando desconhecido: use cal ajuda");
}

void CriaCalibracao::listar(Stream& porta) {
  // "memoria" diz onde as retas estão: "cria-cal-sim" no modo simulado.
  porta.printf("{\"cal\":\"sensores\",\"no\":\"%s/%s\",\"memoria\":\"%s\",\"sensores\":[", _no.projeto().c_str(),
               _no.nome().c_str(), _espaco);
  for (uint8_t i = 0; i < _quantos; i++) {
    const Sensor& s = _sensores[i];
    porta.printf("%s{\"nome\":\"%s\",\"unidade\":\"%s\",\"inclinacao\":%.9g,\"deslocamento\":%.9g,"
                 "\"calibrado_em\":%u,\"exige_calibracao\":%s}",
                 i > 0 ? "," : "", s.nome, s.unidade, s.inclinacao, s.deslocamento, (unsigned)s.calibradoEm,
                 s.exigeCalibracao ? "true" : "false");
  }
  porta.println("]}");
}

void CriaCalibracao::amostrar(Stream& porta) {
  uint32_t agora = millis();
  if (agora - _ultimaAmostra < _intervaloMs) return;
  _ultimaAmostra = agora;
  Sensor* s = _amostrando;
  double bruto = s->ler();
  if (!isfinite(bruto)) {
    porta.printf("{\"cal\":\"erro\",\"sensor\":\"%s\",\"motivo\":\"leitura com falha na amostra %u: confira a ligação do sensor\"}\n",
                 s->nome, (unsigned)(_amostrasFeitas + 1));
    _amostrando = nullptr;
    return;
  }
  _amostrasFeitas++;
  double diferenca = bruto - _media;
  _media += diferenca / _amostrasFeitas;
  _somaDosQuadrados += diferenca * (bruto - _media);
  if (_amostrasFeitas == 1 || bruto < _menor) _menor = bruto;
  if (_amostrasFeitas == 1 || bruto > _maior) _maior = bruto;
  porta.printf("{\"cal\":\"amostra\",\"sensor\":\"%s\",\"i\":%u,\"bruto\":%.7g}\n", s->nome,
               (unsigned)_amostrasFeitas, bruto);
  if (_amostrasFeitas < _amostrasPedidas) return;

  // Desvio padrão da amostra (divide por n - 1).
  double desvio = _amostrasFeitas > 1 ? sqrt(_somaDosQuadrados / (_amostrasFeitas - 1)) : 0;
  porta.printf("{\"cal\":\"media\",\"sensor\":\"%s\",\"n\":%u,\"media\":%.7g,\"desvio\":%.4g,\"menor\":%.7g,"
               "\"maior\":%.7g,\"unidade\":\"%s\"}\n",
               s->nome, (unsigned)_amostrasFeitas, _media, desvio, _menor, _maior, s->unidade);
  _amostrando = nullptr;
}
