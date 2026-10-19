"""Testes da ferramenta de calibração, sem placa. Rode, na raiz do repositório:

    py -m unittest discover -s calibracao               (Windows)
    python3 -m unittest discover -s calibracao          (Linux)
"""

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import calibrar
import gerar_relatorio
from calibrar import Bancada, Desistiu, ErroDoNo, No, avaliar, calcular_reta


class Contas(unittest.TestCase):
    def test_dois_pontos_do_exemplo_do_guia(self):
        # Página-modelo do caderno: tampão 7,00 -> 2,505 V; tampão 4,00 -> 3,038 V.
        inclinacao, deslocamento = calcular_reta('dois-pontos', [(2.505, 7.00), (3.038, 4.00)])
        self.assertAlmostEqual(inclinacao, -5.63, places=2)
        self.assertAlmostEqual(deslocamento, 21.10, places=2)
        # Verificação com o tampão 6,86: 2,515 V -> pH 6,94, erro +0,08: aprovado.
        erro, aprovado = avaliar(inclinacao * 2.515 + deslocamento, 6.86, ('absoluta', 0.2))
        self.assertAlmostEqual(erro, 0.08, places=2)
        self.assertTrue(aprovado)

    def test_um_ponto(self):
        self.assertEqual(calcular_reta('um-ponto-inclinacao', [(1380.0, 1413.0)]), (1413.0 / 1380.0, 0.0))
        inclinacao, deslocamento = calcular_reta('um-ponto-deslocamento', [(0.53, 0.0)], inclinacao_atual=300.0)
        self.assertEqual(inclinacao, 300.0)
        self.assertAlmostEqual(deslocamento, -159.0)

    def test_pontos_impossiveis(self):
        with self.assertRaises(ValueError):
            calcular_reta('dois-pontos', [(2.5, 7.0), (2.5, 4.0)])
        with self.assertRaises(ValueError):
            calcular_reta('um-ponto-inclinacao', [(0.0, 1413.0)])
        with self.assertRaises(ValueError):
            calcular_reta('dois-pontos', [(2.5, 7.0)])

    def test_tolerancia_relativa(self):
        self.assertEqual(avaliar(1452, 1413, ('relativa', 0.05))[1], True)
        self.assertEqual(avaliar(1500, 1413, ('relativa', 0.05))[1], False)
        self.assertIsNone(avaliar(3, 2, None)[1])

    def test_reta_implausivel_e_apontada(self):
        ph = calibrar.PROCEDIMENTOS['ph']
        self.assertEqual(calibrar.conferir_reta(ph, -5.63, 21.1), [])
        self.assertEqual(len(calibrar.conferir_reta(ph, 5.63, -7.0)), 1)  # sinal trocado
        pressao = calibrar.PROCEDIMENTOS['pressao']
        self.assertEqual(calibrar.conferir_reta(pressao, 300, -150), [])  # zero em 0,5 V
        self.assertEqual(len(calibrar.conferir_reta(pressao, 300, -30)), 1)  # zero em 0,1 V
        temperatura = calibrar.PROCEDIMENTOS['temperatura']
        self.assertEqual(len(calibrar.conferir_reta(temperatura, 1, 4.5)), 1)

    def test_numeros_em_portugues(self):
        self.assertEqual(calibrar.ler_numero('7,00'), 7.0)
        self.assertEqual(calibrar.ler_numero(' 1413 '), 1413.0)
        self.assertIsNone(calibrar.ler_numero('sete'))
        self.assertIsNone(calibrar.ler_numero('nan'))
        self.assertEqual(calibrar.numero_br(-5.6286, 3), '-5,629')


class NoFalso:
    """Imita os comandos "cal" da CriaCalibracao, com uma média por amostragem pedida."""

    def __init__(self, medias, temperatura=24.6, mensagens_extras=True, memoria='cria-cal'):
        self.medias = list(medias)
        self.temperatura = temperatura
        self.memoria = memoria
        self.saida = bytearray()
        self.gravados = []
        self.sensores = [
            {'nome': 'ph', 'unidade': 'V', 'inclinacao': -5.63, 'deslocamento': 21.1, 'calibrado_em': 0,
             'exige_calibracao': True},
            {'nome': 'temperatura', 'unidade': 'C', 'inclinacao': 1, 'deslocamento': 0, 'calibrado_em': 0,
             'exige_calibracao': False},
        ]
        if mensagens_extras:  # o nó também escreve o próprio registro na serial
            self.responder_texto('[cria] nó cria/horta/no1, biblioteca CriaTelemetria 0.2.0')

    @property
    def in_waiting(self):
        return len(self.saida)

    def responder_texto(self, texto):
        self.saida += (texto + '\r\n').encode()

    def responder(self, **dados):
        self.responder_texto(json.dumps(dados))

    def read(self, n):
        dados = bytes(self.saida[:n])
        del self.saida[:n]
        return dados

    def write(self, dados):
        partes = dados.decode().split()
        comando, args = partes[1], partes[2:]
        if comando == 'sensores':
            self.responder(cal='sensores', no='horta/no1', memoria=self.memoria, sensores=self.sensores)
        elif comando == 'ler':
            valor = self.temperatura if args[0] == 'temperatura' else self.medias[0]
            self.responder(cal='bruto', sensor=args[0], bruto=valor, unidade='V', valor=valor)
        elif comando == 'amostrar':
            media = self.medias.pop(0)
            n = int(args[1])
            self.responder(cal='amostrando', sensor=args[0], n=n, intervalo_ms=int(args[2]))
            self.responder_texto('[horta] ph: ainda não calibrado, não publicado')
            for i in range(1, n + 1):
                self.responder(cal='amostra', sensor=args[0], i=i, bruto=media)
            self.responder(cal='media', sensor=args[0], n=n, media=media, desvio=0.004, menor=media, maior=media,
                           unidade='V')
        elif comando == 'gravar':
            self.gravados.append((args[0], float(args[1]), float(args[2]), int(args[3])))
            self.responder(cal='gravado', sensor=args[0], inclinacao=float(args[1]), deslocamento=float(args[2]),
                           calibrado_em=int(args[3]))
        else:
            self.responder(cal='erro', motivo='comando desconhecido')


def roteiro(respostas):
    respostas = list(respostas)
    perguntas = []

    def perguntar(pergunta):
        perguntas.append(pergunta)
        return respostas.pop(0)

    return perguntar, perguntas


class Bancadas(unittest.TestCase):
    def setUp(self):
        self.pasta = tempfile.TemporaryDirectory()
        self.registro = Path(self.pasta.name) / 'calibracao'
        self.mensagens = []

    def tearDown(self):
        self.pasta.cleanup()

    def bancada(self, no, respostas):
        perguntar, self.perguntas = roteiro(respostas)
        return Bancada(No(no), perguntar=perguntar, mostrar=self.mensagens.append, esperar=lambda s: None,
                       agora=lambda: datetime(2026, 11, 10, 14, 52))

    def test_calibracao_de_ph_completa(self):
        no = NoFalso([2.505, 3.038, 2.515])
        # tampão 7,00 (padrão), Enter, tampão 4,00 (padrão), Enter, verificação 6,86, Enter, gravar (padrão: sim)
        resultado = self.bancada(no, ['', '', '', '', '6,86', '', '']).calibrar(
            'ph', estabilizar_s=0, gravar_em=self.registro)

        self.assertTrue(resultado['gravado'])
        self.assertTrue(resultado['verificacao']['aprovado'])
        sensor, inclinacao, deslocamento, quando = no.gravados[0]
        self.assertEqual(sensor, 'ph')
        self.assertAlmostEqual(inclinacao, -5.6285, places=3)
        self.assertEqual(quando, int(datetime(2026, 11, 10, 14, 52).timestamp()))

        pontos = gerar_relatorio.ler_csv(self.registro / '2026-11-10-ph-no1.csv')
        self.assertEqual([p['uso'] for p in pontos], ['calibracao', 'calibracao', 'verificacao'])
        self.assertEqual(pontos[0]['referencia'], '7,000000')
        self.assertEqual(pontos[0]['temperatura_C'], '24,600000')
        self.assertEqual(pontos[2]['erro'][:5], '0,083')
        coeficientes = gerar_relatorio.ler_csv(self.registro / 'coeficientes.csv')
        self.assertEqual(coeficientes[0]['resultado'], 'aprovado')
        self.assertEqual(coeficientes[0]['gravado_no_no'], 'sim')
        # Os arquivos abrem direto no Excel em português: começam com a marca UTF-8.
        self.assertTrue((self.registro / 'coeficientes.csv').read_bytes().startswith(b'\xef\xbb\xbf'))

        relatorio = gerar_relatorio.gerar(self.registro)
        self.assertIn('| horta/no1 | pH | 10/11/2026 14:52 |', relatorio)
        self.assertIn('pH = -5,628', relatorio)
        self.assertIn('aprovado', relatorio)

    def test_segunda_calibracao_no_mesmo_dia_nao_apaga_a_primeira(self):
        for _ in range(2):
            no = NoFalso([2.505, 3.038])
            self.bancada(no, ['', '', '', '', '', 'n']).calibrar('ph', estabilizar_s=0, gravar_em=self.registro)
        self.assertTrue((self.registro / '2026-11-10-ph-no1.csv').exists())
        self.assertTrue((self.registro / '2026-11-10-ph-no1-2.csv').exists())
        coeficientes = gerar_relatorio.ler_csv(self.registro / 'coeficientes.csv')
        self.assertEqual([c['gravado_no_no'] for c in coeficientes], ['não', 'não'])
        self.assertEqual(coeficientes[0]['resultado'], 'sem verificação')
        self.assertIn('Nenhuma reta foi gravada', gerar_relatorio.gerar(self.registro))

    def test_tampoes_iguais_sao_recusados(self):
        no = NoFalso([2.505, 2.507])
        with self.assertRaises(ErroDoNo):
            self.bancada(no, ['', '', '', '']).calibrar('ph', estabilizar_s=0, gravar_em=self.registro)
        self.assertEqual(no.gravados, [])

    def test_sair_no_meio_nao_grava_nada(self):
        no = NoFalso([2.505, 3.038])
        with self.assertRaises(Desistiu):
            self.bancada(no, ['', '', 'sair']).calibrar('ph', estabilizar_s=0, gravar_em=self.registro)
        self.assertEqual(no.gravados, [])
        self.assertFalse(self.registro.exists())

    def test_reta_suspeita_nao_e_sugerida_para_gravar(self):
        # Os tampões trocados de copo dão a inclinação com o sinal errado.
        no = NoFalso([3.038, 2.505])
        bancada = self.bancada(no, ['', '', '', '', '', ''])
        resultado = bancada.calibrar('ph', estabilizar_s=0, gravar_em=self.registro)
        self.assertFalse(resultado['gravado'])  # Enter na última pergunta: o padrão passa a ser "não"
        self.assertTrue(any('fora da faixa esperada' in m for m in self.mensagens))
        self.assertFalse(bancada.gravacao_enviada)
        self.assertEqual(no.gravados, [])

    def test_temperatura_le_o_termometro_depois_da_medida(self):
        no = NoFalso([24.8])
        # Enter (sensor na água), termômetro 25,0, gravar (padrão: sim)
        resultado = self.bancada(no, ['', '25,0', '']).calibrar('temperatura', estabilizar_s=0, gravar_em=self.registro)
        self.assertIn('Tecle Enter', self.perguntas[0])
        self.assertIn('Leia agora', self.perguntas[1])
        self.assertAlmostEqual(resultado['deslocamento'], 0.2)
        self.assertTrue(resultado['gravado'])

    def test_valor_fora_da_faixa_e_pedido_de_novo(self):
        bancada = self.bancada(NoFalso([]), ['1.413', '1413'])
        self.assertEqual(bancada.pedir_numero('Valor', faixa=(10, 20000)), 1413.0)
        self.assertTrue(any('sem ponto de milhar' in m.lower() for m in self.mensagens))

    def test_aviso_de_modo_simulado(self):
        no = NoFalso([2.505, 3.038], memoria='cria-cal-sim')
        bancada = self.bancada(no, ['', '', '', '', '', 'n'])
        bancada.calibrar('ph', estabilizar_s=0, gravar_em=self.registro)
        self.assertTrue(any('modo simulado' in m for m in self.mensagens))
        self.assertFalse(bancada.gravacao_enviada)

    def test_sensor_que_o_no_nao_tem(self):
        with self.assertRaises(ErroDoNo) as erro:
            self.bancada(NoFalso([]), []).calibrar('condutividade', estabilizar_s=0, gravar_em=self.registro)
        self.assertIn('ph, temperatura', str(erro.exception))


class Protocolo(unittest.TestCase):
    def test_erro_do_no_vira_excecao(self):
        no = No(NoFalso([]))
        with self.assertRaises(ErroDoNo) as erro:
            no.pedir('cal desconhecido', {'qualquer'})
        self.assertIn('desconhecido', str(erro.exception))

    def test_nome_do_arquivo(self):
        with tempfile.TemporaryDirectory() as pasta:
            quando = datetime(2026, 11, 10)
            primeiro = calibrar.nome_do_arquivo(Path(pasta), quando, 'ph', 'horta/no1')
            self.assertEqual(primeiro.name, '2026-11-10-ph-no1.csv')
            primeiro.write_text('x')
            self.assertEqual(calibrar.nome_do_arquivo(Path(pasta), quando, 'ph', 'horta/no1').name,
                             '2026-11-10-ph-no1-2.csv')

    def test_texto_que_pareceria_formula_na_planilha(self):
        self.assertEqual(calibrar.celula('=1+1'), "'=1+1")
        self.assertEqual(calibrar.celula('a;b'), 'a,b')
        self.assertEqual(calibrar.celula(-5.5, 2), '-5,50')


if __name__ == '__main__':
    unittest.main()
