// Conexão do servidor com o broker: assina cria/# com sessão persistente.
//
// Sessão persistente quer dizer clean session desligado e identificador fixo.
// Enquanto o servidor estiver desconectado (reiniciando, por exemplo), o broker
// guarda as leituras que chegarem e as entrega quando ele voltar. A configuração
// do broker (mqtt/mosquitto.exemplo.conf) guarda inclusive as de QoS 0.

import mqtt from 'mqtt';

export function conectarAssinante({ host, porta, usuario, senha, clientId }, { aoReceber, aoMudarConexao }) {
  const cliente = mqtt.connect(`mqtt://${host}:${porta}`, {
    clientId,
    username: usuario,
    password: senha,
    clean: false,
    keepalive: 30,
    reconnectPeriod: 2000,
    // A assinatura é refeita a cada conexão, abaixo. Assinar de novo também faz
    // o broker reenviar as mensagens com retain, como o status de cada nó.
    resubscribe: false,
  });

  let avisouQueda = false; // para avisar a queda uma vez, e não a cada tentativa

  cliente.on('connect', (connack) => {
    avisouQueda = false;
    console.log(
      `MQTT: conectado a ${host}:${porta} como "${usuario}"` +
        (connack.sessionPresent ? ' (sessão anterior retomada)' : ' (sessão nova)'),
    );
    // QoS 0 de propósito: assinando com QoS 1, o Mosquitto 2.0 deixa de entregar
    // as mensagens QoS 1 depois que a sessão acumula leituras QoS 0 numa queda.
    // Veja decisoes/2026-10-18-servidor-assina-com-qos-0.md.
    cliente.subscribe('cria/#', { qos: 0 }, (erro) => {
      if (erro) console.error(`MQTT: falha ao assinar cria/#: ${erro.message}`);
    });
    aoMudarConexao(true);
  });

  cliente.on('close', () => {
    aoMudarConexao(false);
    if (!avisouQueda) console.warn('MQTT: sem conexão com o broker; tentando de novo a cada 2 s.');
    avisouQueda = true;
  });

  cliente.on('error', (erro) => {
    // 4 e 5 são as recusas do broker por usuário ou senha.
    if (erro.code === 4 || erro.code === 5) {
      console.error(`MQTT: o broker recusou o usuário "${usuario}". Confira MQTT_USUARIO e MQTT_SENHA no .env.`);
    } else if (!avisouQueda) {
      console.error(`MQTT: ${erro.message || erro.code}`);
    }
  });

  // Um erro ao tratar uma mensagem não pode derrubar o servidor: registra e segue.
  cliente.on('message', (topico, conteudo) => {
    try {
      aoReceber(topico, conteudo.toString('utf8'));
    } catch (erro) {
      console.error(`Erro ao tratar mensagem de ${topico.slice(0, 80)}: ${erro.message}`);
    }
  });

  return {
    conectado: () => cliente.connected,
    fechar: () => cliente.endAsync(),
  };
}
