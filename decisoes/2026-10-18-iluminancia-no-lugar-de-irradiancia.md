# Iluminância no lugar de irradiância

**Data:** 18/10/2026

**O que foi decidido.** A grandeza de luz da horta se chama `iluminancia`, em lux (`lx`), no tópico `cria/horta/no2/iluminancia`. O plano de trabalho fala em "irradiância do painel de cultivo".

**Por quê.** O sensor comprado, o BH1750, mede iluminância: a luz ponderada pela sensibilidade do olho humano, em lux. Irradiância é potência por área, em W/m², e exige outro tipo de sensor. Dar ao dado o nome de uma grandeza que ele não é levaria quem usa o CSV a uma conclusão errada.

**O que se perde.** O lux não mede a luz que a planta aproveita na fotossíntese e subestima os LEDs vermelhos e azuis do painel de cultivo. A leitura serve para acompanhar o fotoperíodo (quando o painel liga e desliga) e grandes variações de intensidade, mas não para afirmar quanta luz útil chega às plantas. Para isso seria preciso um sensor de PAR, que não está no orçamento.
