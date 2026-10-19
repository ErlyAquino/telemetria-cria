# Imagens da câmera por HTTP, guardadas fora do banco

**Data:** 18/10/2026

**O que foi decidido.** A ESP32-CAM da horta (`horta/no3`) envia cada foto ao servidor como um JPEG, em `POST /api/imagens/no3`, com o usuário e a senha do projeto `horta` em autenticação Basic. O broker confere a senha, como na rota das placas Arduino. O servidor guarda as fotos em `IMAGENS_DIR/{projeto}/{no}/{AAAA-MM-DD}/{HH-MM-SS}.jpg`, na hora da escola, fora do InfluxDB e fora do repositório. O painel mostra a foto mais recente no cartão do nó. Pelo MQTT, o nó da câmera publica só o próprio estado (LWT).

**Por quê.**

- Uma foto de 1600 x 1200 tem de 150 a 300 KB. O MQTT do projeto foi dimensionado para leituras de cerca de 100 bytes: o buffer da biblioteca do nó é de 512 bytes, e o servidor guarda cada mensagem no banco de séries temporais.
- O InfluxDB não é feito para guardar arquivos. Em pastas por dia, as fotos podem ser copiadas, revistas e montadas em time-lapse com qualquer programa (por exemplo, `ffmpeg -framerate 12 -pattern_type glob -i '*.jpg' timelapse.mp4`).
- Fora do repositório, nenhuma foto vai ao GitHub por engano. O plano de trabalho exige que a pasta de imagens seja revista antes de qualquer publicação.

**O que se perde.** As fotos não têm fila no nó: se o servidor estiver fora na hora da foto, ela não é tirada. O servidor não apaga fotos antigas, e de 13 a 25 MB por dia vão se somando (84 fotos, das 6 h às 20 h); abaixo de `IMAGENS_ESPACO_MINIMO_MB` livres (padrão 1 GB), ele recusa as fotos novas para não faltar espaço ao banco. As fotos não entram no backup do banco (`servidor/base/backup/`): quem quiser guardá-las deve copiá-las à parte, para um disco que não seja o cartão do backup.
