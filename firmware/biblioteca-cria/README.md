# CriaTelemetria: a biblioteca-padrão dos nós ESP32

**Versão 0.2.0.** É o produto de reuso da plataforma, com o [catálogo de tópicos](../../mqtt/catalogo-topicos.md). Com ela, um nó novo só precisa ler o próprio sensor e chamar `publicar()`. A biblioteca cuida de:

- conectar no Wi-Fi e reconectar quando a rede cai;
- conectar no broker com o usuário do projeto, registrar o LWT (`offline` com retain) e publicar `online`;
- acertar o relógio pelo servidor de hora da rede local (o próprio servidor da escola), só começar a medir depois disso e conferir a hora a cada 15 minutos;
- numerar as leituras (`seq`, dado na leitura) e contar as vezes que o nó ligou (`boot`, guardado na memória não volátil);
- guardar na memória flash (LittleFS) as leituras feitas sem conexão e reenviá-las com `"fila":1` quando a conexão voltar, mesmo que o nó tenha reiniciado nesse meio-tempo;
- com um RTC DS3231, voltar a medir depois de um corte de energia mesmo sem rede (versão 0.2);
- guardar a calibração de cada sensor na memória do nó e atender a ferramenta de calibração pela USB (classe `CriaCalibracao`, versão 0.2).

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

Os exemplos completos estão em `examples/PrimeiroNo` (DHT22) e `examples/NoDS18B20` (DS18B20, com a calibração pela USB). O nó do monitor de ar fica em `firmware/no-ar`, e os da horta em `firmware/horta-no1`, `horta-no2` e `horta-no3-camera`.

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
| `no.usarRelogioDS3231(Wire)` | Usa o RTC DS3231 do barramento I2C. Antes de `iniciar()`, com o `Wire.begin(21, 22)` já feito |
| `no.usarKeepAlive(30)` | Keepalive do MQTT, em segundos (padrão: 5). Para nós que passam vários segundos sem chamar `manter()`, como a câmera enviando uma foto. Antes de `iniciar()` |
| `no.projeto()`, `no.nome()` | O projeto e o nó, como no catálogo |

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
- **Hora depois de reiniciar.** Num reinício por software (cão de guarda, pane, `ESP.restart()`), o ESP32 mantém a hora e volta a medir na hora. O botão EN e um corte de energia reiniciam o chip inteiro e apagam a hora: sem o DS3231, o nó espera o servidor de hora.

## Hora pelo DS3231

Sem o DS3231, um nó que liga depois de um corte de energia espera o servidor de hora para começar a medir. Com ele (`no.usarRelogioDS3231(Wire)`), o nó lê a hora do DS3231 na partida, alinhada à virada do segundo, e começa a medir na hora. A cada conexão ao Wi-Fi, o nó pede a hora ao servidor até receber a primeira resposta, e cada vez que ela chega a biblioteca corrige o DS3231, com erro abaixo de 20 ms. O DS3231 guarda a hora em UTC. Se a bateria dele acabou (marca de oscilador parado) ou se a hora dele for anterior à data em que o programa foi compilado, a biblioteca não a usa e espera o servidor.

## Calibração dos sensores

A classe `CriaCalibracao` guarda, na memória não volátil, a reta de cada sensor (medida = inclinação × bruto + deslocamento) e atende a ferramenta `calibracao/calibrar.py` pela USB:

```cpp
CriaNo no("horta", "no1");
CriaCalibracao calibracao(no);

double tensaoDoPh() { /* lê o eletrodo; NAN se falhar */ }

void setup() {
  Serial.begin(115200);
  // nome, unidade do bruto, função que lê o bruto, reta da folha de dados, exige calibração
  calibracao.sensor("ph", "V", tensaoDoPh, -5.63, 21.10, true);
  calibracao.iniciar();
  no.iniciar(WIFI_SSID, WIFI_SENHA, MQTT_HOST, MQTT_PORTA, MQTT_USUARIO, MQTT_SENHA);
}

void loop() {
  calibracao.atender();          // comandos da ferramenta, sem travar o nó
  no.manter();
  if (no.aCada(10000)) no.publicar("ph", calibracao.ler("ph"), "pH");
}
```

| Função | O que faz |
| --- | --- |
| `calibracao.sensor(nome, unidadeBruta, ler, inclinacao, deslocamento, exige)` | Registra um sensor (até 8, nome com até 15 caracteres). A reta dada vale até a primeira calibração |
| `calibracao.iniciar()` | Lê as retas gravadas e mostra a situação de cada sensor no Monitor Serial |
| `calibracao.atender()` | Atende os comandos `cal ...` da serial. Em todo `loop()` |
| `calibracao.ler("ph")` | Lê o bruto e aplica a reta. `NAN` se a leitura falhar ou se o sensor exigir calibração e ainda não tiver sido calibrado |
| `calibracao.converter("vazao", bruto)` | Só aplica a reta a um bruto já lido |
| `calibracao.calibrado("ph")` | O sensor já foi calibrado neste nó? |
| `calibracao.aguardandoCalibracao("ph")` | O sensor exige calibração e ainda não foi calibrado? |

Um programa em modo de teste, com leituras inventadas, deve guardar as retas noutro espaço da memória, `CriaCalibracao calibracao(no, "cria-cal-sim");`, para a reta de um ensaio nunca valer depois com os sensores de verdade. O `horta-no1` faz isso sozinho quando `SIMULAR_SENSORES` está ligado.

O roteiro de bancada e os comandos estão em [`calibracao/README.md`](../../calibracao/README.md). O nó completo da horta, com pH, condutividade, vazão, pressão e boia, está em `firmware/horta-no1`.

## Limitações da versão 0.2

- **Ritmo:** um só `aCada` por programa. Para dois ritmos diferentes, use `millis()` no próprio sketch.
- **Comandos pela rede:** a calibração é pela USB (`decisoes/2026-10-18-calibracao-pela-usb.md`); o tópico `cmd` continua sem uso.
- **Teste:** a versão 0.2 compila sem avisos para o ESP32 DevKit V1 e para a ESP32-CAM (núcleo esp32 3.3.12). A calibração pela USB foi testada numa ESP32 real, com o `horta-no1` no modo simulado. O Wi-Fi, o MQTT e o DS3231 ainda não rodaram numa placa: em 18/10/2026 o computador de teste não alcançava o broker pela rede sem fio.
