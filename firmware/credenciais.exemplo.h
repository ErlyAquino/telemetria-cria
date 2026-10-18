// Modelo das credenciais de um nó ESP32.
//
// Como usar: copie este arquivo para dentro da pasta do seu sketch com o nome
// credenciais.h e preencha os campos. O credenciais.h está no .gitignore e nunca
// vai para o GitHub; só este modelo, sem senhas, é versionado.
//
// A cópia precisa ficar na pasta do sketch porque a Arduino IDE copia essa pasta
// para uma pasta temporária antes de compilar: um #include "../credenciais.h"
// passa a apontar para fora da cópia e não é encontrado.
//
// Se uma senha for enviada ao GitHub por engano, avise o coordenador: ela deve
// ser trocada no servidor (senha do MQTT) ou no ponto de acesso (senha do Wi-Fi)
// antes de qualquer outra providência.

#pragma once

// Rede Wi-Fi dedicada da telemetria
#define WIFI_SSID    ""
#define WIFI_SENHA   ""

// Broker MQTT, no servidor da escola
#define MQTT_HOST    ""      // IP do servidor na rede da telemetria, ex.: "192.168.0.10"
#define MQTT_PORTA   1883
#define MQTT_USUARIO ""      // o nome do projeto no catálogo, ex.: "horta"
#define MQTT_SENHA   ""
