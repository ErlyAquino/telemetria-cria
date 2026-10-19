// Regras do catálogo de tópicos (mqtt/catalogo-topicos.md) e formato das
// mensagens, sem nada de Wi-Fi nem de MQTT.
//
// Fica separado de CriaTelemetria para poder ser testado sem placa.

#pragma once

#include <stddef.h>
#include <stdint.h>

namespace cria {

// Projeto e grandeza: começa com letra minúscula ou algarismo; depois letras
// minúsculas, algarismos e hífen; até 32 caracteres (seção 1 do catálogo).
bool nomeValido(const char* nome);

// Nó: "no" seguido de 1 a 9999, sem zero à esquerda.
bool noValido(const char* no);

// Grandeza que pode receber leituras: nome válido e não reservado (status, cmd).
bool grandezaValida(const char* grandeza);

// Unidade: começa com letra ou %; depois letras, algarismos e % / . _ -; até 20.
bool unidadeValida(const char* unidade);

// Monta a mensagem de uma leitura (seção 2 do catálogo), por exemplo:
//   {"valor":6.12,"unidade":"pH","seq":1834,"boot":7,"t":1792345678123}
// Devolve o tamanho escrito, ou 0 se não couber no destino.
size_t montarMensagem(char* destino, size_t tamanho, double valor, const char* unidade,
                      uint32_t seq, uint32_t boot, int64_t t);

// Acrescenta "fila":1 a uma mensagem guardada na fila, antes de reenviá-la.
// Devolve o tamanho escrito, ou 0 se a mensagem não terminar em "}" ou não couber.
size_t marcarComoFila(char* destino, size_t tamanho, const char* mensagem);

}  // namespace cria
