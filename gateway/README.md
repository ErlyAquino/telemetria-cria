# Gateway das placas Arduino

As placas Arduino Uno da escola não têm rede. Ligadas por USB a um computador, elas escrevem uma linha JSON por leitura, e o gateway envia essas leituras ao servidor pela rota HTTP (`POST /api/leituras`), com o usuário e a senha do projeto. As leituras chegam ao painel e ao banco pelo mesmo caminho das que vêm dos ESP32.

O programa da placa está em [`firmware/arduino-usb`](../firmware/arduino-usb/arduino-usb.ino). Ele compila para o Arduino Uno e também para o ESP32, que pode usar este caminho quando não houver Wi-Fi.

## O que a placa escreve e o que o gateway acrescenta

A placa escreve uma linha por leitura (`mqtt/catalogo-topicos.md`, seção 2):

```json
{"no":"no1","grandeza":"temperatura","valor":27.44,"unidade":"C","seq":12}
```

O gateway acrescenta:

- **`t`:** a hora em que a linha chegou, em milissegundos, pelo relógio do computador do gateway. Duas leituras da mesma grandeza nunca recebem a mesma hora, para não virarem um ponto só no banco;
- **`boot`:** a placa recomeça o `seq` em 1 sempre que reinicia. O Uno e a maioria das placas ESP32 reiniciam também quando o gateway abre a porta. O gateway começa um boot novo quando o `seq` volta, isto é, fica menor ou igual ao último recebido daquele nó. Se a placa continuou contando enquanto o gateway estava parado, o boot continua o mesmo, e as leituras desse intervalo aparecem como perda, que é o que de fato aconteceu. O último boot e o último `seq` de cada nó ficam em `gateway/.estado/`, um arquivo por nó;
- **`"fila": 1`:** nas leituras que esperaram o servidor voltar.

Linhas que não começam com `{`, como as mensagens de partida da placa, aparecem no terminal como `placa: ...`, sem repetir a mesma linha seguida. Linhas JSON fora do catálogo aparecem com o motivo.

## Instalação

O gateway precisa do Python 3.9 ou mais novo e de uma biblioteca só, a **pyserial**. Primeiro, traga o repositório para o computador que vai ficar ligado à placa, como explica o tutorial [Conta no GitHub e Git no terminal](../tutoriais/00-conta-github-e-git.md).

- **Ubuntu ou Debian:**

  ```bash
  sudo apt install python3-serial
  sudo usermod -aG dialout $USER
  ```

  O segundo comando dá ao seu usuário permissão para usar a porta serial. Ela só vale depois de sair da sessão e entrar de novo. No Ubuntu, o pacote `brltty` (leitor de tela em braile) toma as portas dos clones com chip CH340 assim que eles são ligados. Se a porta `/dev/ttyUSB0` aparecer e sumir logo em seguida, e ninguém no computador usar linha braile, remova-o com `sudo apt remove brltty`.
- **Windows:** instale o Python pelo site python.org, marcando a opção "Add python.exe to PATH". Depois, na pasta do repositório:

  ```
  py -m pip install -r gateway/requirements.txt
  ```

  Os clones do Uno com chip CH340 precisam de um driver no Windows. Os computadores do laboratório podem não ter internet: baixe o instalador do driver antes, num computador com rede, e leve-o num pendrive.

## Configuração

Copie o `.env.example` da raiz do repositório para `.env`, na mesma pasta, e preencha:

| Variável | Para que serve |
| --- | --- |
| `PORTA_SERIAL` | A porta da placa: `COM5` no Windows; `/dev/ttyACM0` (Uno original) ou `/dev/ttyUSB0` (clones com CH340) no Linux |
| `SERVIDOR_URL` | O endereço do servidor, começando com `http://`, por exemplo `http://192.168.0.10:3000`. Se o gateway rodar no próprio servidor, use `http://127.0.0.1:3000`: no Windows, `localhost` atrasa cada envio em cerca de 2 s |
| `GATEWAY_PROJETO` | O projeto do catálogo a que a placa pertence, por exemplo `teste`. É também o usuário da rota HTTP |
| `GATEWAY_SENHA` | A senha MQTT desse projeto |

A senha de cada projeto é criada na instalação do servidor (`servidor/base/README.md`) e fica com quem cuida dele: peça a essa pessoa. A do projeto `teste` está no `.env` do servidor, em `SIMULADOR_SENHA`. O `.env` está no `.gitignore` e nunca vai para o GitHub.

**Qual é a porta da placa.** No Windows, abra o Gerenciador de Dispositivos e procure em "Portas (COM e LPT)" o número que aparece ao ligar a placa; o Arduino IDE também mostra a porta no menu Ferramentas. No Linux, `ls /dev/serial/by-id/` lista as placas ligadas pelo nome. Esse caminho também serve como `PORTA_SERIAL` e não muda quando outra placa é ligada antes.

**O nome do nó** (`no1`, `no2`...) fica no programa da placa, na constante `NO`. Cada placa do projeto precisa de um nó só seu: confira no catálogo e no painel quais já existem. Duas placas com o mesmo nó misturam as leituras e o `seq`. O gateway recusa abrir, no mesmo computador, um segundo gateway para um nó que já está em uso.

**Relógio.** A hora das leituras vem do computador do gateway, que precisa estar com o relógio acertado pelo servidor, como o computador do verificador (veja `validacao/README.md`). O servidor recusa leituras mais de 1 minuto no futuro. O gateway compara o seu relógio com a hora das respostas do servidor e avisa se a diferença passar de 2 s.

## Uso

Feche o Monitor Serial do Arduino IDE antes: a porta só pode ser usada por um programa de cada vez. Na raiz do repositório:

```bash
python3 gateway/gateway.py
```

No Windows, use `py` no lugar de `python3`. Opções:

- `--porta`: troca a porta do `.env`;
- `--baud`: velocidade da serial. O padrão é 115200, o mesmo do programa da placa;
- `--servidor`: troca o endereço do servidor;
- `--env`: usa outro arquivo de configuração.

Cada gateway lê uma porta. Para duas placas, rode dois gateways, em dois terminais, e dê ao segundo a porta dele com `--porta`.

O terminal mostra o que chega da placa e cada envio:

```
14:02:10  gateway do projeto "teste" enviando para http://192.168.0.10:3000. Ctrl+C encerra.
14:02:10  porta COM5 aberta a 115200 baud; esperando leituras.
14:02:11  placa: telemetria: no1
14:02:12  1 leitura enviada (no1 boot 3); seq até 1.
14:02:22  1 leitura enviada (no1 boot 3); seq até 2.
```

## O que acontece quando algo falha

| Situação | O gateway |
| --- | --- |
| Servidor fora do ar ou broker parado | Guarda as leituras na memória (até 20000) e tenta de novo, com espera crescente até 30 s. Quando o servidor volta, elas saem com `"fila": 1` |
| Senha ou projeto errados | Para, com a mensagem do servidor |
| Leitura recusada pelo servidor | Mostra o motivo e descarta a leitura, porque repetir não adiantaria |
| Placa desconectada | Tenta reabrir a porta a cada 5 s. Enquanto isso, continua enviando as leituras que já tinha |
| Nenhuma leitura válida em 30 s | Avisa: em geral é a velocidade (`--baud`) errada, o sensor mal ligado ou outro programa na placa |
| Arquivo de `gateway/.estado/` corrompido | Para, para não repetir boots. Confira no banco o último boot do nó e corrija o arquivo, que tem a forma `{"boot": 3, "seq": 120}` |

As leituras que esperam na memória se perdem se o gateway for desligado antes de o servidor voltar. Ao receber Ctrl+C, ele ainda tenta enviá-las por até 30 s e desiste se o servidor não as aceitar.

No painel, o nó de uma placa Arduino fica off-line quando passa 30 s sem leituras, porque essas placas não têm o LWT do MQTT.

## Testes

Na raiz do repositório:

```bash
python3 -m unittest discover -s gateway
```

No Windows: `py -m unittest discover -s gateway`. Os testes não precisam de placa nem de servidor.
