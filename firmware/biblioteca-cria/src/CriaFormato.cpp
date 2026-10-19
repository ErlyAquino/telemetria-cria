#include "CriaFormato.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

namespace cria {

static bool minusculaOuAlgarismo(char c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}

static bool letra(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static bool algarismo(char c) {
  return c >= '0' && c <= '9';
}

bool nomeValido(const char* nome) {
  if (nome == nullptr || !minusculaOuAlgarismo(nome[0])) return false;
  size_t tamanho = 1;
  for (const char* c = nome + 1; *c != '\0'; c++, tamanho++) {
    if (!minusculaOuAlgarismo(*c) && *c != '-') return false;
  }
  return tamanho <= 32;
}

bool noValido(const char* no) {
  if (no == nullptr || strncmp(no, "no", 2) != 0) return false;
  const char* numero = no + 2;
  size_t algarismos = strlen(numero);
  if (algarismos < 1 || algarismos > 4 || numero[0] == '0') return false;
  for (const char* c = numero; *c != '\0'; c++) {
    if (!algarismo(*c)) return false;
  }
  return true;
}

bool grandezaValida(const char* grandeza) {
  return nomeValido(grandeza) && strcmp(grandeza, "status") != 0 && strcmp(grandeza, "cmd") != 0;
}

bool unidadeValida(const char* unidade) {
  if (unidade == nullptr || !(letra(unidade[0]) || unidade[0] == '%')) return false;
  size_t tamanho = 1;
  for (const char* c = unidade + 1; *c != '\0'; c++, tamanho++) {
    if (!letra(*c) && !algarismo(*c) && strchr("%/._-", *c) == nullptr) return false;
  }
  return tamanho <= 20;
}

size_t montarMensagem(char* destino, size_t tamanho, double valor, const char* unidade,
                      uint32_t seq, uint32_t boot, int64_t t) {
  // %.7g: 7 algarismos significativos, a precisão de um float. Assim 6.12f sai
  // como 6.12, e não como 6.11999988. Valores acima de 9999999 perdem os últimos
  // algarismos. PRIu32 e PRId64 são os formatos certos para inteiros de 32 e 64 bits.
  int escritos = snprintf(destino, tamanho,
                          "{\"valor\":%.7g,\"unidade\":\"%s\",\"seq\":%" PRIu32 ",\"boot\":%" PRIu32 ",\"t\":%" PRId64 "}",
                          valor, unidade, seq, boot, t);
  if (escritos < 0 || (size_t)escritos >= tamanho) return 0;
  return (size_t)escritos;
}

size_t marcarComoFila(char* destino, size_t tamanho, const char* mensagem) {
  size_t n = strlen(mensagem);
  if (n < 2 || mensagem[n - 1] != '}') return 0;
  const char sufixo[] = ",\"fila\":1}";
  size_t total = n - 1 + sizeof(sufixo) - 1;
  if (total + 1 > tamanho) return 0;
  memcpy(destino, mensagem, n - 1);
  memcpy(destino + n - 1, sufixo, sizeof(sufixo));  // inclui o '\0'
  return total;
}

}  // namespace cria
