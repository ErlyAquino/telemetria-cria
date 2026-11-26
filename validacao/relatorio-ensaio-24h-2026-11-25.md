# Relatório de validação

Período: de 25/11/2026, 17:47:00 a 26/11/2026, 17:47:00 (24,0 h). Projetos: teste. Gerado em 26/11/2026, 18:16:02 por `npm run relatorio`, na pasta `servidor/`.

## Resumo

| Critério | Exigido | Medido | Resultado |
| --- | --- | --- | --- |
| 1. Perda de pacotes | menos de 1% | 0,20% (70 de 34.843); veja os avisos | **verificar** |
| 2. Latência | menos de 2 s no percentil 95 | p95 207 ms; mediana 59 ms; máxima 7,59 s | **atende** |
| 3. Exatidão do pH | ±0,2 | não informado | pendente |
| 4. Exatidão da condutividade | ±5% | não informado | pendente |
| 5. Disponibilidade do servidor | pelo menos 95% | 99,93% (2.880 janelas de 30 s) | **atende** |
| 6. Reuso | até 30 min | não informado | pendente |

"Verificar" quer dizer que há números, mas algo nos dados pede a análise de uma pessoa (veja os avisos). "Pendente" quer dizer que faltam dados para decidir.

## Avisos

- teste/no10: a última leitura chegou 6 min antes do fim do período.
- teste/no10: passou 10 min seguidos sem nenhuma leitura.

## 1. Perda de pacotes

Em cada boot de cada nó, as leituras esperadas são todas as de `seq` do menor ao maior. No primeiro boot de um nó, o menor é o primeiro `seq` que chegou, porque o boot pode ter começado antes do período; nos boots seguintes, que começaram dentro do período, o menor é 1. As que faltam foram perdidas.

| Nó | Boot | seq | Primeira e última leitura | Recebidas | Esperadas | Perdidas | Perda | Lacunas no seq |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| teste/no6 | 6 | 3285 a 11921 | 25/11/2026, 17:47:07 a 26/11/2026, 17:46:56 | 8.573 | 8.637 | 64 | 0,74% | 3759, 3793, 6909, 8141, 8170, 8183–8185, 8199–8202, 8205–8206, 8222, 8230, e mais 19 faixas |
| teste/no7 | 30 | 95 a 8734 | 25/11/2026, 17:47:05 a 26/11/2026, 17:46:57 | 8.638 | 8.640 | 2 | 0,02% | 603, 5879 |
| teste/no8 | 13 | 4875 a 22152 | 25/11/2026, 17:47:05 a 26/11/2026, 17:46:57 | 17.274 | 17.278 | 4 | 0,02% | 5891–5892, 16443–16444 |
| teste/no10 | 3 | 13 a 300 | 25/11/2026, 17:51:01 a 26/11/2026, 17:41:04 | 288 | 288 | 0 | 0,00% | — |

As leituras perdidas no fim de um boot, logo antes de um reinício, não deixam lacuna e não entram na conta.

## 2. Latência

Medida pelo painel aberto com `?medir=1`: a hora em que o servidor recebe o aviso de que o ponto foi desenhado, menos o `t` da leitura. Leituras que esperaram na fila do nó ficam de fora. Atrasos acima de 60 s entram como 60 s.

- Amostras: 34.688, de 34.735 leituras ao vivo no período (99,9% medidas).
- Mediana: 59 ms; percentil 95: 207 ms; percentil 99: 1,18 s; máxima: 7,59 s.
- Abaixo de 2 s: 99,8% das medidas.

## 3 e 4. Exatidão do pH e da condutividade

- pH: não informado em `validacao/medidas-manuais.json`.
- Condutividade: não informado em `validacao/medidas-manuais.json`.

## 5. Disponibilidade do servidor

O período foi dividido em 2.880 janelas de 30 s. Cada janela vale a fração das suas consultas ao `/saude` que responderam 200; janela sem consulta vale zero. Foram 2.878 consultas no período.

| Início | Fim | Duração | Motivo |
| --- | --- | --- | --- |
| 25/11/2026, 20:05:30 | 25/11/2026, 20:06:00 | 30 s | sem verificação (verificador parado ou sem rede) |
| 26/11/2026, 11:00:30 | 26/11/2026, 11:01:00 | 30 s | sem verificação (verificador parado ou sem rede) |

## 6. Reuso

Não informado em `validacao/medidas-manuais.json`.

## Como este relatório foi feito

- Perda e latência: consultas ao InfluxDB (medidas `leitura` e `latencia_painel`) no período.
- Disponibilidade: arquivos do verificador (`npm run disponibilidade`).
- pH, condutividade e reuso: medidas registradas pela equipe em `validacao/medidas-manuais.json`.
- Os números exigidos são os do plano de trabalho. A latência é avaliada no percentil 95 (veja `decisoes/2026-10-18-latencia-no-percentil-95.md`).
