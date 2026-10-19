#!/usr/bin/env python3
"""Gateway das placas Arduino: lê as leituras pela USB e as envia ao servidor.

Cada placa escreve uma linha JSON por leitura (mqtt/catalogo-topicos.md, seção 2,
"Leituras das placas Arduino pela USB"):

    {"no": "no1", "grandeza": "temperatura", "valor": 27.4, "unidade": "C", "seq": 12}

O gateway acrescenta a hora da leitura (t) e o boot, e envia as leituras em lote
para a rota HTTP do servidor (POST /api/leituras), com o usuário e a senha do
projeto. As outras mensagens da placa aparecem no terminal como "placa: ...".

O trabalho é dividido em duas partes, que rodam ao mesmo tempo:
  - o LeitorDaPlaca lê a porta serial e marca a hora de cada linha na chegada;
  - o laço principal envia ao servidor, mesmo com a placa desconectada.

Uso, na raiz do repositório:

    py gateway/gateway.py --porta COM5               (Windows)
    python3 gateway/gateway.py --porta /dev/ttyACM0  (Linux)

O projeto e a senha vêm do .env da raiz (GATEWAY_PROJETO, GATEWAY_SENHA), assim
como o endereço do servidor (SERVIDOR_URL) e a porta padrão (PORTA_SERIAL).
"""

import argparse
import base64
import http.client
import json
import math
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PASTA_DO_ESTADO = Path(__file__).resolve().parent / '.estado'

# Regras do catálogo (seções 1 e 2), as mesmas que o servidor confere.
NO_VALIDO = re.compile(r'^no[1-9][0-9]{0,3}$')
NOME_VALIDO = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
UNIDADE_VALIDA = re.compile(r'^[A-Za-z%][A-Za-z0-9%/._-]{0,19}$')
GRANDEZAS_RESERVADAS = {'status', 'cmd'}
MAIOR_CONTADOR = 2**31 - 1

LEITURAS_POR_ENVIO = 1000  # limite da rota HTTP do servidor
MAXIMO_NA_FILA = 20000  # leituras esperando o servidor voltar
ESPERA_ANTES_DE_ENVIAR_S = 0.3  # junta as linhas que chegam juntas num só envio
ESPERA_MAXIMA_NA_FILA_S = 1.0  # uma leitura nunca espera mais que isto para sair
ESPERA_MAXIMA_ENTRE_TENTATIVAS_S = 30
PRAZO_DO_SERVIDOR_S = 20  # o servidor pode levar até 15 s para confirmar ao broker
ESPERA_PARA_REABRIR_A_PORTA_S = 5
TAMANHO_MAXIMO_DA_LINHA = 1024
SEM_LEITURA_ATE_AVISAR_S = 30
DIFERENCA_DE_RELOGIO_TOLERADA_MS = 2000  # o cabeçalho Date tem precisão de 1 s
TEMPO_PARA_ENVIAR_AO_SAIR_S = 30


def agora_ms():
    return int(time.time() * 1000)


def avisar(mensagem):
    print(f'{time.strftime("%H:%M:%S")}  {mensagem}', flush=True)


def leituras(n):
    return f'{n} leitura' if n == 1 else f'{n} leituras'


class ErroFatal(Exception):
    """Erro que nenhuma nova tentativa resolve, como senha errada."""


# ---------------------------------------------------------------------------
# Configuração


def carregar_env(arquivo):
    """Lê CHAVE=valor do .env sem sobrescrever o que já está no ambiente.

    Aceita o arquivo com marca UTF-8 (BOM), valores entre aspas e comentário no
    fim da linha (" # ..."), como o servidor, que lê o mesmo arquivo.
    """
    if not arquivo.exists():
        return
    for linha in arquivo.read_text(encoding='utf-8-sig').splitlines():
        linha = linha.strip()
        if not linha or linha.startswith('#') or '=' not in linha:
            continue
        chave, valor = (parte.strip() for parte in linha.split('=', 1))
        if valor[:1] in ('"', "'") and valor[-1:] == valor[:1] and len(valor) >= 2:
            valor = valor[1:-1]
        else:
            valor = re.split(r'\s+#', valor, maxsplit=1)[0].strip()
        os.environ.setdefault(chave, valor)


# ---------------------------------------------------------------------------
# Linhas que chegam da placa


def interpretar_linha(texto):
    """Confere uma linha da placa.

    Devolve (leitura, None) se a linha for uma leitura válida, (None, motivo) se
    for um JSON fora do catálogo, ou (None, None) se não for JSON (mensagem da
    placa).
    """
    texto = texto.strip()
    if not texto.startswith('{'):
        return None, None
    try:
        dados = json.loads(texto)
    except ValueError:
        return None, 'JSON inválido'
    if not isinstance(dados, dict):
        return None, 'a linha não é um objeto JSON'

    no = dados.get('no')
    grandeza = dados.get('grandeza')
    valor = dados.get('valor')
    unidade = dados.get('unidade')
    seq = dados.get('seq')
    if not isinstance(no, str) or not NO_VALIDO.match(no):
        return None, 'no ausente ou fora do catálogo (no1, no2, ...)'
    if not isinstance(grandeza, str) or not NOME_VALIDO.match(grandeza) or grandeza in GRANDEZAS_RESERVADAS:
        return None, 'grandeza ausente, fora do catálogo ou reservada'
    # bool é um tipo de int em Python: true não pode passar por número.
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return None, 'valor ausente ou não numérico'
    try:
        if not math.isfinite(valor):
            return None, 'valor ausente ou não numérico'
    except OverflowError:  # inteiro grande demais para virar número decimal
        return None, 'valor ausente ou não numérico'
    if not isinstance(unidade, str) or not UNIDADE_VALIDA.match(unidade):
        return None, 'unidade ausente ou fora do catálogo'
    if isinstance(seq, bool) or not isinstance(seq, int) or not 1 <= seq <= MAIOR_CONTADOR:
        return None, 'seq ausente ou fora de 1 a 2147483647'
    return {'no': no, 'grandeza': grandeza, 'valor': valor, 'unidade': unidade, 'seq': seq}, None


class SeparadorDeLinhas:
    """Junta os pedaços que chegam da serial até completar cada linha.

    Uma pausa no meio de uma linha não a parte em duas. Linha sem fim maior que
    o limite (lixo na serial, velocidade errada) é descartada.
    """

    def __init__(self, limite=TAMANHO_MAXIMO_DA_LINHA):
        self.limite = limite
        self.pedaco = bytearray()

    def adicionar(self, dados):
        self.pedaco += dados
        linhas = []
        while True:
            fim = self.pedaco.find(b'\n')
            if fim < 0:
                break
            linhas.append(bytes(self.pedaco[:fim]).rstrip(b'\r'))
            del self.pedaco[:fim + 1]
        if len(self.pedaco) > self.limite:
            self.pedaco.clear()
        return linhas


class MarcadorDeHora:
    """Dá a cada leitura a hora de chegada, sempre crescente em cada série.

    Duas leituras da mesma série com a mesma hora virariam um ponto só no banco.
    """

    def __init__(self):
        self.ultimo = {}

    def marcar(self, no, grandeza, agora):
        serie = (no, grandeza)
        t = max(agora, self.ultimo.get(serie, 0) + 1)
        self.ultimo[serie] = t
        return t


def _travar(arquivo):
    """Trava o arquivo para este processo. Devolve falso se outro já o travou."""
    try:
        if os.name == 'nt':
            import msvcrt
            arquivo.seek(0)
            msvcrt.locking(arquivo.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(arquivo.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


class ControleDeBoot:
    """Cria o boot de cada nó, que as placas Arduino não guardam.

    A placa recomeça o seq em 1 sempre que reinicia. O boot só muda quando o seq
    volta (fica menor ou igual ao último recebido): uma placa que continuou
    contando enquanto o gateway estava parado mantém o boot, e as leituras feitas
    nesse meio-tempo aparecem como lacuna no seq, que é o certo.

    O último boot e o último seq de cada nó ficam num arquivo próprio,
    .estado/<projeto>-<no>.json. Um segundo gateway que tente usar o mesmo nó
    neste computador é recusado, para não repetir boots.
    """

    def __init__(self, projeto, pasta=PASTA_DO_ESTADO):
        self.projeto = projeto
        self.pasta = Path(pasta)
        self.nos = {}  # no -> {'boot', 'seq', 'trava'}

    def _arquivo(self, no):
        return self.pasta / f'{self.projeto}-{no}.json'

    def _carregar(self, no):
        self.pasta.mkdir(parents=True, exist_ok=True)
        trava = open(self.pasta / f'{self.projeto}-{no}.trava', 'a+', encoding='utf-8')
        if not _travar(trava):
            trava.close()
            raise ErroFatal(f'outro gateway deste computador já está usando o nó {self.projeto}/{no}. '
                            'Cada placa precisa de um nó só seu (o NO do programa da placa).')
        estado = {'boot': 0, 'seq': None}
        arquivo = self._arquivo(no)
        if arquivo.exists():
            try:
                lido = json.loads(arquivo.read_text(encoding='utf-8'))
                boot, seq = lido['boot'], lido['seq']
                if not isinstance(boot, int) or boot < 0 or not (seq is None or isinstance(seq, int)):
                    raise ValueError
                estado = {'boot': boot, 'seq': seq}
            except (ValueError, KeyError, TypeError):
                trava.close()
                raise ErroFatal(f'o arquivo {arquivo} está corrompido. Confira o último boot do nó no banco '
                                'e corrija o arquivo, para não repetir boots.') from None
        estado['trava'] = trava
        self.nos[no] = estado
        return estado

    def boot_para(self, no, seq):
        estado = self.nos.get(no) or self._carregar(no)
        if estado['seq'] is None or seq <= estado['seq']:
            estado['boot'] += 1
            if estado['seq'] is not None:
                avisar(f'{no}: o seq voltou para {seq}; a placa reiniciou (boot {estado["boot"]}).')
        estado['seq'] = seq
        self._salvar(no, estado)
        return estado['boot']

    def _salvar(self, no, estado):
        # Grava num temporário e troca: o arquivo nunca fica pela metade.
        arquivo = self._arquivo(no)
        temporario = arquivo.with_name(f'{arquivo.name}.{os.getpid()}.tmp')
        try:
            temporario.write_text(json.dumps({'boot': estado['boot'], 'seq': estado['seq']}), encoding='utf-8')
            temporario.replace(arquivo)
        except OSError as erro:
            avisar(f'AVISO: não foi possível gravar {arquivo} ({erro}); se o gateway reiniciar agora, '
                   f'o boot de {no} pode se repetir.')

    def fechar(self):
        for estado in self.nos.values():
            estado['trava'].close()
        self.nos.clear()


class LeitorDaPlaca(threading.Thread):
    """Lê a porta serial e entrega as leituras, já com t e boot, na fila de saída."""

    def __init__(self, porta, baud, boots, saida, abrir=None):
        super().__init__(daemon=True)
        self.porta = porta
        self.baud = baud
        self.boots = boots
        self.saida = saida
        self.abrir = abrir or self._abrir_porta
        self.marcador = MarcadorDeHora()
        self.erro = None  # ErroFatal que deve parar o gateway

    def _abrir_porta(self):
        import serial  # pyserial, a única dependência (gateway/requirements.txt)
        # serial_for_url aceita COM5, /dev/ttyACM0 e também socket://host:porta,
        # útil para ensaiar sem placa. "exclusive" impede dois programas na mesma porta.
        return serial.serial_for_url(self.porta, baudrate=self.baud, timeout=0.2, exclusive=True)

    def run(self):
        try:
            while True:
                self._ler_ate_cair()
                time.sleep(ESPERA_PARA_REABRIR_A_PORTA_S)
        except ErroFatal as erro:
            self.erro = erro
        except Exception as erro:  # defeito do gateway: melhor parar do que seguir sem ler
            self.erro = ErroFatal(f'erro inesperado na leitura da placa: {erro!r}')

    def _ler_ate_cair(self):
        try:
            conexao = self.abrir()
        except Exception as erro:  # porta inexistente, ocupada, sem permissão
            avisar(f'não foi possível abrir {self.porta} ({erro}); nova tentativa em {ESPERA_PARA_REABRIR_A_PORTA_S} s.')
            return
        avisar(f'porta {self.porta} aberta a {self.baud} baud; esperando leituras.')
        separador = SeparadorDeLinhas()
        aberta_em = time.monotonic()
        ultima_valida = None
        avisou_silencio = False
        ultima_mensagem = None
        try:
            while True:
                dados = conexao.read(max(1, getattr(conexao, 'in_waiting', 0) or 0))
                chegada = agora_ms()
                for linha in separador.adicionar(dados) if dados else []:
                    texto = linha.decode('utf-8', errors='replace').strip()
                    leitura, motivo = interpretar_linha(texto)
                    if leitura:
                        leitura['t'] = self.marcador.marcar(leitura['no'], leitura['grandeza'], chegada)
                        leitura['boot'] = self.boots.boot_para(leitura['no'], leitura['seq'])
                        self.saida.put(leitura)
                        ultima_valida = time.monotonic()
                    elif motivo:
                        avisar(f'linha ignorada ({motivo}): {texto[:80]}')
                    elif texto and texto != ultima_mensagem:
                        avisar(f'placa: {texto[:120]}')
                        ultima_mensagem = texto
                desde = ultima_valida or aberta_em
                if not avisou_silencio and time.monotonic() - desde > SEM_LEITURA_ATE_AVISAR_S:
                    avisar(f'nenhuma leitura válida há {SEM_LEITURA_ATE_AVISAR_S} s: confira o --baud '
                           '(o programa da placa usa 115200), a fiação do sensor e o programa da placa.')
                    avisou_silencio = True
                if ultima_valida and time.monotonic() - ultima_valida < 1:
                    avisou_silencio = False
        except ErroFatal:
            conexao.close()
            raise
        except Exception as erro:  # placa desconectada no meio da leitura
            avisar(f'a placa foi desconectada ({erro}); tentando reabrir {self.porta}.')
            try:
                conexao.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Envio ao servidor


def criar_post_http(servidor, projeto, senha, prazo_s=PRAZO_DO_SERVIDOR_S):
    """Devolve uma função que envia uma lista de leituras e devolve
    (status, resposta, hora do servidor em ms ou None)."""
    endereco = servidor.rstrip('/') + '/api/leituras'
    credencial = base64.b64encode(f'{projeto}:{senha}'.encode('utf-8')).decode('ascii')
    # Sem proxy: a senha do projeto vai direto ao servidor da rede local.
    abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def hora_do_servidor(cabecalhos):
        try:
            return int(parsedate_to_datetime(cabecalhos.get('Date')).timestamp() * 1000)
        except (TypeError, ValueError):
            return None

    def objeto(corpo):
        return corpo if isinstance(corpo, dict) else {}

    def post(lote):
        pedido = urllib.request.Request(
            endereco,
            data=json.dumps(lote).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Authorization': f'Basic {credencial}'},
            method='POST',
        )
        try:
            with abridor.open(pedido, timeout=prazo_s) as resposta:
                return resposta.status, objeto(json.loads(resposta.read() or b'{}')), hora_do_servidor(resposta.headers)
        except urllib.error.HTTPError as erro:
            try:
                corpo = objeto(json.loads(erro.read() or b'{}'))
            except ValueError:
                corpo = {}
            return erro.code, corpo, hora_do_servidor(erro.headers)

    return post


class Enviador:
    """Guarda as leituras e as envia ao servidor, tentando de novo quando ele falha."""

    def __init__(self, post):
        self.post = post
        self.fila = []
        self.espera_s = 0
        self.proxima_tentativa = 0.0
        self.ultima_chegada = 0.0
        self.avisou_relogio = False

    def adicionar(self, leitura, agora=None):
        agora = time.monotonic() if agora is None else agora
        # Leitura que chega enquanto o gateway espera para tentar de novo também
        # vai atrasada por causa da queda: sai marcada como da fila.
        if self.espera_s > 0:
            leitura['fila'] = 1
        leitura['_chegada'] = agora
        if len(self.fila) >= MAXIMO_NA_FILA:
            descartada = self.fila.pop(0)
            avisar(f'AVISO: fila cheia; leitura {descartada["no"]} seq {descartada["seq"]} descartada.')
        self.fila.append(leitura)
        self.ultima_chegada = agora

    def pronto(self, agora):
        """Hora de enviar? Quando as linhas param de chegar por um instante, quando a
        leitura mais antiga já esperou demais ou quando o lote encheu."""
        if not self.fila or agora < self.proxima_tentativa:
            return False
        return (agora - self.ultima_chegada >= ESPERA_ANTES_DE_ENVIAR_S
                or agora - self.fila[0]['_chegada'] >= ESPERA_MAXIMA_NA_FILA_S
                or len(self.fila) >= LEITURAS_POR_ENVIO)

    def enviar(self, agora=None):
        """Envia um lote. Devolve quantas leituras o servidor aceitou."""
        agora = time.monotonic() if agora is None else agora
        lote = self.fila[:LEITURAS_POR_ENVIO]
        corpo = [{chave: valor for chave, valor in l.items() if not chave.startswith('_')} for l in lote]
        enviado_em = agora_ms()
        try:
            status, resposta, hora_do_servidor = self.post(corpo)
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as erro:
            motivo = getattr(erro, 'reason', erro)
            return self._falhou(agora, f'servidor fora do alcance ({motivo})')
        self._conferir_relogio(enviado_em, hora_do_servidor)

        if status in (401, 403):
            raise ErroFatal(f'o servidor recusou o projeto: {resposta.get("erro", status)}. '
                            'Confira GATEWAY_PROJETO e GATEWAY_SENHA no .env.')
        if status in (200, 400):
            # 400: nenhuma leitura do lote era válida. Repetir não adianta.
            del self.fila[:len(lote)]
            self.espera_s = 0
            recusadas = [r for r in resposta.get('recusadas') or [] if isinstance(r, dict)]
            for recusada in recusadas:
                indice = recusada.get('indice')
                leitura = lote[indice] if isinstance(indice, int) and 0 <= indice < len(lote) else {}
                avisar(f'recusada pelo servidor: {leitura.get("no")}/{leitura.get("grandeza")} '
                       f'seq {leitura.get("seq")}: {recusada.get("motivo")}')
            if status == 400 and not recusadas:
                avisar(f'o servidor recusou o lote de {leituras(len(lote))}: {resposta.get("erro", "sem detalhe")}')
            return resposta.get('aceitas', 0)
        return self._falhou(agora, f'o servidor respondeu {status} ({resposta.get("erro", "sem detalhe")})')

    def _conferir_relogio(self, enviado_em, hora_do_servidor):
        # A hora das leituras vem deste computador: ele precisa estar acertado
        # pelo servidor, senão a latência sai errada ou o servidor recusa as leituras.
        if hora_do_servidor is None or self.avisou_relogio:
            return
        diferenca = hora_do_servidor - enviado_em
        if abs(diferenca) > DIFERENCA_DE_RELOGIO_TOLERADA_MS:
            avisar(f'AVISO: o relógio deste computador está {abs(diferenca) / 1000:.0f} s '
                   f'{"atrasado" if diferenca > 0 else "adiantado"} em relação ao servidor. '
                   'Acerte-o pelo servidor (veja gateway/README.md).')
            self.avisou_relogio = True

    def _falhou(self, agora, motivo):
        # As leituras esperam: quando saírem, vão marcadas como da fila.
        for leitura in self.fila:
            leitura['fila'] = 1
        self.espera_s = min(ESPERA_MAXIMA_ENTRE_TENTATIVAS_S, max(1, self.espera_s * 2))
        self.proxima_tentativa = agora + self.espera_s
        avisar(f'{motivo}; {leituras(len(self.fila))} esperando, nova tentativa em {self.espera_s} s.')
        return 0


# ---------------------------------------------------------------------------
# Laço principal: envia o que o leitor entrega, com a placa ligada ou não


def rodar(leitor, enviador):
    leitor.start()
    while True:
        try:
            enviador.adicionar(leitor.saida.get(timeout=0.1))
            while True:
                enviador.adicionar(leitor.saida.get_nowait())
        except queue.Empty:
            pass
        if leitor.erro:
            raise leitor.erro
        agora = time.monotonic()
        if enviador.pronto(agora):
            lote = enviador.fila[:LEITURAS_POR_ENVIO]
            aceitas = enviador.enviar(agora)
            if aceitas:
                nos = sorted({f'{l["no"]} boot {l["boot"]}' for l in lote})
                avisar(f'{leituras(aceitas)} enviada{"s" if aceitas > 1 else ""} '
                       f'({", ".join(nos)}); seq até {lote[-1]["seq"]}.')


def enviar_o_que_falta(leitor, enviador):
    """Ao encerrar: tenta enviar tudo o que espera, por até 30 s."""
    try:
        while True:
            enviador.adicionar(leitor.saida.get_nowait())
    except queue.Empty:
        pass
    if not enviador.fila:
        return
    avisar(f'encerrando: {leituras(len(enviador.fila))} na fila; enviando...')
    prazo = time.monotonic() + TEMPO_PARA_ENVIAR_AO_SAIR_S
    try:
        while enviador.fila and time.monotonic() < prazo:
            antes = len(enviador.fila)
            enviador.enviar()
            if len(enviador.fila) >= antes:
                break  # o servidor não aceitou: não adianta insistir agora
    except (ErroFatal, KeyboardInterrupt):
        pass
    if enviador.fila:
        n = len(enviador.fila)
        avisar(f'{leituras(n)} não {"pôde ser enviada e se perdeu" if n == 1 else "puderam ser enviadas e se perderam"}.')


def main():
    analisador = argparse.ArgumentParser(description='Gateway das placas Arduino da rede de telemetria.')
    analisador.add_argument('--porta', help='porta serial: COM5, /dev/ttyACM0 (padrão: PORTA_SERIAL do .env)')
    analisador.add_argument('--baud', type=int, default=115200, help='velocidade da serial (padrão: 115200)')
    analisador.add_argument('--servidor', help='endereço do servidor (padrão: SERVIDOR_URL do .env)')
    analisador.add_argument('--env', default=str(RAIZ / '.env'), help='arquivo .env (padrão: o da raiz do repositório)')
    opcoes = analisador.parse_args()

    carregar_env(Path(opcoes.env))
    porta = opcoes.porta or os.environ.get('PORTA_SERIAL')
    servidor = opcoes.servidor or os.environ.get('SERVIDOR_URL', 'http://127.0.0.1:3000')
    projeto = os.environ.get('GATEWAY_PROJETO', '')
    senha = os.environ.get('GATEWAY_SENHA', '')
    if not porta:
        sys.exit('Falta a porta serial: use --porta ou PORTA_SERIAL no .env.')
    if not re.match(r'^https?://', servidor):
        sys.exit(f'SERVIDOR_URL precisa começar com http://, por exemplo http://192.168.0.10:3000 (está "{servidor}").')
    if not NOME_VALIDO.match(projeto) or projeto == 'servidor':
        sys.exit('GATEWAY_PROJETO ausente ou fora do catálogo no .env (ex.: GATEWAY_PROJETO=teste).')
    if not senha:
        sys.exit('Falta GATEWAY_SENHA no .env: é a senha MQTT do projeto.')

    leitor = LeitorDaPlaca(porta, opcoes.baud, ControleDeBoot(projeto), queue.Queue())
    enviador = Enviador(criar_post_http(servidor, projeto, senha))
    avisar(f'gateway do projeto "{projeto}" enviando para {servidor}. Ctrl+C encerra.')
    try:
        rodar(leitor, enviador)
    except ErroFatal as erro:
        sys.exit(f'{time.strftime("%H:%M:%S")}  ERRO: {erro}')
    except KeyboardInterrupt:
        enviar_o_que_falta(leitor, enviador)


if __name__ == '__main__':
    main()
