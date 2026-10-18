# CSV no padrão brasileiro por padrão

**Data:** 18/10/2026

**O que foi decidido.** A exportação em CSV do painel sai, por padrão, no formato que o Excel e o LibreOffice em português esperam:

- ponto e vírgula como separador;
- vírgula decimal (`6,12`);
- data e hora no fuso de Recife (`2026-10-18 14:32:07`);
- a marca UTF-8 no início do arquivo.

O formato internacional (vírgula como separador e ponto decimal, sem a marca) continua disponível com `formato=internacional`. Toda linha traz também o instante em milissegundos (`t_ms`), igual ao `t` das mensagens.

**Por quê.** A proposta prevê a exportação "para uso em sala". Um CSV com vírgula como separador e ponto decimal, aberto num Excel em português, junta todas as colunas numa só ou transforma `6.12` em data. Sem a marca UTF-8, o Excel mostra `Ã§` no lugar de `ç`. O estudante que abre o arquivo com dois cliques precisa ver a tabela certa.

**O que se perde.** Ferramentas como Python, R e muitos programas estrangeiros esperam o formato internacional e leem errado o brasileiro se ninguém avisar. Quem for analisar os dados por programa precisa escolher o formato internacional no painel ou na URL.
