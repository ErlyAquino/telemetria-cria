# O servidor assina cria/# com QoS 0

**Data:** 18/10/2026

**O que foi decidido.** O servidor da telemetria assina `cria/#` com QoS 0, numa sessão persistente (clean session desligado e identificador fixo). O broker continua guardando as leituras enquanto o servidor está fora, porque `queue_qos0_messages` está ligado em `mqtt/mosquitto.exemplo.conf`.

**Por quê.** O teste da Etapa 2 contra o Mosquitto 2.0.22 mostrou um problema com a assinatura em QoS 1. Depois de uma queda do servidor, a sessão dele acumulou umas 60 leituras QoS 0, e a partir daí nenhuma mensagem QoS 1 chegou mais ao servidor. Isso inclui as leituras da rota HTTP e o status dos nós. As QoS 0 novas continuaram chegando. O broker tinha guardado as QoS 1 na fila da sessão e não as enviava.

O caso foi reproduzido com um cliente separado:

- **Assinatura com QoS 1:** com 30 leituras QoS 0 guardadas durante a ausência, a mensagem QoS 1 publicada depois da volta não chegou.
- **Assinatura com QoS 0:** no mesmo cenário, chegou.

Tudo indica que as mensagens QoS 0 tiradas da fila consomem a cota de 20 mensagens em trânsito da sessão e nunca a devolvem.

Assinando com QoS 0, toda mensagem é entregue ao servidor como QoS 0 e não passa por essa cota.

**O que se perde.** A entrega do broker ao servidor fica sem confirmação. Uma leitura enviada no instante em que a conexão cai se perde sem aviso. Ela aparece como lacuna no `seq`, que é exatamente o que o critério 1 mede. Como os nós já publicam com QoS 0 (veja `2026-10-18-qos0-com-seq-e-boot.md`), a cadeia passa a ser QoS 0 de ponta a ponta, com a perda medida pelo `seq`. Se uma versão nova do Mosquitto corrigir esse comportamento, vale repetir o teste com QoS 1.
