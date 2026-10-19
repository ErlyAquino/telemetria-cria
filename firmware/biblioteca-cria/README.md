# CriaTelemetria: a biblioteca-padrão dos nós ESP32

**Versão 0.1.0.** É o produto de reuso da plataforma, com o [catálogo de tópicos](../../mqtt/catalogo-topicos.md). Com ela, um nó novo só precisa ler o próprio sensor e chamar `publicar()`. A biblioteca cuida de:

- conectar no Wi-Fi e reconectar quando a rede cai;
- conectar no broker com o usuário do projeto, registrar o LWT (`offline` com retain) e publicar `online`;
- acertar o relógio pelo servidor de hora da rede local (o próprio servidor da escola), só começar a medir depois disso e conferir a hora a cada 15 minutos;
- numerar as leituras (`seq`, dado na leitura) e contar as vezes que o nó ligou (`boot`, guardado na memória não volátil);
- guardar na memória flash (LittleFS) as leituras feitas sem conexão e reenviá-las com `"fila":1` quando a conexão voltar, mesmo que o nó tenha reiniciado nesse meio-tempo.

O passo a passo para quem nunca usou, do zero até o painel, está em [`tutoriais/01-primeiro-no-esp32.md`](../../tutoriais/01-primeiro-no-esp32.md).

## Primeiro uso

```cpp
#include <CriaTelemetria.h>
#include "credenciais.h"

CriaNo no("teste", "no1");          // publica em cria/teste/no1/...

void setup() {
  Serial.begin(115200);
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  no.manter();                       // reconecta e esvazia a fila
  if (no.aCada(10000)) {             // a cada 10 s, depois de acertar a hora
    float temperatura = lerTemperatura();   // troque pela leitura do seu sensor
    no.publicar("temperatura", temperatura, "C");
  }
}
```

O exemplo completo, com um DHT22, está em `examples/PrimeiroNo`. O nó do monitor de ar, em `firmware/no-ar`.

O `credenciais.h` é uma cópia de `firmware/credenciais.exemplo.h` na pasta do sketch, preenchida com a rede e a senha do projeto. Ele está no `.gitignore` e nunca vai para o GitHub. O `MQTT_USUARIO` precisa ser igual ao projeto, o primeiro argumento de `CriaNo`: se não for, o nó avisa e não publica.

Cada nó precisa de um nome só dele. Dois nós com o mesmo projeto e o mesmo número se derrubam um ao outro no broker. Quando isso acontece, o Monitor Serial avisa que a conexão cai logo depois de abrir.

## Instalação

A biblioteca depende da **PubSubClient** (Nick O'Leary), a mesma da Oficina 4, e do núcleo **esp32** da Espressif, versão 3.

- **Arduino IDE:** copie a pasta `firmware/biblioteca-cria` para a subpasta `libraries` do *Local do sketchbook* (veja em *Arquivo → Preferências*) e reinicie a IDE. Ela aparece como *CriaTelemetria*, e o exemplo fica em *Arquivo → Exemplos → CriaTelemetria*.
- **arduino-cli:** aponte para a pasta na hora de compilar:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 --library firmware/biblioteca-cria firmware/no-ar
```

Placa: *DOIT ESP32 DEVKIT V1* (ESP32 de 30 pinos), com a tabela de partições padrão. A partição do sistema de arquivos tem 1,375 MiB, e a fila usa até 1 MB dela.

## O que cada função faz

| Função | O que faz |
| --- | --- |
| `CriaNo no("projeto", "no1")` | Cria o nó. Projeto e nó seguem as regras da seção 1 do catálogo |
| `no.iniciar(ssid, senhaWifi, host, porta, usuario, senha)` | Liga tudo. Uma vez, no `setup()`. O `usuario` precisa ser igual ao projeto |
| `no.manter()` | Reconecta o que caiu e reenvia a fila, 20 leituras por volta. Em todo `loop()` |
| `no.aCada(ms)` | Verdadeiro uma vez a cada `ms` milissegundos, e só com a hora certa. Use um só por programa |
| `no.publicar("grandeza", valor, "unidade")` | Publica uma leitura, ou a guarda na fila se não houver conexão. Devolve falso se a leitura for recusada |
| `no.temHora()` | O relógio já foi acertado? |
| `no.conectado()` | Está conectado ao broker? |
| `no.boot()`, `no.leiturasNaFila()` | O boot atual e quantas leituras esperam na fila |
| `no.mostrarPublicacoes(true)` | Mostra cada leitura publicada no Monitor Serial |
| `no.usarServidorDeHora("ip")` | Outro servidor de hora; o padrão é o próprio broker. Antes de `iniciar()` |

## Quando uma leitura é recusada

O `publicar()` devolve falso e escreve o motivo no Monitor Serial (115200 baud), com o prefixo `[cria]`, quando:

- o valor é `NaN` ou infinito: é como o DHT22 avisa que não respondeu. Leitura com falha não é publicada e não recebe `seq` (seção 2 do catálogo). Outros sinais de falha, como os −127 °C do DS18B20 desconectado, o programa do nó precisa conferir antes de chamar `publicar()`;
- a grandeza ou a unidade estão fora das regras do catálogo, ou a grandeza é `status` ou `cmd`;
- o relógio ainda não foi acertado;
- a fila está cheia: 600 KB esperando envio, cerca de 6000 leituras, mais de 2 h de um nó com 6 grandezas a cada 10 s. A leitura nova é descartada e, como já recebeu `seq`, aparece como lacuna, que é o que o critério de perda conta.

O valor vai na mensagem com 7 algarismos significativos, a precisão de um `float`. Contagens acima de 9 999 999 perdem os últimos algarismos.

## Quedas de rede e do servidor

- **Wi-Fi.** Quando a rede cai, o ESP32 tenta voltar sozinho. Se continuar sem rede por 30 s (por exemplo, depois de uma senha recusada enquanto o ponto de acesso reiniciava), a biblioteca pede uma nova conexão a cada 30 s.
- **Servidor que some sem avisar** (desligado, cabo solto). A conexão TCP continua parecendo aberta, e o ESP32 só percebe a queda pelo *keepalive* de 5 s, em 5 a 10 s. As leituras enviadas nesse intervalo se perdem e aparecem como lacuna no `seq`. Quando um envio falha, a biblioteca derruba a conexão na hora e manda as leituras seguintes para a fila.
- **Reinício no meio do reenvio da fila.** A posição do reenvio fica só na memória, então as leituras já reenviadas daquela fila são enviadas de novo. No banco, a repetida sobrescreve a original (mesmas etiquetas e mesma hora), mas a perda estimada do painel conta as duas.
- **Hora depois de reiniciar.** Num reinício por software (botão EN, watchdog, pane), o ESP32 mantém a hora e volta a medir na hora. Só depois de um corte de energia ele espera o servidor de hora.

## Limitações da versão 0.1

- **Relógio:** a hora vem só do servidor NTP. O uso do RTC DS3231 depois de um corte de energia sem rede, previsto no catálogo para o nó `horta/no1`, entra junto com esse nó, na Etapa 5.
- **Ritmo:** um só `aCada` por programa. Para dois ritmos diferentes, use `millis()` no próprio sketch.
- **Comandos:** os comandos de calibração pelo tópico `cmd` ainda não existem; ficam para a Etapa 5.
- **Teste:** a versão 0.1 foi compilada sem avisos para o ESP32 DevKit V1 (núcleo esp32 3.3.12). Ainda não rodou numa placa: o material não tinha chegado em 18/10/2026.
