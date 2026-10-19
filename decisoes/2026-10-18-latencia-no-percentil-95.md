# Latência avaliada no percentil 95

**Data:** 18/10/2026

**O que foi decidido.** O critério 2 ("latência entre a leitura no nó e a exibição no painel inferior a 2 segundos") é considerado atendido quando o percentil 95 das medidas do teste de aceitação fica abaixo de 2 s, isto é, quando pelo menos 95% das medidas do painel com `?medir=1` ficam abaixo de 2 s. Atrasos acima de 60 s entram nas medidas como 60 s, para contarem acima do limite. O resultado só vale se o painel tiver medido pelo menos 90% das leituras ao vivo, em todas as horas do período; senão, o critério fica pendente. O relatório de validação mostra também a mediana, o percentil 99, a máxima e a fração abaixo de 2 s.

**Por quê.** O plano de trabalho fixa o número, mas não diz sobre quais medidas ele vale. Exigir que todas as leituras de 24 h fiquem abaixo de 2 s faria uma única pausa do Wi-Fi, ou o reenvio das leituras guardadas pelo broker depois de um reinício do servidor, reprovar o critério, embora o painel funcione bem no resto do dia. Usar só a mediana esconderia atrasos que acontecem com frequência. O percentil 95 é a medida usual para tempo de resposta e responde à pergunta do Guia: o comportamento no período todo, e não um caso isolado.

**O que se perde.** Até 5% das leituras podem passar de 2 s sem reprovar o critério. Por isso a máxima e o percentil 99 aparecem no relatório: um atraso grande e raro fica registrado, ainda que não reprove. Por mudar a régua do critério, esta interpretação foi confirmada pelo coordenador em 18/10/2026.
