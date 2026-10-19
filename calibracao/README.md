# Calibração dos sensores

Esta pasta guarda as ferramentas e os registros da calibração. Cada sensor do nó converte um valor bruto (a tensão do eletrodo de pH, a frequência do sensor de vazão) na medida, por uma reta:

```
medida = inclinação × bruto + deslocamento
```

A reta de cada sensor fica gravada na memória do próprio nó, que continua com ela depois de desligado ou de receber um programa novo. O pH e a condutividade só são publicados depois da primeira calibração: sensor sem calibração dá número, não medida.

| Arquivo | O que é |
| --- | --- |
| `calibrar.py` | A ferramenta: conversa com o nó pela USB, calcula a reta, confere e grava |
| `gerar_relatorio.py` | Gera o `relatorio-calibracao.md` a partir dos registros |
| `AAAA-MM-DD-sensor-noX.csv` | Os pontos de cada calibração: referência, média do bruto, desvio, temperatura |
| `coeficientes.csv` | Uma linha por calibração: a reta, a verificação e se ela foi gravada no nó |
| `relatorio-calibracao.md` | O relatório de calibração do projeto, com as retas em uso e o histórico |

Os CSV seguem o padrão brasileiro da exportação do painel (ponto e vírgula, vírgula decimal) e abrem direto no Excel ou no LibreOffice.

## Preparar o notebook

A ferramenta é em Python, como o gateway, e usa a mesma biblioteca (pyserial):

- **Windows:** instale o Python pelo site python.org e, na pasta do repositório, `py -m pip install -r gateway/requirements.txt`.
- **Ubuntu:** `sudo apt install python3-serial`.

Feche o Monitor Serial do Arduino IDE antes de usar: a porta só aceita um programa de cada vez. Para ver as retas gravadas num nó:

```bash
py calibracao/calibrar.py --porta COM5 --listar
```

No Linux, use `python3` no lugar de `py`, e a porta é algo como `/dev/ttyUSB0`.

## pH: dois pontos, tampões 7,00 e 4,00

Material: tampões 4,00 e 7,00 e uma terceira solução para a verificação (6,86 ou 10,01), água destilada, papel macio, os copos e o caderno.

```bash
py calibracao/calibrar.py --porta COM5 ph
```

A ferramenta conduz o roteiro:

1. Mostra a reta atual do nó.
2. Pede o tampão 7,00. Enxágue o eletrodo em água destilada, seque de leve sem esfregar e mergulhe-o. Se o rótulo do tampão disser outro valor na temperatura do dia (por exemplo, 7,02 a 20 °C), digite esse valor.
3. Espera 60 s, mostrando o valor bruto a cada 10 s, e coleta 10 amostras, uma por segundo. Se o desvio entre elas passar de 0,01 V, ela avisa e oferece repetir o ponto.
4. Faz o mesmo com o tampão 4,00 e calcula a reta. Se os dois tampões derem quase a mesma tensão, ela para: o eletrodo ou a ligação não estão respondendo.
5. **Verificação independente:** pede a terceira solução, que não entrou na calibração, mede e compara. O critério do projeto é ±0,2.
6. Pergunta se pode gravar a reta no nó. Se a verificação passou, a resposta padrão é sim.
7. Grava os pontos em `calibracao/AAAA-MM-DD-ph-no1.csv` e acrescenta uma linha a `coeficientes.csv`.

Digitar `sair` em qualquer pergunta, ou Ctrl+C, interrompe sem gravar nada, desde que a gravação ainda não tenha sido pedida. Se a interrupção vier depois de a ferramenta mandar a reta ao nó, ela avisa: a reta pode já estar no nó sem registro em `calibracao/`, e o `--listar` mostra qual vale.

A ferramenta confere os números: um valor de referência fora da faixa do sensor (como `1.413` no lugar de `1413`) é pedido de novo, e uma reta fora do esperado (tampões trocados de copo, eletrodo gasto) é apontada e não é sugerida para gravar.

## Condutividade: um ponto, solução de 1413 µS/cm

```bash
py calibracao/calibrar.py --porta COM5 condutividade
```

Mergulhe a sonda de condutividade **e o DS18B20 juntos** na solução-padrão: o nó usa a temperatura para referir a condutividade a 25 °C. A reta passa pela origem (condutividade zero em água pura) e pelo ponto da solução. Para a verificação, use outra solução de valor conhecido, dentro da faixa do sensor (até cerca de 2000 µS/cm). O critério do projeto é ±5%.

## Outros sensores

| Sensor | Comando | Como |
| --- | --- | --- |
| Pressão | `calibrar.py --porta COM5 pressao` | Ajusta só o zero: a bomba desligada e a linha aberta valem 0 kPa. A inclinação continua a da folha de dados |
| Vazão | `calibrar.py --porta COM5 vazao` | Com a bomba ligada, encha um recipiente graduado cronometrando; a ferramenta pede o volume e o tempo e corrige o fator de pulsos por litro |
| Temperatura | `calibrar.py --porta COM5 temperatura` | Ajusta o zero do DS18B20 contra um termômetro de referência, os dois no mesmo copo d'água. O valor do termômetro é pedido depois da medida, porque a água muda de temperatura durante a espera |

Outras opções: `--amostras N` (padrão 10), `--estabilizar S` (segundos de espera antes de cada ponto), `--pontos 7 4` (troca os valores sugeridos), `--modo` (`dois-pontos`, `um-ponto-inclinacao` ou `um-ponto-deslocamento`) e `--registro` (mostra também as mensagens do nó). Para ensaiar sem gravar nada em `calibracao/`, use `--pasta` com outra pasta.

## Depois de calibrar

1. Anote a calibração no caderno, na página-modelo do Guia do Projeto: material, lotes e validades das soluções, temperatura, o que deu errado.
2. Gere o relatório e faça o commit:

   ```bash
   py calibracao/gerar_relatorio.py
   git add calibracao/
   git commit -m "Registra a calibração de pH do no1 de 10/11"
   ```

O relatório de calibração é o Entregável 5 do projeto, junto com o de validação. O resultado que vale para os critérios 3 e 4 é o da verificação feita no teste de aceitação de 24 h, registrada em `validacao/medidas-manuais.json`.

## Como a ferramenta conversa com o nó

A biblioteca CriaTelemetria (classe `CriaCalibracao`) atende comandos pela serial, a 115200 baud, um por linha. As respostas são linhas JSON que começam com `{"cal":`; as outras linhas são o registro do nó e são ignoradas.

| Comando | Resposta |
| --- | --- |
| `cal sensores` | `{"cal":"sensores","no":"horta/no1","sensores":[{"nome":"ph","unidade":"V","inclinacao":-5.63,"deslocamento":21.1,"calibrado_em":0,"exige_calibracao":true}, ...]}` |
| `cal ler ph` | `{"cal":"bruto","sensor":"ph","bruto":2.5051,"unidade":"V","valor":7.0}` |
| `cal amostrar ph 10 1000` | `{"cal":"amostrando",...}`, depois uma linha `{"cal":"amostra",...}` por amostra e, no fim, `{"cal":"media","sensor":"ph","n":10,"media":2.505,"desvio":0.004,...}` |
| `cal gravar ph -5.63 21.10 1794000000` | `{"cal":"gravado",...}`. O último número é a hora da calibração, em segundos desde 1970 |
| `cal apagar ph` | Volta à reta da folha de dados |
| `cal cancelar` | Interrompe uma amostragem |

A resposta de `cal sensores` traz também `"memoria"`: `cria-cal-sim` quando o nó está no modo simulado. Erros chegam como `{"cal":"erro","motivo":"..."}`. A amostragem não segura o nó entre uma amostra e outra: ele continua publicando e protegendo a bomba. Cada amostra de condutividade, porém, prende o programa por cerca de 1,5 s (a leitura do DS18B20 e o sensor ligado só durante a medida). Os testes da ferramenta rodam sem placa:

```bash
py -m unittest discover -s calibracao
```
