#!/usr/bin/env bash
# Instala o servidor base da Rede de Telemetria do Espaço CRIA:
#   - Mosquitto (broker MQTT), com senha por projeto e controle de acesso (ACL);
#   - chrony, que fornece a hora aos nós sem depender da internet;
#   - InfluxDB 2 (banco de séries temporais), com o bucket "telemetria".
#
# Uso, na raiz do repositório, num Ubuntu ou Debian ligado à internet:
#   sudo bash servidor/base/instalar.sh
# Num Debian sem sudo, entre como root com "su -" e rode sem o sudo.
#
# Pode ser rodado de novo: o que já estiver feito é mantido.
# Passo a passo e testes: servidor/base/README.md.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV="$RAIZ/.env"
# O .env pertence a quem é dono do repositório, mesmo com o script rodando como root.
DONO="${SUDO_USER:-$(stat -c %U "$RAIZ")}"
USUARIOS_MQTT=(servidor ar horta teste)
INFLUX_ORG=cria
INFLUX_BUCKET=telemetria
# Nó reservado ao autoteste no catálogo (mqtt/catalogo-topicos.md, seção 4.3).
NO_AUTOTESTE=no99

# O apt não faz perguntas (por exemplo, quais serviços reiniciar depois de uma
# atualização); as únicas perguntas são as senhas deste script.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

passo() { printf '\n==> %s\n' "$1"; }
aviso() { printf '    %s\n' "$1"; }

# O apt-get roda sem ler o teclado, para não consumir o que for digitado
# para as senhas.
apt_sem_teclado() { apt-get "$@" < /dev/null; }

if [[ $EUID -ne 0 ]]; then
  echo "Rode com sudo: sudo bash servidor/base/instalar.sh" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "Este instalador é para Ubuntu ou Debian (precisa do apt-get)." >&2
  exit 1
fi

# Lê uma senha duas vezes, sem mostrar na tela, e a deixa em $SENHA.
# O segundo argumento é o tamanho mínimo (padrão: 1).
# Só aceita caracteres que passam intactos pelo .env, pelo Node.js e pelo
# credenciais.h dos ESP32: um # cortaria a senha no .env, e aspas ou barra
# invertida mudariam o texto no C.
ler_senha() {
  local rotulo="$1" minimo="${2:-1}" confirmacao
  # Com o idioma "C", a faixa A-Z do teste abaixo não inclui letras acentuadas.
  local LC_ALL=C
  while true; do
    IFS= read -rsp "    Senha para $rotulo: " SENHA || { echo "A entrada acabou antes da senha." >&2; exit 1; }
    echo
    IFS= read -rsp "    Repita a senha: " confirmacao || { echo "A entrada acabou antes da senha." >&2; exit 1; }
    echo
    if (( ${#SENHA} < minimo )); then
      aviso "A senha precisa ter pelo menos $minimo caracteres."
    elif [[ ! "$SENHA" =~ ^[A-Za-z0-9._@%+=:,!?-]+$ ]]; then
      aviso "Use só letras sem acento, algarismos e estes sinais: . _ @ % + = : , ! ? -"
    elif [[ "$SENHA" != "$confirmacao" ]]; then
      aviso "As senhas não conferem."
    else
      # O 0 é obrigatório: um "return" sozinho devolveria o resultado do último
      # teste (falso) e o set -e encerraria o script.
      return 0
    fi
  done
}

# Grava CHAVE=valor no .env da raiz, criando-o a partir do .env.example.
# O arquivo nasce com permissão 600 (só o dono lê), porque guarda senhas.
# O valor passa por variável de ambiente para que nenhum caractere seja
# interpretado pelo awk.
gravar_env() {
  [[ -f "$ENV" ]] || install -m 600 "$RAIZ/.env.example" "$ENV"
  (
    umask 077
    CHAVE="$1" VALOR="$2" awk '
      index($0, ENVIRON["CHAVE"] "=") == 1 { print ENVIRON["CHAVE"] "=" ENVIRON["VALOR"]; achou = 1; next }
      { print }
      END { if (!achou) print ENVIRON["CHAVE"] "=" ENVIRON["VALOR"] }
    ' "$ENV" > "$ENV.tmp"
  )
  mv "$ENV.tmp" "$ENV"
  chown "$DONO": "$ENV"
}

# Lê o valor de uma CHAVE do .env (vazio se não existir).
valor_env() {
  [[ -f "$ENV" ]] || return 0
  CHAVE="$1" awk 'index($0, ENVIRON["CHAVE"] "=") == 1 { print substr($0, length(ENVIRON["CHAVE"]) + 2) }' "$ENV"
}

# Cria um token que só lê e escreve no bucket da telemetria e o grava no .env.
# Usa a configuração de administrador do influx, guardada em /root/.influxdbv2.
criar_token_do_servidor() {
  local bucket_id token
  bucket_id="$(influx bucket list --org "$INFLUX_ORG" --name "$INFLUX_BUCKET" --hide-headers | awk '{print $1}')"
  token="$(influx auth create --org "$INFLUX_ORG" \
             --read-bucket "$bucket_id" --write-bucket "$bucket_id" \
             --description "servidor da telemetria" --json \
           | python3 -c 'import json, sys; d = json.load(sys.stdin); d = d[0] if isinstance(d, list) else d; print(d["token"])')"
  gravar_env INFLUX_URL http://localhost:8086
  gravar_env INFLUX_ORG "$INFLUX_ORG"
  gravar_env INFLUX_BUCKET "$INFLUX_BUCKET"
  gravar_env INFLUX_TOKEN "$token"
}

# ---------------------------------------------------------------------------
passo "1/5 Pacotes do sistema"
apt_sem_teclado update
apt_sem_teclado install -y mosquitto mosquitto-clients chrony curl gnupg python3

# ---------------------------------------------------------------------------
passo "2/5 Mosquitto (broker MQTT)"
install -m 644 "$RAIZ/mqtt/mosquitto.exemplo.conf" /etc/mosquitto/conf.d/cria.conf
install -m 700 -o mosquitto -g mosquitto "$RAIZ/mqtt/acl" /etc/mosquitto/acl

if ! grep -qs '^persistence true' /etc/mosquitto/mosquitto.conf; then
  aviso "Atenção: a persistência não está ligada em /etc/mosquitto/mosquitto.conf."
  aviso "Sem ela, o status dos nós e as mensagens guardadas para o servidor se perdem quando o broker reinicia."
fi

[[ -f /etc/mosquitto/senhas ]] || install -m 600 /dev/null /etc/mosquitto/senhas
for usuario in "${USUARIOS_MQTT[@]}"; do
  if grep -q "^$usuario:" /etc/mosquitto/senhas; then
    aviso "O usuário MQTT '$usuario' já existe; a senha foi mantida."
    continue
  fi
  ler_senha "o usuário MQTT '$usuario'"
  # O -b recebe a senha na linha de comando: ela aparece por um instante na
  # lista de processos deste computador, que é dedicado ao servidor.
  mosquitto_passwd -b /etc/mosquitto/senhas "$usuario" "$SENHA"
  case "$usuario" in
    servidor) gravar_env MQTT_USUARIO servidor; gravar_env MQTT_SENHA "$SENHA" ;;
    teste)    gravar_env SIMULADOR_PROJETO teste; gravar_env SIMULADOR_SENHA "$SENHA" ;;
  esac
done
# O broker lê senhas e ACL já como usuário mosquitto: o arquivo precisa ser dele.
chown mosquitto:mosquitto /etc/mosquitto/senhas
chmod 700 /etc/mosquitto/senhas

systemctl enable mosquitto
systemctl restart mosquitto || { journalctl -u mosquitto -n 20 --no-pager; exit 1; }

# ---------------------------------------------------------------------------
passo "3/5 Hora local (chrony)"
install -d /etc/chrony/conf.d
install -m 644 "$RAIZ/servidor/base/chrony-cria.conf" /etc/chrony/conf.d/cria.conf
grep -qs '^confdir /etc/chrony/conf.d' /etc/chrony/chrony.conf \
  || echo 'confdir /etc/chrony/conf.d' >> /etc/chrony/chrony.conf
systemctl enable chrony
systemctl restart chrony || { journalctl -u chrony -n 20 --no-pager; exit 1; }

# ---------------------------------------------------------------------------
passo "4/5 InfluxDB (banco de séries temporais)"
if [[ ! -f /etc/apt/sources.list.d/influxdata.list ]]; then
  install -d -m 755 /etc/apt/keyrings
  chave="$(mktemp)"
  curl -fsSL -o "$chave" https://repos.influxdata.com/influxdata-archive.key
  # Só aceita a chave se a impressão digital for a publicada pela InfluxData.
  if ! gpg --show-keys --with-fingerprint --with-colons "$chave" 2>&1 \
       | grep -q '^fpr:\+24C975CBA61A024EE1B631787C3D57159FC2F927:$'; then
    echo "A chave do repositório da InfluxData não confere. Instalação interrompida." >&2
    exit 1
  fi
  gpg --dearmor < "$chave" > /etc/apt/keyrings/influxdata-archive.gpg
  chmod 644 /etc/apt/keyrings/influxdata-archive.gpg
  rm -f "$chave"
  echo 'deb [signed-by=/etc/apt/keyrings/influxdata-archive.gpg] https://repos.influxdata.com/debian stable main' \
    > /etc/apt/sources.list.d/influxdata.list
  apt_sem_teclado update
fi
# Sem os pacotes recomendados: o influxdata-archive-keyring reescreveria o
# influxdata.list acima e pararia a instalação com uma pergunta. A chave atual
# vale até 2029; a troca, quando vier, é feita à mão, como acima.
apt_sem_teclado install -y --no-install-recommends influxdb2 influxdb2-cli
systemctl enable influxdb
systemctl start influxdb

for _ in $(seq 30); do
  curl -sf http://localhost:8086/health >/dev/null && break
  sleep 1
done
curl -sf http://localhost:8086/health >/dev/null \
  || { echo "O InfluxDB não respondeu em 30 s." >&2; journalctl -u influxdb -n 20 --no-pager; exit 1; }

if curl -s http://localhost:8086/api/v2/setup | grep -q '"allowed": *true'; then
  # Uma configuração antiga do influx apontaria para um banco que não existe mais.
  if [[ -f /root/.influxdbv2/configs ]]; then
    mv /root/.influxdbv2/configs "/root/.influxdbv2/configs.antigo-$(date +%Y%m%d%H%M%S)"
    aviso "A configuração antiga do influx foi guardada em /root/.influxdbv2/configs.antigo-*."
  fi
  read -rp "    Usuário administrador do InfluxDB [admin]: " admin || { echo "A entrada acabou antes do usuário." >&2; exit 1; }
  admin="${admin:-admin}"
  ler_senha "o administrador do InfluxDB" 8
  # A configuração do influx, com o token de administrador, fica em
  # /root/.influxdbv2/configs. Comandos de administração usam "sudo influx ...".
  influx setup --org "$INFLUX_ORG" --bucket "$INFLUX_BUCKET" --username "$admin" \
    --password "$SENHA" --retention 0 --force
  criar_token_do_servidor
elif [[ -z "$(valor_env INFLUX_TOKEN)" ]]; then
  aviso "O InfluxDB já estava configurado, mas falta o token no .env: criando um novo."
  criar_token_do_servidor
else
  aviso "O InfluxDB já estava configurado; organização, bucket e token foram mantidos."
fi

# ---------------------------------------------------------------------------
passo "5/5 Firewall e autoteste"
# LC_ALL=C porque, em português, o ufw escreve "Estado: ativo".
if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q '^Status: active'; then
  ufw allow 1883/tcp comment 'MQTT da telemetria'
  ufw allow 123/udp comment 'NTP da telemetria'
  ufw allow 8086/tcp comment 'InfluxDB da telemetria'
fi

senha_servidor="$(valor_env MQTT_SENHA)"
senha_teste="$(valor_env SIMULADOR_SENHA)"
if [[ -n "$senha_servidor" && -n "$senha_teste" ]]; then
  recebido="$(mktemp)"
  mosquitto_sub -h localhost -u servidor -P "$senha_servidor" -t 'cria/#' -v -W 4 > "$recebido" 2>/dev/null &
  sleep 1
  agora="$(date +%s%3N)"
  mosquitto_pub -h localhost -u teste -P "$senha_teste" -t "cria/teste/$NO_AUTOTESTE/temperatura" \
    -m "{\"valor\":25.0,\"unidade\":\"C\",\"seq\":1,\"boot\":1,\"t\":$agora}"
  mosquitto_pub -h localhost -u teste -P "$senha_teste" -t "cria/horta/$NO_AUTOTESTE/temperatura" \
    -m 'fora do projeto: o broker deve descartar' || true
  wait || true

  if grep -q "^cria/teste/$NO_AUTOTESTE/temperatura " "$recebido"; then
    aviso "OK  o servidor recebe o que o projeto 'teste' publica."
  else
    aviso "FALHA  o servidor não recebeu a mensagem do projeto 'teste'."
  fi
  if grep -q "^cria/horta/$NO_AUTOTESTE/temperatura " "$recebido"; then
    aviso "FALHA  o usuário 'teste' conseguiu publicar no projeto 'horta': confira a ACL."
  else
    aviso "OK  o usuário 'teste' não publica fora do próprio projeto."
  fi
  rm -f "$recebido"
  if mosquitto_pub -h localhost -t cria/teste/anonimo -m x 2>/dev/null; then
    aviso "FALHA  o broker aceitou uma conexão sem senha."
  else
    aviso "OK  o broker recusa conexões sem senha."
  fi
else
  aviso "Autoteste do MQTT pulado: faltam MQTT_SENHA ou SIMULADOR_SENHA no .env."
fi

influx ping >/dev/null && aviso "OK  o InfluxDB responde."
chronyc tracking | sed -n '1,3p' | sed 's/^/    /'

passo "Pronto"
aviso "Endereços deste servidor: $(hostname -I)"
aviso "Reserve um IP fixo para ele no ponto de acesso: é esse IP que vai no MQTT_HOST dos nós."
aviso "Senhas e token do servidor da telemetria: $ENV"
aviso "Guarde uma cópia de /root/.influxdbv2/configs: é o único lugar com o token de administrador do InfluxDB."
aviso "Para testar com o nó simulado: veja servidor/base/README.md."
