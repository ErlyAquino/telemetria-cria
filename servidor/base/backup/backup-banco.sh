#!/usr/bin/env bash
# Backup do banco da telemetria (InfluxDB) para o cartão microSD ou outro disco.
#
# Uso, como root:   sudo bash servidor/base/backup/backup-banco.sh [PASTA_DE_DESTINO]
#
# Depois do instalar-backup.sh, o systemd roda este script todo dia de
# madrugada, com o destino de /etc/default/telemetria-backup (BACKUP_DIR).
# Cada backup fica numa pasta com a data e a hora, com o arquivo SHA256SUMS para
# conferir os arquivos. Os backups com mais de BACKUP_MANTER_DIAS dias são
# apagados, mas os 3 mais novos ficam sempre. Explicação: servidor/base/backup/README.md.

set -euo pipefail

[[ -f /etc/default/telemetria-backup ]] && source /etc/default/telemetria-backup
DESTINO="${1:-${BACKUP_DIR:-}}"
MANTER_DIAS="${BACKUP_MANTER_DIAS:-30}"
BUCKET="${INFLUX_BUCKET:-telemetria}"
ESPACO_MINIMO_MB="${BACKUP_ESPACO_MINIMO_MB:-200}"
EXIGIR_PONTO_DE_MONTAGEM="${BACKUP_EXIGIR_PONTO_DE_MONTAGEM:-1}"

falhar() {
  echo "ERRO: $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || falhar "rode como root (sudo): o backup usa o token de administrador do InfluxDB, guardado em /root/.influxdbv2/configs."
[[ -n "$DESTINO" ]] || falhar "diga a pasta de destino, por exemplo: sudo bash $0 /mnt/backup-telemetria"
[[ -d "$DESTINO" ]] || falhar "a pasta $DESTINO não existe. O cartão está montado?"
# Um cartão que não montou deixa só a pasta vazia, no disco do próprio
# servidor: o backup iria para o disco que ele deveria proteger.
if [[ "$EXIGIR_PONTO_DE_MONTAGEM" == 1 ]] && ! mountpoint -q "$DESTINO"; then
  falhar "$DESTINO não é um ponto de montagem: o cartão microSD não está montado. (Para gravar numa pasta comum, use BACKUP_EXIGIR_PONTO_DE_MONTAGEM=0.)"
fi

# Um backup por vez (o timer e um "systemctl start" na mesma hora, por exemplo).
exec 9> /run/telemetria-backup.trava
flock -n 9 || falhar "outro backup está rodando agora."

# Restos de backups interrompidos (falta de energia, erro do influx) nunca
# ganham o nome definitivo e são apagados aqui.
find "$DESTINO" -maxdepth 1 -type d -name 'telemetria-*.incompleto' -exec rm -rf -- {} +

# Apaga os antigos antes de conferir o espaço, para um cartão cheio voltar a
# ter lugar; os 3 mais novos ficam sempre.
mapfile -t backups < <(find "$DESTINO" -maxdepth 1 -type d -name 'telemetria-????-??-??-??????' | sort -r)
for antigo in "${backups[@]:3}"; do
  if [[ -n "$(find "$antigo" -maxdepth 0 -mtime +"$MANTER_DIAS")" ]]; then
    rm -rf -- "$antigo"
    echo "backup com mais de $MANTER_DIAS dias apagado: $antigo"
  fi
done

livre_mb=$(($(df --output=avail -k "$DESTINO" | tail -1) / 1024))
((livre_mb >= ESPACO_MINIMO_MB)) || falhar "só $livre_mb MB livres em $DESTINO (mínimo: $ESPACO_MINIMO_MB MB), mesmo depois de apagar os backups antigos."

pasta="$DESTINO/telemetria-$(date +%Y-%m-%d-%H%M%S)"
[[ ! -e "$pasta" ]] || falhar "já existe um backup com este nome: $pasta"
incompleta="$pasta.incompleto"
echo "$(date '+%F %T') backup do bucket $BUCKET para $pasta"
influx backup --bucket "$BUCKET" "$incompleta"
(cd "$incompleta" && sha256sum -- * > SHA256SUMS)
# Só ganha o nome definitivo quando está inteiro: um backup interrompido fica
# com ".incompleto" e nunca é usado na restauração.
mv -- "$incompleta" "$pasta"
echo "$(date '+%F %T') backup pronto: $(du -sh "$pasta" | cut -f1), $livre_mb MB livres antes dele"
