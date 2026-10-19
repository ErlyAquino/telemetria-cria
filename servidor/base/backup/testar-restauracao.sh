#!/usr/bin/env bash
# Testa a restauração do backup mais novo numa cópia, sem tocar no banco em uso.
#
# Uso, como root:   sudo bash servidor/base/backup/testar-restauracao.sh [PASTA_DOS_BACKUPS]
#
# Confere os arquivos do backup pelo SHA256SUMS, restaura o bucket num bucket
# novo, conta as leituras gravadas até a hora do backup no bucket em uso e na
# cópia, e apaga a cópia. Um backup só vale depois de restaurado: este é o teste
# que o Guia do Projeto pede a cada quinzena.

set -euo pipefail

[[ -f /etc/default/telemetria-backup ]] && source /etc/default/telemetria-backup
DESTINO="${1:-${BACKUP_DIR:-}}"
BUCKET="${INFLUX_BUCKET:-telemetria}"

falhar() {
  echo "ERRO: $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || falhar "rode como root (sudo): a restauração usa o token de administrador do InfluxDB."
[[ -n "$DESTINO" && -d "$DESTINO" ]] || falhar "diga a pasta dos backups, por exemplo: sudo bash $0 /mnt/backup-telemetria"

ultimo="$(find "$DESTINO" -maxdepth 1 -type d -name 'telemetria-????-??-??-??????' | sort | tail -1)"
[[ -n "$ultimo" ]] || falhar "nenhum backup em $DESTINO."
echo "Backup: $ultimo"
(cd "$ultimo" && sha256sum --quiet -c SHA256SUMS) || falhar "os arquivos do backup não conferem com o SHA256SUMS: o backup está corrompido."
echo "Arquivos conferidos pelo SHA256SUMS."

# Hora do backup, pelo nome da pasta (hora local do servidor), em RFC 3339.
nome="$(basename "$ultimo")"
hora_do_backup="$(date -d "${nome:11:10} ${nome:22:2}:${nome:24:2}:${nome:26:2}" --iso-8601=seconds)"

copia="telemetria-restauracao-$(date +%Y%m%d%H%M%S)"
apagar_copia() {
  influx bucket delete --name "$copia" > /dev/null 2>&1 && echo "Cópia $copia apagada." || true
}
trap apagar_copia EXIT
influx restore --bucket "$BUCKET" --new-bucket "$copia" "$ultimo" > /dev/null
echo "Restaurado no bucket $copia."

# Leituras gravadas até a hora do backup (o valor de cada leitura é um ponto).
contar() {
  influx query --raw "from(bucket: \"$1\")
    |> range(start: 0, stop: $hora_do_backup)
    |> filter(fn: (r) => r._measurement == \"leitura\" and r._field == \"valor\")
    |> group()
    |> count()" |
    awk -F, '
      { sub(/\r$/, "") }                                             # o influx termina as linhas com CRLF
      /^#/ { next }                                                  # anotações do CSV
      $2 == "result" || $2 == "error" {
        for (i = 1; i <= NF; i++) { if ($i == "_value") coluna = i; if ($i == "error") colunaDoErro = i }
        next
      }
      colunaDoErro && $colunaDoErro != "" { print "erro do InfluxDB: " $colunaDoErro > "/dev/stderr"; falhou = 1; exit 1 }
      coluna && NF >= coluna { n = $coluna }
      END { if (falhou) exit 1; print (n == "" ? 0 : n) }'
}
em_uso="$(contar "$BUCKET")" || falhar "a consulta ao bucket $BUCKET falhou."
na_copia="$(contar "$copia")" || falhar "a consulta à cópia $copia falhou."
echo "Leituras até $hora_do_backup: $em_uso no bucket em uso, $na_copia na cópia restaurada."

# Zero nos dois não prova nada: a consulta pode ter falhado em silêncio.
[[ "$em_uso" -gt 0 ]] || falhar "nenhuma leitura contada no bucket em uso: não dá para conferir a restauração."
[[ "$na_copia" -gt 0 ]] || falhar "a cópia restaurada não tem nenhuma leitura."
# O bucket em uso pode ter algumas a mais: leituras da fila de um nó, com hora
# de antes do backup, que chegaram depois dele.
if [[ "$na_copia" -gt "$em_uso" ]]; then
  falhar "a cópia tem mais leituras que o bucket em uso: confira se o backup é deste servidor."
fi
echo "RESTAURAÇÃO OK. Anote no caderno: data, backup usado e as duas contagens."
