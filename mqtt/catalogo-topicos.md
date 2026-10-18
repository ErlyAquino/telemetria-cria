# Catálogo de tópicos MQTT

**Versão 0, de 18/10/2026.** Proposta inicial, para revisão da equipe. Toda alteração entra por pull request.

Este catálogo define o endereço e o formato de toda mensagem que circula na rede de telemetria do Espaço CRIA. Junto com a biblioteca-padrão do ESP32, é o que permite colocar um nó ou uma grandeza nova a publicar sem reconfigurar o servidor. Um projeto novo exige apenas a criação do seu usuário MQTT, sem mudar a ACL nem o código do servidor (seção 5). Se dois nós usarem o mesmo endereço, ou se cada nó formatar a mensagem do seu jeito, o servidor deixa de saber o que está gravando.

## 1. O endereço

```
cria/{projeto}/{no}/{grandeza}
```

| Nível | O que é | Exemplo |
| --- | --- | --- |
| `projeto` | O projeto dono do nó. É também o nome do usuário MQTT do projeto | `horta` |
| `no` | O nó dentro do projeto | `no1` |
| `grandeza` | O que foi medido | `ph` |

Exemplo: `cria/horta/no1/ph` — rede CRIA, projeto horta, nó 1, pH.

### Regras de nome

- Só letras minúsculas sem acento, algarismos e hífen. Nada de espaço, `ç`, acento ou barra dentro de um nível.
- `projeto` precisa estar registrado na seção 4 antes do primeiro uso.
- `no` é a palavra `no` seguida do número, sem zero à esquerda: `no1`, `no2`, ..., `no10`.
- `grandeza` é o nome da grandeza física, não o do sensor: `temperatura`, e não `ds18b20`. A única exceção são os sensores MQ (seção 4.1), cuja leitura é relativa e não corresponde a uma grandeza física definida.
- A mesma grandeza tem o mesmo nome em qualquer nó. A temperatura da solução e a do ar da horta são ambas `temperatura`; o nó é que as diferencia.
- Dois nomes são reservados e não podem ser usados como grandeza: `status` (seção 3) e `cmd`, guardado para os comandos de calibração que serão definidos na Etapa 5.

## 2. A mensagem

Cada leitura é uma mensagem, em JSON, numa linha só:

```json
{"valor": 6.12, "unidade": "pH", "seq": 1834, "boot": 7, "t": 1792345678123}
```

| Campo | Tipo | Significado |
| --- | --- | --- |
| `valor` | número | O valor medido, já calibrado |
| `unidade` | texto | A unidade que este catálogo fixa para a grandeza (seção 4) |
| `seq` | inteiro | O número da leitura no nó. É dado no momento da leitura e cresce 1 a cada leitura, de qualquer grandeza, inclusive as que esperam na fila. Volta a 1 quando o nó liga |
| `boot` | inteiro | Quantas vezes o nó já ligou. Fica guardado na memória não volátil do ESP32 (a que não se apaga ao desligar, acessada pela biblioteca Preferences) |
| `t` | inteiro | O instante da leitura, em milissegundos desde 01/01/1970, no fuso UTC (o horário universal; o de Brasília está 3 h atrás) |
| `fila` | inteiro | Opcional. Vale `1` quando a leitura esperou na fila e está sendo reenviada depois de uma queda da rede ou do servidor |

Cada campo existe por causa de um critério de aceitação:

- **`seq` e `boot` medem a perda de pacotes (critério 1).** Se o servidor recebe as leituras 1833 e 1835 do boot 7 do nó `horta/no1`, ele sabe que a 1834 se perdeu. O `boot` separa as contagens, porque o `seq` volta a 1 sempre que o nó reinicia. Como o número é dado na leitura, e não no envio, uma leitura descartada porque a fila encheu também deixa a lacuna e entra na conta. A fila fica na memória flash do ESP32, e não na RAM, para que um reinício do nó não apague as leituras que esperavam envio.
- **`t` mede a latência (critério 2).** O painel avisa o servidor quando desenha cada ponto, e o servidor anota a hora desse aviso no próprio relógio; a latência é essa hora menos o `t`. Assim, o computador ou o celular do painel não precisa estar com o relógio acertado. O tempo de volta do aviso entra na conta, o que só torna a medida mais rigorosa. Leituras com `fila` ficam fora do cálculo, porque o atraso delas é a duração da queda, não o tempo de entrega.
- **`t` também guarda a hora certa** de uma leitura reenviada: ela é gravada no banco com a hora em que foi medida, não com a hora em que chegou.

Regras da mensagem:

- O número usa ponto decimal (`6.12`), nunca vírgula. É exigência do JSON.
- As unidades são escritas só com caracteres ASCII (o conjunto básico, sem acentos nem símbolos especiais): `uS/cm` em vez de `µS/cm`, `C` em vez de `°C`. Isso evita erro de codificação no Arduino e no CSV exportado.
- **Leitura com falha não é publicada e não recebe `seq`.** Contam como falha o `NaN` que o DHT22 devolve quando não responde, os −127 °C do DS18B20 desconectado e qualquer valor fora da faixa de medição do sensor.
- O intervalo padrão de publicação é de **10 s**, o mesmo usado para medir a latência no teste de aceitação.
- As leituras são publicadas com QoS 0 (o nível de entrega sem confirmação, o único que a PubSubClient usa para publicar) e sem *retain*. A perda que esse modo pode causar é exatamente o que o `seq` detecta.

### A hora do nó

A rede da telemetria não tem internet, então o nó acerta o relógio pelo servidor NTP da rede local. Se a rede cair depois disso, o ESP32 continua contando a hora sozinho. Se o nó reiniciar sem acesso ao NTP, usa a hora do RTC DS3231 (um relógio com bateria própria, instalado no nó `horta/no1`); um nó sem DS3231 espera o NTP voltar para começar a medir.

O `t` não cabe em 32 bits. Guarde-o em `int64_t`, que o ArduinoJson aceita no ESP32, e converta antes de multiplicar, senão a conta estoura:

```cpp
struct timeval tv;
gettimeofday(&tv, NULL);
int64_t t = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
```

Não use `millis()`: ele conta o tempo desde que a placa ligou, e não a hora do dia.

### Leituras das placas Arduino pela USB

As placas Arduino Uno não têm rede. Elas escrevem na porta USB uma linha JSON por leitura, com o nó e a grandeza dentro da mensagem:

```json
{"no": "no1", "grandeza": "temperatura", "valor": 27.4, "unidade": "C", "seq": 12}
```

O gateway, no computador ao lado, acrescenta o projeto e a hora (`t`) e envia as leituras ao servidor pelo caminho HTTP, com o usuário e a senha do projeto (seção 6). Ele também cria o `boot`, somando 1 cada vez que o `seq` volta a 1: o Uno reinicia sempre que o gateway abre a porta serial. Como essas placas não usam MQTT, não há LWT: o servidor considera off-line o nó Arduino que passar 30 s sem enviar leitura.

## 3. Estado do nó: o tópico `status`

```
cria/{projeto}/{no}/status
```

A mensagem é o texto simples `online` ou `offline`, sem `seq` e sempre com *retain* (o broker guarda a última mensagem e a entrega a quem assinar depois), para que um painel aberto mais tarde veja o último estado.

- Ao se conectar ao broker, o nó registra a mensagem de última vontade (LWT) `offline` e, em seguida, publica `online`.
- Se o nó cair sem avisar, o próprio broker publica o `offline`. O *keepalive* é o prazo combinado entre o nó e o broker: se o nó passar 15 s sem mandar nada (o padrão da PubSubClient), envia um sinal de vida. Se o broker passar 1,5 vez esse prazo, cerca de 23 s, sem notícia do nó, dá o nó por desconectado. Como o nó publica a cada 10 s, o `offline` aparece entre 13 e 23 s depois da falha.
- É desse tópico que o painel tira o estado on-line ou off-line de cada nó ESP32.

## 4. Projetos registrados

| Projeto | O que é |
| --- | --- |
| `ar` | Monitor de qualidade do ar (projeto-teste 1) |
| `horta` | Bancada hidropônica NFT de 25 posições (projeto-teste 2) |
| `teste` | Oficinas, ensaios de bancada e o teste de reuso (critério 6) |

### 4.1 Projeto `ar`

| Tópico | Sensor | Unidade | Observação |
| --- | --- | --- | --- |
| `cria/ar/no1/mq2` | MQ-2 | `Rs/R0` | Leitura relativa (veja abaixo). Quanto mais gás, menor a razão. Não é concentração |
| `cria/ar/no1/mq135` | MQ-135 | `Rs/R0` | Leitura relativa, como a do MQ-2 |
| `cria/ar/no1/co2` | MH-Z19B | `ppm` | Concentração de CO₂ por infravermelho não dispersivo |
| `cria/ar/no1/temperatura` | DHT22 | `C` | Opcional. Ajuda a interpretar os MQ, que variam com a temperatura e a umidade |
| `cria/ar/no1/umidade` | DHT22 | `%` | Opcional, pelo mesmo motivo |

**O que é o R0 dos sensores MQ.** `Rs` é a resistência do sensor no momento da leitura. `R0` é a resistência medida pelo próprio nó em ar limpo, depois do pré-aquecimento, numa calibração registrada em `calibracao/` com data e local. Em ar limpo, portanto, a razão fica perto de 1. Esse não é o R0 da folha de dados, que é medido sob um gás de referência, e por isso as curvas de ppm da folha de dados não se aplicam aqui. Bibliotecas como a MQUnifiedsensor usam o R0 da folha de dados e publicariam valores cerca de 10 vezes (MQ-2) ou 3,6 vezes (MQ-135) maiores, com a mesma unidade: não as use para calcular o valor publicado.

### 4.2 Projeto `horta`

As oito grandezas do plano de trabalho são as seis do `no1` mais a umidade e a iluminância do `no2`. A temperatura do ar (`no2/temperatura`) é complementar: vem junto com a umidade no DHT22, mas não está entre as oito.

**`no1` — solução nutritiva.** É o nó que leva o RTC DS3231.

| Tópico | Sensor | Unidade | Observação |
| --- | --- | --- | --- |
| `cria/horta/no1/ph` | PH-4502C com eletrodo, pelo ADS1115 | `pH` | Calibrado com os tampões 4,00 e 7,00 |
| `cria/horta/no1/condutividade` | Sensor de condutividade, pelo ADS1115 | `uS/cm` | Referida a 25 °C, com compensação pela temperatura da solução |
| `cria/horta/no1/temperatura` | DS18B20 | `C` | Temperatura da solução, usada na compensação da condutividade |
| `cria/horta/no1/vazao` | YF-S201 | `L/min` | Calibrada pelo fator de pulsos por litro |
| `cria/horta/no1/pressao` | Sensor de pressão de água | `kPa` | Pressão manométrica, isto é, acima da atmosférica |
| `cria/horta/no1/nivel` | Boia | `estado` | `1` = solução acima da boia; `0` = abaixo, hora de repor a solução e proteger a bomba |

**`no2` — ambiente da bancada**

| Tópico | Sensor | Unidade | Observação |
| --- | --- | --- | --- |
| `cria/horta/no2/umidade` | DHT22 | `%` | Umidade relativa do ar |
| `cria/horta/no2/iluminancia` | BH1750 | `lx` | O plano de trabalho fala em irradiância do painel, mas o BH1750 mede iluminância (luz ponderada pela sensibilidade do olho, em lux), e não irradiância (W/m²). Serve para acompanhar o fotoperíodo e grandes variações de intensidade. Não mede a luz útil à planta e subestima os LEDs vermelhos e azuis de cultivo. Veja `decisoes/2026-10-18-iluminancia-no-lugar-de-irradiancia.md` |
| `cria/horta/no2/temperatura` | DHT22 | `C` | Temperatura do ar. Complementar, fora das oito do plano de trabalho |

**`no3` — câmera.** A ESP32-CAM é o nó `no3` da horta. As imagens não passam pelo MQTT; o formato de envio delas será definido junto com o nó, na Etapa 5.

### 4.3 Projeto `teste`

Livre para as oficinas e para o teste de reuso: qualquer nó e qualquer grandeza, desde que sigam as regras da seção 1. É o projeto usado na Oficina 4 (`cria/teste/noX/temperatura`). Os dados de `teste` podem ser apagados pelo coordenador a qualquer momento.

## 5. Como acrescentar uma grandeza ou um projeto

- **Grandeza ou nó novo num projeto que já existe.** Abra um pull request que acrescenta a linha na tabela do projeto. O servidor não muda: ele assina `cria/#` e passa a gravar e a mostrar sozinho qualquer grandeza que siga este catálogo.
- **Projeto novo.** Escolha o nome, confira que ele não está na seção 4 e abra um pull request com a seção do projeto. O coordenador cria o usuário MQTT do projeto, uma única vez; a ACL e o código do servidor não mudam. Para experimentar antes disso, use o projeto `teste`.

## 6. Quem pode publicar onde

O broker recusa conexões sem usuário e senha. Cada projeto tem um usuário com o mesmo nome do projeto, e esse usuário só lê e escreve dentro do próprio projeto. No arquivo de controle de acesso (ACL) do Mosquitto, isso é uma regra só:

```
pattern readwrite cria/%u/#
```

O `%u` é trocado pelo nome do usuário que se conectou. Assim, um nó da `horta` não consegue escrever em `cria/ar/...`, e ninguém de fora da rede publica dados falsos. O servidor tem um usuário próprio, que lê `cria/#` inteiro.

A rota HTTP do servidor, usada pelo gateway das placas Arduino, exige o mesmo usuário e a mesma senha do projeto e aceita leituras apenas desse projeto. Sem isso, ela seria uma porta lateral à ACL.

As senhas nunca vão para o repositório (veja `firmware/credenciais.exemplo.h` e `.env.example`).

## 7. Como conferir na prática

Para ver tudo o que um projeto publica:

```bash
mosquitto_sub -h IP_DO_SERVIDOR -u horta -P SENHA_DA_HORTA -t "cria/horta/#" -v
```

Cada linha mostra o tópico e a mensagem:

```
cria/horta/no1/status online
cria/horta/no1/ph {"valor":6.12,"unidade":"pH","seq":1834,"boot":7,"t":1792345678123}
```
