# Validação

Esta pasta guarda as evidências do teste de aceitação (Etapa 7) e o relatório com os seis critérios do plano de trabalho. As ferramentas ficam em `servidor/ferramentas/` e rodam a partir da pasta `servidor/`.

| Arquivo | O que é |
| --- | --- |
| `relatorio-validacao.md` | O relatório, gerado por `npm run relatorio` |
| `dados/disponibilidade-AAAA-MM-DD.jsonl` | Uma linha por consulta ao `/saude`, gravada por `npm run disponibilidade` |
| `medidas-manuais.json` | pH, condutividade e reuso, medidos pela equipe. Copie de `medidas-manuais.exemplo.json` e preencha |

## Roteiro do teste de aceitação

### Antes de começar

- Os nós da horta e do monitor de ar estão calibrados e publicando, e o painel mostra todos on-line.
- O servidor está ligado no no-break e rodando: pelo serviço do sistema (`systemctl status telemetria-servidor`, quando ele estiver instalado) ou por `npm start`.

### Preparar o computador do verificador

Use outro computador da rede, de preferência também no no-break. Assim, uma queda do servidor não derruba o verificador junto. Esse computador precisa:

- ter o Node.js 22 ou mais novo e uma cópia deste repositório, com `npm install` feito na pasta `servidor/`;
- ficar sem suspensão, hibernação ou desligamento automático durante todo o teste. Um computador que suspende para de verificar, e cada verificação que falta conta como falha;
- ter o relógio acertado pelo servidor, porque a rede não tem internet. No Windows, num terminal como administrador:

  ```
  w32tm /config /manualpeerlist:IP_DO_SERVIDOR /syncfromflags:manual /update
  w32tm /resync
  ```

  No Linux, ponha `server IP_DO_SERVIDOR iburst` na configuração do chrony ou do timesyncd. O verificador avisa no terminal se o relógio ficar mais de 5 s longe do servidor.

### Ligar o verificador de disponibilidade

Na pasta `servidor/` desse computador:

```bash
npm run disponibilidade -- --url http://IP_DO_SERVIDOR:3000
```

Ele consulta o `/saude` a cada 30 s e grava cada resposta em `validacao/dados/`. Ligue-o alguns minutos antes do início do teste e só o desligue depois do fim.

### Abrir o painel que mede a latência

Num computador ligado na tomada, abra `http://IP_DO_SERVIDOR:3000/?medir=1`. O canto do painel mostra "Conectado: medindo a latência". Deixe a aba à vista durante as 24 h e desligue a proteção de tela, a suspensão e o bloqueio automático. Uma aba oculta não desenha, e o painel não mede.

### Durante as 24 h

Anote a hora de início no caderno de laboratório e não mexa no sistema. Qualquer intervenção (reiniciar um nó, trocar uma peça) vai para o caderno, com a hora.

### Medidas manuais (critérios 3, 4 e 6)

- **pH:** limpe o eletrodo, mergulhe-o na solução-tampão de verificação, que **não** pode ser uma das duas usadas na calibração, espere estabilizar e anote o valor do painel e o valor do frasco.
- **Condutividade:** mesma rotina, com a solução-padrão de verificação. Anote também a temperatura da solução.
- **Reuso:** uma pessoa de fora da equipe segue `tutoriais/01-primeiro-no-esp32.md`, com o cronômetro ligado. Anote o tempo e onde ela travou.

Registre tudo em `validacao/medidas-manuais.json`, no formato do exemplo. Escreva os números com ponto e sem aspas, como no exemplo.

### Gerar o relatório

O relatório é gerado no servidor, onde ficam o `.env` e o token do banco. Antes, copie os arquivos `disponibilidade-*.jsonl` da pasta `validacao/dados/` do computador do verificador para a mesma pasta no servidor (por pendrive, por exemplo). Depois, na pasta `servidor/`, com o horário do teste na hora da escola:

```bash
npm run relatorio -- --inicio 2026-12-08T09:00 --fim 2026-12-09T09:00
```

O terminal mostra o período considerado e o resumo; o relatório completo vai para `validacao/relatorio-validacao.md`. Faça o commit do relatório, dos arquivos de `dados/` e do `medidas-manuais.json`: são a evidência do teste.

Para os ensaios preliminares, o mesmo comando aceita `--horas 2` (as últimas 2 horas). O `--projetos` substitui a lista padrão, que tem todos os projetos menos `teste`: para os dois projetos-teste e as oficinas juntos, use `--projetos ar,horta,teste`. Com períodos menores que 24 h, o relatório se declara preliminar.

### Como ler o resultado

Cada critério recebe um destes resultados:

- **atende** ou **não atende**: os dados bastam, e o número está dentro ou fora do limite;
- **verificar**: há números, mas algo nos dados pede uma análise, por exemplo um nó que passou mais de 5 min sem leituras ou um `seq` que recomeçou. A seção "Avisos" do relatório diz o quê;
- **pendente**: faltam dados para decidir. Pode faltar a medida manual, o arquivo do verificador ou medidas de latência suficientes (o painel precisa medir pelo menos 90% das leituras ao vivo, em todas as horas do período).

## Como cada critério é calculado

| Critério | Cálculo | Fonte |
| --- | --- | --- |
| 1. Perda | Em cada boot de cada nó, as leituras esperadas são as de `seq` do menor ao maior. No primeiro boot de um nó no período, o menor é o primeiro que chegou; nos boots seguintes, o menor é 1. Perda = faltantes ÷ esperadas, somando todos os nós | InfluxDB, medida `leitura` |
| 2. Latência | Percentil 95 das medidas do painel com `?medir=1`; atrasos acima de 60 s entram como 60 s (veja `decisoes/2026-10-18-latencia-no-percentil-95.md`) | InfluxDB, medida `latencia_painel` |
| 3. pH | Diferença entre o painel e a solução de verificação, até ±0,2 | `medidas-manuais.json` |
| 4. Condutividade | Diferença relativa, até ±5% | `medidas-manuais.json` |
| 5. Disponibilidade | O período é dividido em janelas do intervalo do verificador; cada janela vale a fração das suas consultas ao `/saude` que responderam 200, e janela sem consulta vale zero. Disponibilidade = soma das janelas ÷ número de janelas | `dados/` |
| 6. Reuso | Tempo do cronômetro, até 30 min | `medidas-manuais.json` |

O que o cálculo não vê:

- **Perda no fim de um boot.** Leituras perdidas logo antes de um reinício do nó não deixam lacuna no `seq`, porque o boot seguinte recomeça em 1. O relatório lista os nós que reiniciaram, para que essas perdas possam ser investigadas.
- **Projeto `teste`.** Fica fora do teste de aceitação por padrão, porque é o projeto das oficinas.
