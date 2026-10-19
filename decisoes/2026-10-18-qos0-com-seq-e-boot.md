# Leituras em QoS 0, com seq e boot

**Data:** 18/10/2026

**O que foi decidido.** As leituras são publicadas no MQTT com QoS 0 e sem *retain*. Cada leitura leva um número de sequência (`seq`), dado no momento da leitura, e o número de vezes que o nó já ligou (`boot`). As leituras que não puderem ser enviadas esperam numa fila na memória flash do ESP32 e são reenviadas quando a rede ou o servidor voltam.

**Por quê.** A PubSubClient, a biblioteca MQTT que os estudantes aprendem na Oficina 4, só publica em QoS 0, isto é, sem confirmação de entrega. Em vez de trocar de biblioteca, a confirmação passa a ser feita pelo próprio dado: o servidor sabe quais números de sequência faltam e calcula a perda exigida pelo critério 1. A fila na flash cobre a parada de até 1 h 12 min que o critério 5 tolera, cerca de 3.500 leituras na horta, mais do que cabe na RAM do ESP32 com o Wi-Fi ligado.

**O que se perde.** Uma mensagem enviada enquanto a conexão parece ativa, mas já caiu, se perde sem que o nó perceba. Ela não volta para a fila; só aparece como lacuna no `seq`. Isso acontece quando o servidor some sem fechar a conexão (desligado, cabo solto). Com o keepalive de 5 s da biblioteca CriaTelemetria, o nó percebe a queda em 5 a 10 s, ou seja, perde no máximo um ciclo de leituras a cada queda dessas. Quando um envio falha, a biblioteca derruba a conexão na hora e manda as leituras seguintes para a fila. Se essas perdas passarem de 1% nos ensaios, a alternativa é uma biblioteca com QoS 1, que confirma cada mensagem, ao custo de mudar o que foi ensinado na Oficina 4.
