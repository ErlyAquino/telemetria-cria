#!/usr/bin/env bash
# Instala o backup diário do banco da telemetria.
#
# Uso, como root:   sudo bash servidor/base/backup/instalar-backup.sh /mnt/backup-telemetria
#
# Copia os scripts para /usr/local/sbin, grava o destino em
# /etc/default/telemetria-backup e liga o timer do systemd, que roda o backup
# todo dia às 02:30 (ou na partida seguinte, se o servidor estava desligado).
# O cartão microSD precisa estar montado nessa pasta: veja o README.md desta pasta.

set -euo pipefail

PASTA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO="${1:-}"

falhar() {
  echo "ERRO: $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || falhar "rode como root: sudo bash $0 PASTA_DO_CARTAO"
[[ -n "$DESTINO" ]] || falhar "diga onde o cartão está montado: sudo bash $0 /mnt/backup-telemetria"
[[ "$DESTINO" == /* ]] || falhar "use o caminho completo, começando com /."
[[ -d "$DESTINO" ]] || falhar "a pasta $DESTINO não existe."
command -v influx > /dev/null || falhar "o comando influx não foi encontrado: rode antes o servidor/base/instalar.sh."
[[ -f /root/.influxdbv2/configs ]] || falhar "falta /root/.influxdbv2/configs, com o token de administrador do InfluxDB."
if ! mountpoint -q "$DESTINO"; then
  echo "AVISO: $DESTINO não é um ponto de montagem. O backup só roda com o cartão montado nessa pasta."
fi

install -m 755 "$PASTA/backup-banco.sh" /usr/local/sbin/telemetria-backup
install -m 755 "$PASTA/testar-restauracao.sh" /usr/local/sbin/telemetria-testar-restauracao
install -m 644 "$PASTA/telemetria-backup.service" /etc/systemd/system/telemetria-backup.service
install -m 644 "$PASTA/telemetria-backup.timer" /etc/systemd/system/telemetria-backup.timer
# O destino vai com aspas do bash (%q): um caminho com espaço, como os de
# /media, não pode virar comando quando o arquivo for lido pelo "source".
if [[ -f /etc/default/telemetria-backup ]]; then
  # Mantém os outros ajustes que já estiverem no arquivo.
  {
    grep -v '^BACKUP_DIR=' /etc/default/telemetria-backup || true
    printf 'BACKUP_DIR=%q\n' "$DESTINO"
  } > /etc/default/telemetria-backup.novo
  mv /etc/default/telemetria-backup.novo /etc/default/telemetria-backup
else
  {
    echo '# Backup do banco da telemetria (servidor/base/backup/README.md)'
    printf 'BACKUP_DIR=%q\n' "$DESTINO"
    echo 'BACKUP_MANTER_DIAS=30'
  } > /etc/default/telemetria-backup
fi
systemctl daemon-reload
systemctl enable --now telemetria-backup.timer

echo
echo "Backup diário instalado: destino $DESTINO."
systemctl list-timers telemetria-backup.timer --no-pager | head -2
echo
echo "Rode um backup agora:          sudo systemctl start telemetria-backup.service"
echo "Veja como foi:                 journalctl -u telemetria-backup.service -n 20"
echo "Teste a restauração (quinzenal): sudo telemetria-testar-restauracao"
