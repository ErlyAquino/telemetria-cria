# InfluxDB 2, instalado pelo apt, sem Docker

**Data:** 18/10/2026

**O que foi decidido.** O banco de séries temporais é o InfluxDB 2 (edição aberta), instalado direto no Ubuntu ou Debian pelo repositório oficial da InfluxData, junto com o Mosquitto e o chrony, pelo script `servidor/base/instalar.sh`. Nenhum dos três roda em contêiner Docker.

**Por quê.** O InfluxDB 2 continua mantido (em 18/10/2026, o `apt` instalou a versão 2.9.1), traz uma interface web própria para explorar os dados e é a versão usada nos tutoriais da Oficina 9. A instalação pelo `apt` é a mesma que os estudantes fazem com o Mosquitto na Oficina 8: cada programa vira um serviço do sistema, com `systemctl` e `journalctl`, sem uma camada a mais para aprender e depurar num computador que precisa ficar ligado dias seguidos.

**O que se perde.** O desenvolvimento novo da InfluxData está na linha 3, e migrar para ela mais tarde exigirá exportar e reimportar os dados. Sem Docker, a instalação depende de o computador ser Ubuntu ou Debian, e outra escola com outro sistema precisará adaptar o script.
