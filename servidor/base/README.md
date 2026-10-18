# Servidor base

O servidor base são três programas que ficam ligados o tempo todo no computador do Espaço CRIA:

| Programa | O que faz | Porta |
| --- | --- | --- |
| **Mosquitto** | Broker MQTT: recebe o que os nós publicam e repassa a quem assinou | 1883 (TCP) |
| **chrony** | Servidor de hora (NTP): acerta o relógio dos nós sem depender da internet | 123 (UDP) |
| **InfluxDB 2** | Banco de séries temporais: guarda cada leitura com a data e a hora | 8086 (TCP) |

O painel web (Node.js) entra na Etapa 2 e usa estes três.

## Antes de instalar

- Um computador com **Ubuntu 22.04 ou mais novo**, ou **Debian 12 ou mais novo**, ligado à internet durante a instalação. Depois, o servidor funciona sem internet. O script foi testado no Ubuntu 26.04, onde instalou o Mosquitto 2.0.22, o chrony 4.8 e o InfluxDB 2.9.1.
- Este repositório clonado nesse computador (tutorial em `tutoriais/00-conta-github-e-git.md`).
- As senhas que serão criadas, anotadas num lugar seguro, fora do repositório:
  - uma para cada usuário MQTT: `servidor`, `ar`, `horta` e `teste`;
  - uma para o administrador do InfluxDB, com pelo menos 8 caracteres.

As senhas aceitam letras sem acento, algarismos e os sinais `. _ @ % + = : , ! ? -`. Outros sinais, como `#`, aspas e barra invertida, são recusados porque mudariam a senha no caminho até o `.env` ou até o `credenciais.h` dos nós.

## Instalação

Na raiz do repositório:

```bash
sudo bash servidor/base/instalar.sh
```

Num Debian instalado com senha de root, o `sudo` pode não existir. Nesse caso, entre como root com `su -`, vá até a pasta do repositório e rode o mesmo comando sem o `sudo`.

O script faz, em ordem:

1. Instala os pacotes `mosquitto`, `mosquitto-clients`, `chrony`, `curl`, `gnupg` e `python3`.
2. Copia `mqtt/mosquitto.exemplo.conf` para `/etc/mosquitto/conf.d/cria.conf` e `mqtt/acl` para `/etc/mosquitto/acl`. Pede a senha de cada usuário MQTT e grava todas em `/etc/mosquitto/senhas`.
3. Copia `servidor/base/chrony-cria.conf` para `/etc/chrony/conf.d/cria.conf`, para o chrony atender os nós da rede local mesmo sem internet.
4. Acrescenta o repositório oficial da InfluxData (conferindo a impressão digital da chave), instala o InfluxDB 2 e a ferramenta `influx`, cria a organização `cria` e o bucket `telemetria`, sem prazo de validade, e gera um token que só lê e escreve nesse bucket.
5. Libera as portas 1883, 123 e 8086 no firewall, se o `ufw` estiver ativo, e faz um autoteste.

As senhas do usuário MQTT `servidor` e do usuário `teste`, e o token do InfluxDB, são gravados no `.env` da raiz do repositório. Esse arquivo pertence ao dono do repositório, só ele pode ler (permissão 600), e está no `.gitignore`.

O script pode ser rodado de novo: usuários, senhas e configuração do InfluxDB que já existirem são mantidos. Se o `.env` tiver se perdido, ele cria um token novo para o servidor; as senhas MQTT, porém, precisam ser digitadas de novo no `.env` à mão.

### O autoteste

No fim, o script confere três coisas e escreve `OK` ou `FALHA` em cada uma:

- o usuário `servidor` recebe o que o projeto `teste` publica;
- o usuário `teste` não consegue publicar no projeto `horta` (a ACL funciona);
- o broker recusa quem chega sem usuário e senha.

## Depois de instalar

- **Reserve um IP fixo para o servidor** no ponto de acesso dedicado (reserva de DHCP pelo endereço MAC). É esse IP que vai no `MQTT_HOST` do `credenciais.h` de cada nó e que os nós usam como servidor NTP. O script mostra os endereços do computador no final.
- **Ligue o computador no no-break.** O critério de disponibilidade (95% em 24 h) depende disso.
- **Guarde uma cópia de `/root/.influxdbv2/configs`** num lugar seguro, fora do repositório. O InfluxDB guarda os tokens só de forma cifrada, e esse arquivo é o único lugar com o token de administrador.

## Como testar com o nó simulado

O nó simulado faz o papel de um ESP32 enquanto as placas não chegam. Ele fica em `servidor/ferramentas/no-simulado.js` e precisa do Node.js 22 ou mais novo. No Ubuntu, instale o Node.js LTS pelo site oficial ([nodejs.org](https://nodejs.org/)), porque a versão do `apt` costuma ser antiga.

Num terminal, acompanhe tudo o que chega ao broker, com o usuário do servidor:

```bash
mosquitto_sub -h localhost -u servidor -P 'SENHA_DO_SERVIDOR' -t 'cria/#' -v -q 1 -c -i observador
```

O `-c -i observador` abre uma sessão persistente: se este terminal ou o broker cair, o broker guarda as leituras que chegarem nesse meio-tempo e as entrega quando o observador voltar. É assim que o servidor da Etapa 2 também vai assinar.

Em outro terminal, dentro da pasta `servidor/`:

```bash
npm install
npm run simulador
```

O simulador usa o projeto e a senha que estão em `SIMULADOR_PROJETO` e `SIMULADOR_SENHA` no `.env`. Por padrão ele é o nó `cria/teste/no1` e publica uma temperatura a cada 10 s. Outras opções:

```bash
# Imita o nó da solução nutritiva da horta, dentro do projeto teste, a cada 2 s
npm run simulador -- --no no1 --perfil horta-no1 --intervalo 2

# Descarta 1% das leituras de propósito, para testar a conta da perda de pacotes
npm run simulador -- --perda 0.01
```

O que observar no terminal do `mosquitto_sub`:

- **`status online`** assim que o simulador conecta.
- **Uma linha por leitura**, com `seq` crescendo de 1 em 1.
- **Queda do broker:** pare o broker com `sudo systemctl stop mosquitto`, espere algumas leituras e ligue de novo com `sudo systemctl start mosquitto`. As leituras feitas durante a queda chegam de uma vez, com `"fila":1`, sem pular nenhum `seq`.
- **Queda do nó:** feche o terminal do simulador sem Ctrl+C. O broker publica `status offline` sozinho: é o LWT.

## Comandos úteis

| Para | Comando |
| --- | --- |
| Ver se os serviços estão de pé | `systemctl status mosquitto chrony influxdb` |
| Ver os últimos erros do broker | `journalctl -u mosquitto -n 50` |
| Criar ou trocar a senha de um usuário MQTT | `sudo mosquitto_passwd /etc/mosquitto/senhas NOME` e depois `sudo systemctl restart mosquitto` (veja a nota abaixo) |
| Ver os nós que pediram hora | `sudo chronyc clients` |
| Ver o estado do relógio | `chronyc tracking` |
| Ver os buckets do InfluxDB | `sudo influx bucket list` |
| Abrir a interface do InfluxDB | `http://IP_DO_SERVIDOR:8086` no navegador, com o usuário administrador |

Um usuário MQTT novo serve para um projeto novo do catálogo e precisa ter o mesmo nome do projeto (veja `mqtt/catalogo-topicos.md`, seção 5). A ACL não muda.

**Nota sobre o `mosquitto_passwd`.** Ao mexer no arquivo de senhas, ele pode avisar que o dono do arquivo não é o root e sugerir um `chown root`. O aviso é esperado: **não siga a sugestão**. O broker lê esse arquivo como usuário `mosquitto`, e o dono precisa continuar sendo ele. Se o dono tiver mudado, volte com `sudo chown mosquitto:mosquitto /etc/mosquitto/senhas`. Ao trocar a senha do usuário `servidor` ou do `teste`, atualize também a `MQTT_SENHA` ou a `SIMULADOR_SENHA` no `.env`.
