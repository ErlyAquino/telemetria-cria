// Configuração do servidor, lida do .env da raiz do repositório.
// O instalador do servidor base (servidor/base/instalar.sh) cria esse arquivo.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARQUIVO_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

function obrigatoria(nome) {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Falta ${nome} no .env da raiz do repositório (veja o .env.example).`);
  return valor;
}

export function lerConfig() {
  if (existsSync(ARQUIVO_ENV)) process.loadEnvFile(ARQUIVO_ENV);

  return {
    portaHttp: Number(process.env.PORTA_HTTP || 3000),
    // Usado na coluna data_hora do CSV. Cabo de Santo Agostinho fica no fuso de Recife.
    fusoHorario: process.env.FUSO_HORARIO || 'America/Recife',
    // Nó alimentado pela rota HTTP que passar este tempo calado fica off-line.
    segundosAteOfflineHttp: 30,
    mqtt: {
      host: process.env.MQTT_HOST || 'localhost',
      porta: Number(process.env.MQTT_PORTA || 1883),
      usuario: process.env.MQTT_USUARIO || 'servidor',
      senha: obrigatoria('MQTT_SENHA'),
      // Identificador fixo: é por ele que o broker reconhece a sessão
      // persistente e guarda as leituras enquanto o servidor está fora.
      clientId: process.env.MQTT_CLIENT_ID || 'servidor-telemetria',
    },
    influx: {
      url: process.env.INFLUX_URL || 'http://localhost:8086',
      org: process.env.INFLUX_ORG || 'cria',
      bucket: process.env.INFLUX_BUCKET || 'telemetria',
      token: obrigatoria('INFLUX_TOKEN'),
    },
  };
}
