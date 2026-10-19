#!/usr/bin/env python3
"""Calibração dos sensores de um nó pela USB, com o notebook na bancada.

A ferramenta conversa com a biblioteca CriaTelemetria (classe CriaCalibracao)
do nó: pede médias de 10 amostras do valor bruto em cada solução de referência,
calcula a reta (medida = inclinação x bruto + deslocamento), confere a reta com
uma solução de verificação que não entrou na calibração, grava a reta na memória
do nó e registra tudo em calibracao/, no formato do caderno de projeto.

Uso, na raiz do repositório, com o nó ligado pela USB e o Monitor Serial fechado:

    py calibracao/calibrar.py --porta COM5 ph                 (Windows)
    python3 calibracao/calibrar.py --porta /dev/ttyUSB0 ph    (Linux)
    py calibracao/calibrar.py --porta COM5 --listar

O passo a passo de cada sensor está em calibracao/README.md.
"""

import argparse
import json
import math
import re
import sys
import time
from datetime import datetime
from pathlib import Path

PASTA = Path(__file__).resolve().parent
ARQUIVO_DOS_COEFICIENTES = PASTA / 'coeficientes.csv'

# Como cada sensor é calibrado. "pontos" são os valores de referência sugeridos;
# a pessoa confirma ou digita o valor do rótulo da solução que tem em mãos.
PROCEDIMENTOS = {
    'ph': {
        'modo': 'dois-pontos',
        'pontos': [7.00, 4.00],
        'unidade': 'pH',
        'solucao': 'do tampão',
        'preparo': 'enxágue o eletrodo em água destilada, seque de leve com papel macio, sem esfregar, e mergulhe-o',
        'estabilizar_s': 60,
        'desvio_maximo': 0.01,  # V entre as 10 amostras
        'diferenca_minima': 0.05,  # V entre os dois tampões
        'tolerancia': ('absoluta', 0.2),  # critério 3 do plano de trabalho
        'verificacao': 'tampão 6,86 ou 10,01',
        'faixa_da_referencia': (0, 14),
        # Módulo PH-4502C: a tensão cai quando o pH sobe, cerca de 0,18 V por unidade.
        'faixa_da_inclinacao': (-7.5, -4.0),
    },
    'condutividade': {
        'modo': 'um-ponto-inclinacao',
        'pontos': [1413],
        'unidade': 'uS/cm',
        'solucao': 'da solução-padrão',
        'preparo': 'enxágue a sonda em água destilada, seque e mergulhe-a junto com o DS18B20',
        'estabilizar_s': 60,
        'desvio_maximo': None,
        'diferenca_minima': None,
        'tolerancia': ('relativa', 0.05),  # critério 4 do plano de trabalho
        'verificacao': 'outra solução de valor conhecido, dentro da faixa do sensor',
        # "1.413" digitado com ponto de milhar seria lido como 1,413 uS/cm.
        'faixa_da_referencia': (10, 20000),
        # A curva genérica do sensor raramente erra por mais de 3 vezes.
        'faixa_da_inclinacao': (0.3, 3.0),
    },
    'pressao': {
        'modo': 'um-ponto-deslocamento',
        'pontos': [0],
        'unidade': 'kPa',
        'solucao': 'da referência',
        'preparo': 'deixe o sensor sem pressão: bomba desligada e linha aberta',
        'estabilizar_s': 10,
        'desvio_maximo': None,
        'diferenca_minima': None,
        'tolerancia': None,
        'verificacao': None,
        'faixa_da_referencia': (0, 1200),
        # Folha de dados: 0,5 V sem pressão; um zero longe disso é sensor ou fio com defeito.
        'faixa_do_zero_bruto': (0.2, 0.8),
    },
    'vazao': {
        'modo': 'um-ponto-inclinacao',
        'pontos': [],  # a referência vem do volume e do tempo medidos
        'unidade': 'L/min',
        'solucao': 'da vazão medida',
        'preparo': 'ligue a bomba com a saída num recipiente graduado',
        'estabilizar_s': 10,
        'desvio_maximo': None,
        'diferenca_minima': None,
        'tolerancia': ('relativa', 0.05),
        'verificacao': None,
        'faixa_da_referencia': (0.1, 60),
        # Folha do YF-S201: 7,5 Hz por L/min, ou 0,133 L/min por Hz.
        'faixa_da_inclinacao': (0.05, 0.5),
    },
    'temperatura': {
        'modo': 'um-ponto-deslocamento',
        'pontos': [],
        'unidade': 'C',
        'solucao': 'do termômetro de referência',
        'preparo': 'mergulhe o DS18B20 e o termômetro de referência juntos, num copo com água',
        'estabilizar_s': 120,
        'desvio_maximo': None,
        'diferenca_minima': None,
        'tolerancia': ('absoluta', 0.5),
        'verificacao': None,
        'faixa_da_referencia': (-10, 60),
        'deslocamento_maximo': 3.0,  # o DS18B20 erra no máximo 0,5 °C de fábrica
        # A água muda de temperatura durante a espera: o termômetro é lido depois.
        'referencia_depois_da_medida': True,
    },
}
MODOS = ('dois-pontos', 'um-ponto-inclinacao', 'um-ponto-deslocamento')


class ErroDoNo(Exception):
    """O nó recusou um comando ou não respondeu."""


class Desistiu(Exception):
    """A pessoa pediu para sair."""


# ---------------------------------------------------------------------------
# Números em português


def numero_br(x, casas=4):
    return f'{x:.{casas}f}'.replace('.', ',')


def ler_numero(texto):
    """Aceita "7,00" e "7.00". Devolve None se não for número."""
    texto = texto.strip().replace(',', '.')
    try:
        valor = float(texto)
    except ValueError:
        return None
    return valor if math.isfinite(valor) else None


# ---------------------------------------------------------------------------
# Contas (funções puras, cobertas pelos testes)


def calcular_reta(modo, pontos, inclinacao_atual=None):
    """pontos: lista de (bruto, referencia). Devolve (inclinacao, deslocamento)."""
    if modo == 'dois-pontos':
        if len(pontos) != 2:
            raise ValueError('a calibração de dois pontos precisa de dois pontos')
        (x1, y1), (x2, y2) = pontos
        if x1 == x2:
            raise ValueError('os dois pontos deram o mesmo valor bruto')
        inclinacao = (y2 - y1) / (x2 - x1)
        return inclinacao, y1 - inclinacao * x1
    if len(pontos) != 1:
        raise ValueError('esta calibração usa um ponto só')
    (x, y), = pontos
    if modo == 'um-ponto-inclinacao':
        if x == 0:
            raise ValueError('o valor bruto deu zero: a reta passaria pela origem com inclinação infinita')
        return y / x, 0.0
    if modo == 'um-ponto-deslocamento':
        if inclinacao_atual is None:
            raise ValueError('falta a inclinação atual do nó')
        return inclinacao_atual, y - inclinacao_atual * x
    raise ValueError(f'modo desconhecido: {modo}')


def conferir_reta(procedimento, inclinacao, deslocamento):
    """Devolve a lista de motivos para desconfiar da reta (vazia se ela for plausível)."""
    motivos = []
    faixa = procedimento.get('faixa_da_inclinacao')
    if faixa and not faixa[0] <= inclinacao <= faixa[1]:
        motivos.append(f'a inclinação {numero_br(inclinacao, 4)} está fora da faixa esperada '
                       f'({numero_br(faixa[0], 2)} a {numero_br(faixa[1], 2)})')
    faixa = procedimento.get('faixa_do_zero_bruto')
    if faixa and inclinacao and not faixa[0] <= -deslocamento / inclinacao <= faixa[1]:
        motivos.append(f'o zero do sensor ficou em {numero_br(-deslocamento / inclinacao, 3)}, fora da faixa '
                       f'esperada ({numero_br(faixa[0], 2)} a {numero_br(faixa[1], 2)})')
    maximo = procedimento.get('deslocamento_maximo')
    if maximo is not None and abs(deslocamento) > maximo:
        motivos.append(f'a correção de {numero_br(deslocamento, 2)} passa de {numero_br(maximo, 1)}')
    return motivos


def avaliar(medido, referencia, tolerancia):
    """Devolve (erro, aprovado). tolerancia: ('absoluta', 0.2), ('relativa', 0.05) ou None."""
    erro = medido - referencia
    if tolerancia is None:
        return erro, None
    tipo, limite = tolerancia
    if tipo == 'absoluta':
        return erro, abs(erro) <= limite
    if referencia == 0:
        return erro, None
    return erro, abs(erro / referencia) <= limite


def primeira_maiuscula(texto):
    return texto[:1].upper() + texto[1:]


def reta(nome, inclinacao, unidade_bruta, deslocamento):
    """pH = -5,630000 x V + 21,100000"""
    sinal = '-' if deslocamento < 0 else '+'
    return f'{nome} = {numero_br(inclinacao, 6)} x {unidade_bruta} {sinal} {numero_br(abs(deslocamento), 6)}'


def descrever_tolerancia(tolerancia, unidade):
    if tolerancia is None:
        return 'sem critério definido'
    tipo, limite = tolerancia
    if tipo == 'absoluta':
        return f'± {numero_br(limite, 2)} {unidade}'
    return f'± {numero_br(limite * 100, 0)}%'


# ---------------------------------------------------------------------------
# Registro em calibracao/ (CSV no padrão brasileiro: ";" e vírgula decimal,
# como a exportação do painel; decisoes/2026-10-18-csv-no-padrao-brasileiro.md)

COLUNAS_DOS_PONTOS = ['data_hora', 'no', 'sensor', 'uso', 'referencia', 'unidade', 'bruto_medio', 'unidade_bruta',
                      'desvio', 'amostras', 'temperatura_C', 'medida_calculada', 'erro']
COLUNAS_DOS_COEFICIENTES = ['data_hora', 'no', 'sensor', 'modo', 'inclinacao', 'deslocamento', 'unidade',
                            'unidade_bruta', 'verificacao_referencia', 'verificacao_erro', 'resultado',
                            'gravado_no_no', 'arquivo_dos_pontos']


def celula(valor, casas=6):
    if valor is None:
        return ''
    if isinstance(valor, float):
        return numero_br(valor, casas)
    texto = str(valor)
    # Nada que a planilha leia como fórmula, e nada que quebre a coluna.
    texto = texto.replace(';', ',').replace('\n', ' ').replace('\r', ' ')
    return "'" + texto if texto[:1] in ('=', '+', '-', '@') else texto


def escrever_csv(arquivo, colunas, linhas, acrescentar=False):
    novo = not arquivo.exists() or not acrescentar
    with open(arquivo, 'a' if acrescentar else 'w', encoding='utf-8-sig' if novo else 'utf-8', newline='') as f:
        if novo:
            f.write(';'.join(colunas) + '\r\n')
        for linha in linhas:
            f.write(';'.join(celula(linha.get(c)) for c in colunas) + '\r\n')


def nome_do_arquivo(pasta, quando, sensor, no):
    """calibracao/2026-11-10-ph-no1.csv; se já existir, -2, -3..."""
    base = f'{quando:%Y-%m-%d}-{sensor}-{no.split("/")[-1]}'
    arquivo = pasta / f'{base}.csv'
    n = 2
    while arquivo.exists():
        arquivo = pasta / f'{base}-{n}.csv'
        n += 1
    return arquivo


# ---------------------------------------------------------------------------
# Conversa com o nó


class No:
    """Os comandos "cal" da biblioteca CriaTelemetria, pela serial."""

    def __init__(self, conexao, mostrar_registro=False):
        self.conexao = conexao
        self.mostrar_registro = mostrar_registro
        self.pedaco = bytearray()

    def _proxima_linha(self, fim):
        while time.monotonic() < fim:
            quebra = self.pedaco.find(b'\n')
            if quebra >= 0:
                linha = bytes(self.pedaco[:quebra]).decode('utf-8', errors='replace').strip()
                del self.pedaco[:quebra + 1]
                return linha
            dados = self.conexao.read(max(1, getattr(self.conexao, 'in_waiting', 0) or 0))
            if dados:
                self.pedaco += dados
                if len(self.pedaco) > 4096:  # lixo sem fim de linha
                    self.pedaco.clear()
        return None

    def esperar(self, tipos, prazo_s, ao_receber=None):
        fim = time.monotonic() + prazo_s
        while True:
            linha = self._proxima_linha(fim)
            if linha is None:
                raise ErroDoNo('o nó não respondeu a tempo')
            if not linha.startswith('{"cal"'):
                if self.mostrar_registro and linha:
                    print(f'   nó: {linha}')
                continue
            try:
                dados = json.loads(linha)
            except ValueError:
                continue
            tipo = dados.get('cal')
            if tipo == 'erro':
                raise ErroDoNo(dados.get('motivo', 'erro sem motivo'))
            if tipo in tipos:
                return dados
            if ao_receber:
                ao_receber(dados)

    def pedir(self, comando, tipos, prazo_s=5, ao_receber=None):
        self.conexao.write((comando + '\n').encode('ascii'))
        return self.esperar(tipos, prazo_s, ao_receber)

    def acordar(self, prazo_s=20):
        """Espera o nó responder: abrir a porta pode reiniciar a placa."""
        fim = time.monotonic() + prazo_s
        while time.monotonic() < fim:
            try:
                return self.pedir('cal sensores', {'sensores'}, prazo_s=1.5)
            except ErroDoNo:
                continue
        raise ErroDoNo('o nó não respondeu ao "cal sensores": confira a porta, se o Monitor Serial está fechado '
                       'e se o programa do nó usa a CriaCalibracao')

    def ler(self, sensor):
        return self.pedir(f'cal ler {sensor}', {'bruto'})

    def amostrar(self, sensor, n, intervalo_ms=1000, ao_receber=None):
        self.pedir(f'cal amostrar {sensor} {n} {intervalo_ms}', {'amostrando'})
        return self.esperar({'media'}, prazo_s=n * intervalo_ms / 1000 + 15, ao_receber=ao_receber)

    def gravar(self, sensor, inclinacao, deslocamento, segundos):
        return self.pedir(f'cal gravar {sensor} {inclinacao!r} {deslocamento!r} {int(segundos)}', {'gravado'})


def abrir_porta(porta, baud):
    import serial  # pyserial, a mesma dependência do gateway (gateway/requirements.txt)
    conexao = serial.serial_for_url(porta, baudrate=baud, timeout=0.2, do_not_open=True)
    # Sem mexer no DTR e no RTS, a maioria das placas não reinicia ao abrir a porta.
    conexao.dtr = False
    conexao.rts = False
    conexao.open()
    return conexao


# ---------------------------------------------------------------------------
# Roteiro na bancada


class Bancada:
    """O roteiro interativo. perguntar e mostrar podem ser trocados nos testes."""

    def __init__(self, no, perguntar=input, mostrar=print, esperar=time.sleep, agora=datetime.now):
        self.no = no
        self.perguntar = perguntar
        self.mostrar = mostrar
        self.dormir = esperar
        self.agora = agora
        self.gravacao_enviada = False

    def confirmar(self, pergunta, padrao=False):
        resposta = self.perguntar(f'{pergunta} [{"S/n" if padrao else "s/N"}] ').strip().lower()
        if resposta in ('sair', 'q'):
            raise Desistiu()
        return padrao if not resposta else resposta in ('s', 'sim', 'y')

    def aguardar(self, pergunta):
        if self.perguntar(pergunta).strip().lower() in ('sair', 'q'):
            raise Desistiu()

    def pedir_numero(self, pergunta, padrao=None, opcional=False, faixa=None):
        while True:
            sugestao = f' [{numero_br(padrao, 2)}]' if padrao is not None else ''
            texto = self.perguntar(f'{pergunta}{sugestao}: ').strip()
            if texto.lower() in ('sair', 'q'):
                raise Desistiu()
            if not texto:
                if padrao is not None:
                    return padrao
                if opcional:
                    return None
            valor = ler_numero(texto)
            if valor is not None and faixa and not faixa[0] <= valor <= faixa[1]:
                self.mostrar(f'   {numero_br(valor, 3)} está fora da faixa esperada '
                             f'({numero_br(faixa[0], 2)} a {numero_br(faixa[1], 2)}). Sem ponto de milhar: 1413, não 1.413.')
                continue
            if valor is not None:
                return valor
            self.mostrar('   Não entendi o número. Use vírgula ou ponto, por exemplo 7,00.')

    def estabilizar(self, sensor, segundos, unidade_bruta):
        """Espera a leitura se firmar, mostrando o bruto a cada 10 s."""
        if segundos <= 0:
            return
        self.mostrar(f'   Esperando {segundos} s para a leitura se firmar (Ctrl+C interrompe a ferramenta).')
        restante = segundos
        while restante > 0:
            passo = min(10, restante)
            self.dormir(passo)
            restante -= passo
            try:
                bruto = self.no.ler(sensor)['bruto']
                self.mostrar(f'   faltam {restante:3d} s   bruto agora: {numero_br(bruto, 4)} {unidade_bruta}')
            except ErroDoNo as erro:
                self.mostrar(f'   faltam {restante:3d} s   (leitura falhou: {erro})')

    def medir_ponto(self, sensor, info, procedimento, n, estabilizar_s):
        """Mede um ponto, repetindo se a pessoa quiser. Devolve o resultado da média."""
        while True:
            self.estabilizar(sensor, estabilizar_s, info['unidade'])
            self.mostrar(f'   Coletando {n} amostras, uma por segundo...')
            media = self.no.amostrar(sensor, n)
            self.mostrar(f'   média {numero_br(media["media"], 5)} {info["unidade"]}, '
                         f'desvio {numero_br(media["desvio"], 5)} ({media["n"]} amostras)')
            limite = procedimento.get('desvio_maximo')
            if limite is None or media['desvio'] <= limite:
                return media
            self.mostrar(f'   A leitura está instável: desvio acima de {numero_br(limite, 3)} {info["unidade"]}.')
            if not self.confirmar('   Repetir este ponto?', padrao=True):
                return media

    def temperatura(self, sensores):
        if 'temperatura' not in sensores:
            return None
        try:
            return self.no.ler('temperatura').get('valor')
        except ErroDoNo:
            return None

    def calibrar(self, sensor, modo=None, pontos=None, n=10, estabilizar_s=None, gravar_em=PASTA):
        lista = self.no.acordar()
        nome_do_no = lista.get('no', '?')
        sensores = {s['nome']: s for s in lista.get('sensores', [])}
        if sensor not in sensores:
            raise ErroDoNo(f'o nó {nome_do_no} não tem o sensor "{sensor}". Ele tem: {", ".join(sensores) or "nenhum"}')
        info = sensores[sensor]
        procedimento = PROCEDIMENTOS.get(sensor, {
            'modo': 'dois-pontos', 'pontos': [], 'unidade': '', 'solucao': 'da referência',
            'preparo': 'coloque o sensor na referência', 'estabilizar_s': 30, 'desvio_maximo': None,
            'diferenca_minima': None, 'tolerancia': None, 'verificacao': None})
        modo = modo or procedimento['modo']
        unidade = procedimento['unidade']
        sugeridos = list(pontos if pontos is not None else procedimento['pontos'])
        quantos = 2 if modo == 'dois-pontos' else 1
        estabilizar_s = procedimento['estabilizar_s'] if estabilizar_s is None else estabilizar_s
        inicio = self.agora()

        faixa = procedimento.get('faixa_da_referencia')
        self.mostrar(f'\nCalibração de {sensor} do nó {nome_do_no} ({modo}).')
        if lista.get('memoria', 'cria-cal') != 'cria-cal':
            self.mostrar(f'ATENÇÃO: o nó está no modo simulado (retas em "{lista["memoria"]}"). Esta calibração '
                         'é só um ensaio e não vale para os sensores de verdade.')
        self.mostrar(f'Reta atual: {reta(sensor, info["inclinacao"], info["unidade"], info["deslocamento"])}'
                     + (' (calibrada)' if info['calibrado_em'] else ' (da folha de dados)'))
        self.mostrar('Digite "sair" em qualquer pergunta para desistir sem gravar nada.\n')

        medidos = []
        for i in range(quantos):
            padrao = sugeridos[i] if i < len(sugeridos) else None
            self.mostrar(f'Ponto {i + 1} de {quantos}: {procedimento["preparo"]}.')
            depois = procedimento.get('referencia_depois_da_medida', False)
            if sensor == 'vazao':
                referencia = self.referencia_de_vazao()
            elif not depois:
                referencia = self.pedir_numero(f'   Valor {procedimento["solucao"]}, em {unidade}', padrao, faixa=faixa)
            self.aguardar('   Tecle Enter quando o sensor estiver na solução. ')
            media = self.medir_ponto(sensor, info, procedimento, n, estabilizar_s)
            if depois:
                referencia = self.pedir_numero(f'   Leia agora: valor {procedimento["solucao"]}, em {unidade}', padrao,
                                               faixa=faixa)
            medidos.append({'referencia': referencia, 'media': media, 'temperatura': self.temperatura(sensores)})

        if modo == 'dois-pontos' and procedimento.get('diferenca_minima'):
            diferenca = abs(medidos[0]['media']['media'] - medidos[1]['media']['media'])
            if diferenca < procedimento['diferenca_minima']:
                raise ErroDoNo(f'os dois pontos ficaram a só {numero_br(diferenca, 4)} {info["unidade"]} um do outro: '
                               'o sensor não está respondendo. Confira o eletrodo e a ligação.')

        inclinacao, deslocamento = calcular_reta(
            modo, [(m['media']['media'], m['referencia']) for m in medidos], info['inclinacao'])
        self.mostrar(f'\nReta nova: {reta(sensor, inclinacao, info["unidade"], deslocamento)}')
        suspeitas = conferir_reta(procedimento, inclinacao, deslocamento)
        for motivo in suspeitas:
            self.mostrar(f'   ATENÇÃO: {motivo}. Confira as soluções, a ligação do sensor e os valores digitados.')

        verificacao = None
        if procedimento.get('verificacao') is not None:
            self.mostrar(f'\nVerificação independente, com uma solução que NÃO entrou na calibração '
                         f'({procedimento["verificacao"]}). {primeira_maiuscula(procedimento["preparo"])}.')
            referencia = self.pedir_numero(f'   Valor da solução de verificação, em {unidade} (Enter pula)',
                                           opcional=True, faixa=faixa)
            if referencia is not None:
                self.aguardar('   Tecle Enter quando o sensor estiver na solução. ')
                media = self.medir_ponto(sensor, info, procedimento, n, estabilizar_s)
                medido = inclinacao * media['media'] + deslocamento
                erro, aprovado = avaliar(medido, referencia, procedimento['tolerancia'])
                verificacao = {'referencia': referencia, 'media': media, 'medido': medido, 'erro': erro,
                               'aprovado': aprovado, 'temperatura': self.temperatura(sensores)}
                criterio = descrever_tolerancia(procedimento['tolerancia'], unidade)
                situacao = {True: 'APROVADO', False: 'REPROVADO', None: 'sem critério'}[aprovado]
                self.mostrar(f'   valor calculado: {numero_br(medido, 3)} {unidade}; erro '
                             f'{numero_br(erro, 3)}; critério {criterio}: {situacao}')
                if aprovado is False:
                    self.mostrar('   Antes de repetir: limpe o sensor, troque as soluções abertas há muito tempo '
                                 'e confira a temperatura.')

        gravado = False
        # Sugere gravar só quando a reta é plausível e a verificação (se houve) passou.
        sugerir = not suspeitas and (verificacao is None or bool(verificacao['aprovado']))
        if self.confirmar('\nGravar a reta nova na memória do nó?', padrao=sugerir):
            self.gravacao_enviada = True
            resposta = self.no.gravar(sensor, inclinacao, deslocamento, inicio.timestamp())
            gravado = True
            self.mostrar('   Gravado no nó: '
                         + reta(sensor, resposta['inclinacao'], info['unidade'], resposta['deslocamento']))
        else:
            self.mostrar('   Nada foi gravado no nó; a reta anterior continua valendo.')

        arquivo = self.registrar(gravar_em, inicio, nome_do_no, sensor, modo, unidade, info['unidade'],
                                 inclinacao, deslocamento, medidos, verificacao, gravado)
        self.mostrar(f'\nRegistro: {arquivo} e {arquivo.with_name(ARQUIVO_DOS_COEFICIENTES.name)}. '
                     'Anote no caderno e faça o commit:')
        self.mostrar(f'   git add calibracao/ && git commit -m "Registra a calibração de {sensor} do '
                     f'{nome_do_no.split("/")[-1]} de {inicio:%d/%m}"')
        return {'inclinacao': inclinacao, 'deslocamento': deslocamento, 'verificacao': verificacao,
                'gravado': gravado, 'arquivo': arquivo}

    def referencia_de_vazao(self):
        self.mostrar('   Encha um recipiente graduado com a saída da bomba, cronometrando.')
        litros = self.pedir_numero('   Volume coletado, em litros')
        segundos = self.pedir_numero('   Tempo para encher, em segundos')
        if not segundos or segundos <= 0:
            raise ErroDoNo('o tempo precisa ser maior que zero')
        vazao = litros / segundos * 60
        self.mostrar(f'   Vazão medida: {numero_br(vazao, 3)} L/min. Mantenha a bomba ligada durante a coleta.')
        return vazao

    def registrar(self, pasta, quando, nome_do_no, sensor, modo, unidade, unidade_bruta, inclinacao, deslocamento,
                  medidos, verificacao, gravado):
        pasta.mkdir(parents=True, exist_ok=True)
        arquivo = nome_do_arquivo(pasta, quando, sensor, nome_do_no)
        data_hora = f'{quando:%Y-%m-%d %H:%M}'

        def linha(uso, m, medido=None, erro=None):
            calculada = inclinacao * m['media']['media'] + deslocamento if medido is None else medido
            return {'data_hora': data_hora, 'no': nome_do_no, 'sensor': sensor, 'uso': uso,
                    'referencia': float(m['referencia']), 'unidade': unidade, 'bruto_medio': float(m['media']['media']),
                    'unidade_bruta': unidade_bruta, 'desvio': float(m['media']['desvio']), 'amostras': m['media']['n'],
                    'temperatura_C': None if m['temperatura'] is None else float(m['temperatura']),
                    'medida_calculada': float(calculada),
                    'erro': float(calculada - m['referencia'] if erro is None else erro)}

        linhas = [linha('calibracao', m) for m in medidos]
        if verificacao:
            linhas.append(linha('verificacao', verificacao, verificacao['medido'], verificacao['erro']))
        escrever_csv(arquivo, COLUNAS_DOS_PONTOS, linhas)

        if verificacao is None:
            resultado = 'sem verificação'
        else:
            resultado = {True: 'aprovado', False: 'reprovado', None: 'sem critério'}[verificacao['aprovado']]
        escrever_csv(pasta / ARQUIVO_DOS_COEFICIENTES.name, COLUNAS_DOS_COEFICIENTES, [{
            'data_hora': data_hora, 'no': nome_do_no, 'sensor': sensor, 'modo': modo,
            'inclinacao': float(inclinacao), 'deslocamento': float(deslocamento), 'unidade': unidade,
            'unidade_bruta': unidade_bruta,
            'verificacao_referencia': None if verificacao is None else float(verificacao['referencia']),
            'verificacao_erro': None if verificacao is None else float(verificacao['erro']),
            'resultado': resultado, 'gravado_no_no': 'sim' if gravado else 'não', 'arquivo_dos_pontos': arquivo.name,
        }], acrescentar=True)
        return arquivo


def listar(no):
    lista = no.acordar()
    simulado = lista.get('memoria', 'cria-cal') != 'cria-cal'
    print(f'Nó {lista.get("no")}' + (' (modo simulado: retas de ensaio)' if simulado else '') + ':')
    for s in lista.get('sensores', []):
        if s['calibrado_em']:
            situacao = f'calibrado em {datetime.fromtimestamp(s["calibrado_em"]):%d/%m/%Y %H:%M}'
        else:
            situacao = 'precisa de calibração' if s['exige_calibracao'] else 'reta da folha de dados'
        print(f'  {reta(s["nome"], s["inclinacao"], s["unidade"], s["deslocamento"])}   ({situacao})')


def main():
    analisador = argparse.ArgumentParser(description='Calibração dos sensores de um nó pela USB.')
    analisador.add_argument('sensor', nargs='?', help='ph, condutividade, pressao, vazao, temperatura...')
    analisador.add_argument('--porta', required=True, help='porta serial do nó: COM5, /dev/ttyUSB0')
    analisador.add_argument('--baud', type=int, default=115200)
    analisador.add_argument('--listar', action='store_true', help='só mostra as retas gravadas no nó')
    analisador.add_argument('--modo', choices=MODOS, help='troca o modo padrão do sensor')
    analisador.add_argument('--pontos', nargs='+', type=lambda t: ler_numero(t), help='valores de referência sugeridos')
    analisador.add_argument('--amostras', type=int, default=10, help='amostras por ponto (padrão: 10)')
    analisador.add_argument('--estabilizar', type=int, help='segundos de espera antes de cada ponto')
    analisador.add_argument('--registro', action='store_true', help='mostra também as mensagens do nó')
    analisador.add_argument('--pasta', default=str(PASTA),
                            help='onde gravar os registros (padrão: calibracao/; use outra para ensaiar)')
    opcoes = analisador.parse_args()
    if not opcoes.listar and not opcoes.sensor:
        analisador.error('diga o sensor (ex.: ph) ou use --listar')
    if opcoes.pontos and any(p is None for p in opcoes.pontos):
        analisador.error('--pontos aceita só números, como 7,00 4,00')
    if not 1 <= opcoes.amostras <= 600:
        analisador.error('--amostras vai de 1 a 600')

    try:
        conexao = abrir_porta(opcoes.porta, opcoes.baud)
    except Exception as erro:
        sys.exit(f'Não foi possível abrir {opcoes.porta}: {erro}. Feche o Monitor Serial e confira a porta.')
    no = No(conexao, mostrar_registro=opcoes.registro)
    bancada = Bancada(no)
    # Interrompida depois de mandar gravar, a reta pode já estar no nó.
    aviso_da_gravacao = ('\nATENÇÃO: o comando de gravação já tinha sido enviado; a reta nova pode estar no nó sem '
                         'registro em calibracao/. Confira com --listar.')
    try:
        if opcoes.listar:
            listar(no)
        else:
            bancada.calibrar(opcoes.sensor.lower(), opcoes.modo, opcoes.pontos, opcoes.amostras, opcoes.estabilizar,
                             Path(opcoes.pasta))
    except (ErroDoNo, ValueError) as erro:
        sys.exit(f'ERRO: {erro}' + (aviso_da_gravacao if bancada.gravacao_enviada else ''))
    except (Desistiu, KeyboardInterrupt, EOFError):
        try:
            no.conexao.write(b'cal cancelar\n')
        except Exception:
            pass
        if bancada.gravacao_enviada:
            sys.exit(aviso_da_gravacao)
        sys.exit('\nCalibração interrompida: nada foi gravado no nó nem em calibracao/.')
    finally:
        conexao.close()


if __name__ == '__main__':
    main()
