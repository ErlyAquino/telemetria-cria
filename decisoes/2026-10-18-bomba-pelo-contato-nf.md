# Bomba da horta pelo contato NF do relé, protegida pela boia

**Data:** 18/10/2026

**O que foi decidido.** O nó `horta/no1` só protege a bomba: se a solução ficar abaixo da boia, ele corta a bomba pelo relé cerca de 7 s depois (2 s para confirmar a leitura da boia, contra a ondulação, mais 5 s); quando o nível volta, ele a religa cerca de 1 minuto depois. A decisão é tomada no próprio nó, sem depender da rede, do servidor nem da hora certa. A bomba passa pelo contato NF (normalmente fechado) do relé: o nó só aciona o relé para cortá-la. A boia é montada de modo que o contato feche com a solução acima dela. A válvula solenoide de reposição fica manual por enquanto.

**Por quê.**

- **A falha mais provável não pode secar as raízes.** No NFT, as raízes ficam num filme fino de solução; sem recirculação por algumas horas, a alface murcha. Com a bomba no contato NF, um nó desligado, travado ou sem energia deixa a bomba como ela era antes da telemetria: ligada.
- **A falha da boia fica do lado seguro.** Com o contato fechado quando há solução, um fio solto ou partido lê "abaixo" e corta a bomba, em vez de deixá-la trabalhar em seco.
- **A proteção não espera a rede.** O nó confere a boia em toda volta do programa, mesmo sem Wi-Fi e antes de acertar a hora.
- **A reposição automática tem um risco que a proteção não tem.** Uma válvula que abre sozinha e trava aberta, ou uma boia que não sobe, transborda o reservatório. Ela fica para depois, quando houver uma segunda boia de nível máximo e um tempo máximo de abertura testados na bancada.

**O que se perde.** Se o nó travar justamente com a bomba cortada (relé acionado), ela fica parada até o cão de guarda reiniciar o nó, em 15 s; o painel mostra `bomba` em 0 e o nó off-line. Um defeito que faça o nó reiniciar sem parar deixaria a bomba como na partida: ligada, pelo contato NF. Com o contato NF, o relé fica acionado só enquanto o nível está baixo, mas a bobina consome corrente nesse tempo. A reposição de solução continua manual: o painel avisa pelo `nivel`, e alguém precisa repor.
