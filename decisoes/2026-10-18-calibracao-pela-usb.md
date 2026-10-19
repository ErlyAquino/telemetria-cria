# Calibração pela USB, com o notebook na bancada

**Data:** 18/10/2026

**O que foi decidido.** A calibração do pH, da condutividade e dos outros sensores dos nós é feita pela USB: o nó fica ligado ao notebook por um cabo, e a ferramenta `calibracao/calibrar.py` pede ao nó as médias de 10 amostras do valor bruto em cada solução, calcula a reta, confere com uma solução de verificação e grava a reta na memória não volátil do nó. A biblioteca CriaTelemetria (classe `CriaCalibracao`) atende esses comandos pela serial. O nome `cmd` continua reservado no catálogo, mas a calibração não passa pelo MQTT.

**Por quê.**

- **Segurança.** Pelo MQTT, o servidor teria de poder escrever nos tópicos dos nós, e a ACL ganharia uma exceção. Qualquer pessoa com a senha de um projeto poderia mudar a calibração de outro nó do mesmo projeto pela rede. Pela USB, só quem está com o nó na mão calibra.
- **Funciona sem rede.** A calibração acontece na bancada, com os tampões, e não depende de o servidor, o broker ou o Wi-Fi estarem no ar.
- **Registro no formato do caderno.** A ferramenta grava os pontos e a reta em `calibracao/`, com data, temperatura e o resultado da verificação, que são os campos da página-modelo de calibração do Guia do Projeto. O relatório de calibração sai desses arquivos (`calibracao/gerar_relatorio.py`).
- **A reta fica no nó.** Gravar um programa novo no nó não apaga a calibração, e o nó continua publicando valores calibrados mesmo sem o servidor.

**O que se perde.** Para calibrar, alguém precisa levar o notebook até o nó e ligar o cabo USB; não dá para recalibrar à distância, pelo painel. Enquanto a ferramenta está ligada, a porta USB fica ocupada, e o Monitor Serial precisa estar fechado. O pH e a condutividade só são publicados depois da primeira calibração: um nó novo, recém-montado, fica sem essas duas grandezas no painel até alguém calibrá-lo.
