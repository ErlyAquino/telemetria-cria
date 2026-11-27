#!/usr/bin/env bash
# Envia para o GitHub (ramo main) as fotos novas de servidor/imagens/.
#
# Não mexe na pasta de trabalho nem no ramo em que o repositório está: monta o
# commit num índice temporário, em cima do main do GitHub, e envia só ele.
# Foto apagada do disco continua no GitHub (o script só acrescenta).
#
# Uso manual:      bash servidor/ferramentas/enviar-fotos.sh
# A cada 5 horas:  ver servidor/ferramentas/systemd/telemetria-fotos.timer
set -euo pipefail

RAIZ="$(git -C "$(dirname "$(readlink -f "$0")")" rev-parse --show-toplevel)"
cd "$RAIZ"
PASTA="servidor/imagens"
[ -d "$PASTA" ] || { echo "Sem a pasta $PASTA: nada a enviar."; exit 0; }

git fetch --quiet origin main
BASE="$(git rev-parse origin/main)"

export GIT_INDEX_FILE="$(mktemp)"
trap 'rm -f "$GIT_INDEX_FILE"' EXIT
git read-tree "$BASE"
# Só fotos fechadas há mais de 1 minuto: a que o servidor está gravando fica para a próxima.
find "$PASTA" -type f -name '*.jpg' -mmin +1 -print0 | git update-index --add -z --stdin

NOVAS="$(git diff-index --cached --name-only "$BASE" -- "$PASTA" | wc -l)"
if [ "$NOVAS" -eq 0 ]; then
  echo "$(date '+%F %T')  nenhuma foto nova."
  exit 0
fi

ARVORE="$(git write-tree)"
COMMIT="$(git commit-tree "$ARVORE" -p "$BASE" \
  -m "Fotos da horta: $NOVAS arquivo(s) até $(date '+%Y-%m-%d %H:%M')")"
git push --quiet origin "$COMMIT:refs/heads/main"
echo "$(date '+%F %T')  $NOVAS foto(s) enviada(s) no commit ${COMMIT:0:7}."
