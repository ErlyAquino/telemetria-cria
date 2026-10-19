# Backup do banco

O banco de séries temporais (InfluxDB) guarda todas as leituras do projeto. Estes scripts fazem um backup diário dele num cartão microSD, ou em outro disco, e testam a restauração numa cópia, como pede o Guia do Projeto: um backup só vale depois de restaurado.

| Arquivo | O que faz |
| --- | --- |
| `backup-banco.sh` | Faz um backup do bucket `telemetria` numa pasta com a data e a hora, com o `SHA256SUMS` para conferir os arquivos. Antes, apaga os restos de backups interrompidos e os backups com mais de 30 dias, mas mantém sempre os 3 mais novos. Dois backups nunca rodam ao mesmo tempo |
| `testar-restauracao.sh` | Confere o backup mais novo, restaura num bucket novo, compara a contagem de leituras com o banco em uso e apaga a cópia. Falha se a contagem der zero ou se o InfluxDB devolver erro |
| `instalar-backup.sh` | Copia os dois scripts para `/usr/local/sbin` e liga o backup diário pelo systemd |
| `telemetria-backup.service`, `.timer` | O backup diário, às 02:30. Se o servidor estava desligado nessa hora, o backup roda na partida seguinte |

Os scripts rodam como root, porque o backup usa o token de administrador do InfluxDB, que o instalador do servidor guardou em `/root/.influxdbv2/configs`.

## 1. Preparar o cartão microSD

Uma vez só, com o cartão no leitor do servidor:

```bash
lsblk -f
```

Ache o cartão pelo tamanho (por exemplo, `sdb1` com 29,7G). Formate em ext4, **conferindo duas vezes o nome**, porque a formatação apaga tudo o que houver na partição:

```bash
sudo mkfs.ext4 -L backup-telemetria /dev/sdb1
sudo mkdir -p /mnt/backup-telemetria
```

Para o cartão montar sozinho a cada partida, acrescente esta linha ao `/etc/fstab` (`sudo nano /etc/fstab`):

```
LABEL=backup-telemetria  /mnt/backup-telemetria  ext4  defaults,nofail  0  2
```

O `nofail` deixa o servidor ligar mesmo sem o cartão. Monte e confira:

```bash
sudo mount -a
mountpoint /mnt/backup-telemetria
```

## 2. Instalar o backup diário

Na pasta do repositório:

```bash
sudo bash servidor/base/backup/instalar-backup.sh /mnt/backup-telemetria
sudo systemctl start telemetria-backup.service
journalctl -u telemetria-backup.service -n 20
```

O segundo comando faz um backup na hora, para conferir. O destino e os ajustes ficam em `/etc/default/telemetria-backup`:

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `BACKUP_DIR` | o informado na instalação | Onde o cartão está montado |
| `BACKUP_MANTER_DIAS` | `30` | Backups mais velhos que isso são apagados; os 3 mais novos ficam sempre |
| `BACKUP_ESPACO_MINIMO_MB` | `200` | Abaixo disso livre no cartão, o backup não roda e o erro fica no journal |
| `BACKUP_EXIGIR_PONTO_DE_MONTAGEM` | `1` | Com 1, o backup só roda se o cartão estiver montado. Sem essa conferência, um cartão que não montou faria o backup ir para o disco do próprio servidor, que é o que ele deveria proteger |

## 3. Testar a restauração (a cada quinzena)

```bash
sudo telemetria-testar-restauracao
```

O teste confere os arquivos do backup mais novo pelo `SHA256SUMS`, restaura o bucket num bucket novo, conta as leituras gravadas até a hora do backup nos dois e apaga a cópia. O banco em uso não é tocado. Ele termina com `RESTAURAÇÃO OK` e as duas contagens, que vão para o caderno. O banco em uso pode ter umas poucas leituras a mais: as da fila de um nó, com hora de antes do backup, que chegaram depois dele.

## 4. Restaurar de verdade, num servidor novo

1. Instale o servidor base com `servidor/base/instalar.sh`, como da primeira vez.
2. Monte o cartão e restaure o backup mais novo por cima do bucket vazio que o instalador criou:

   ```bash
   sudo influx bucket delete --name telemetria
   sudo influx restore --bucket telemetria /mnt/backup-telemetria/telemetria-AAAA-MM-DD-HHMMSS
   ```

3. O bucket restaurado tem outro identificador: crie um token novo para o servidor (`sudo influx auth create ...`, como no `instalar.sh`), troque o `INFLUX_TOKEN` no `.env` e reinicie o servidor da telemetria.

## O que fica de fora

- **As fotos da câmera da horta**, que ficam em `IMAGENS_DIR`, fora do banco. Não aponte o `IMAGENS_DIR` para o cartão do backup: as fotos disputariam espaço com os backups, o cartão formatado em ext4 é do root (o servidor não conseguiria gravar nele) e, com o cartão desmontado, o servidor criaria a pasta no disco do sistema. Para guardá-las, copie a pasta das fotos para outro disco de tempos em tempos.
- **As senhas e os tokens** (`.env`, `/etc/mosquitto/senhas`, `/root/.influxdbv2/configs`). Um cartão de backup se perde com facilidade e não deve levar senhas. Guarde uma cópia desses arquivos num lugar seguro, fora do servidor, como manda o instalador.
