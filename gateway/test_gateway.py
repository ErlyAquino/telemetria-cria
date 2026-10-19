"""Testes do gateway. Rode, na raiz do repositório:

    py -m unittest discover -s gateway               (Windows)
    python3 -m unittest discover -s gateway          (Linux)
"""

import json
import queue
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path

import gateway
from gateway import (ControleDeBoot, Enviador, ErroFatal, LeitorDaPlaca, MarcadorDeHora, SeparadorDeLinhas,
                     interpretar_linha)

VALIDA = '{"no": "no1", "grandeza": "temperatura", "valor": 27.4, "unidade": "C", "seq": 12}'


class InterpretarLinha(unittest.TestCase):
    def test_leitura_valida(self):
        leitura, motivo = interpretar_linha(VALIDA + '\r\n')
        self.assertIsNone(motivo)
        self.assertEqual(leitura, {'no': 'no1', 'grandeza': 'temperatura', 'valor': 27.4, 'unidade': 'C', 'seq': 12})

    def test_texto_da_placa_nao_e_leitura(self):
        self.assertEqual(interpretar_linha('ets Jun  8 2016 00:22:57'), (None, None))
        self.assertEqual(interpretar_linha(''), (None, None))

    def test_json_fora_do_catalogo_tem_motivo(self):
        casos = {
            '{"no": "no1", "grandeza"': 'JSON inválido',
            '{"no": "no01", "grandeza": "t", "valor": 1, "unidade": "C", "seq": 1}': 'no ausente',
            '{"no": "no1", "grandeza": "status", "valor": 1, "unidade": "C", "seq": 1}': 'grandeza',
            '{"no": "no1", "grandeza": "t", "valor": true, "unidade": "C", "seq": 1}': 'valor',
            '{"no": "no1", "grandeza": "t", "valor": "27", "unidade": "C", "seq": 1}': 'valor',
            '{"no": "no1", "grandeza": "t", "valor": 1' + '0' * 400 + ', "unidade": "C", "seq": 1}': 'valor',
            '{"no": "no1", "grandeza": "t", "valor": 1, "unidade": "=1+1", "seq": 1}': 'unidade',
            '{"no": "no1", "grandeza": "t", "valor": 1, "unidade": "C", "seq": 0}': 'seq',
            '{"no": "no1", "grandeza": "t", "valor": 1, "unidade": "C", "seq": 1.5}': 'seq',
        }
        for linha, trecho in casos.items():
            leitura, motivo = interpretar_linha(linha)
            self.assertIsNone(leitura, linha)
            self.assertIn(trecho, motivo, linha)


class SepararLinhas(unittest.TestCase):
    def test_linha_partida_em_dois_pedacos(self):
        separador = SeparadorDeLinhas()
        self.assertEqual(separador.adicionar(b'{"no":"no1",'), [])
        self.assertEqual(separador.adicionar(b'"seq":1}\r\n{"a"'), [b'{"no":"no1","seq":1}'])
        self.assertEqual(separador.adicionar(b':2}\n'), [b'{"a":2}'])

    def test_lixo_sem_fim_de_linha_e_descartado(self):
        separador = SeparadorDeLinhas(limite=10)
        separador.adicionar(b'x' * 11)
        self.assertEqual(separador.adicionar(b'ok\n'), [b'ok'])


class MarcarHora(unittest.TestCase):
    def test_hora_cresce_em_cada_serie(self):
        marcador = MarcadorDeHora()
        self.assertEqual([marcador.marcar('no1', 't', 1000) for _ in range(3)], [1000, 1001, 1002])
        self.assertEqual(marcador.marcar('no1', 'umidade', 1000), 1000)  # outra série
        self.assertEqual(marcador.marcar('no1', 't', 5000), 5000)


class Boots(unittest.TestCase):
    def setUp(self):
        self.pasta = tempfile.TemporaryDirectory()
        self.controles = []

    def tearDown(self):
        for controle in self.controles:
            controle.fechar()
        self.pasta.cleanup()

    def controle(self):
        controle = ControleDeBoot('teste', self.pasta.name)
        self.controles.append(controle)
        return controle

    def test_boot_muda_so_quando_o_seq_volta(self):
        boots = self.controle()
        self.assertEqual([boots.boot_para('no1', s) for s in (1, 2, 3)], [1, 1, 1])
        self.assertEqual(boots.boot_para('no2', 40), 1)  # outro nó, contagem própria
        self.assertEqual(boots.boot_para('no1', 1), 2)  # a placa reiniciou
        self.assertEqual(boots.boot_para('no1', 1), 3)  # e de novo: seq repetido também é reinício
        boots.fechar()

        # O gateway reinicia. A placa que reiniciou junto recomeça o seq: boot novo.
        # A que continuou contando mantém o boot, e o salto no seq mostra o que se perdeu.
        outra = self.controle()
        self.assertEqual(outra.boot_para('no1', 1), 4)
        self.assertEqual(outra.boot_para('no2', 45), 1)

    def test_um_arquivo_por_no(self):
        boots = self.controle()
        boots.boot_para('no1', 7)
        boots.boot_para('no2', 3)
        arquivo = Path(self.pasta.name) / 'teste-no1.json'
        self.assertEqual(json.loads(arquivo.read_text(encoding='utf-8')), {'boot': 1, 'seq': 7})
        self.assertTrue((Path(self.pasta.name) / 'teste-no2.json').exists())

    def test_dois_gateways_no_mesmo_no_sao_recusados(self):
        self.controle().boot_para('no1', 1)
        with self.assertRaises(ErroFatal):
            self.controle().boot_para('no1', 1)

    def test_estado_corrompido_para_o_gateway(self):
        for conteudo in ('{"boot": 3', '{"boot": "3", "seq": 1}', '[]', '{"seq": 1}'):
            (Path(self.pasta.name) / 'teste-no1.json').write_text(conteudo, encoding='utf-8')
            boots = self.controle()
            with self.assertRaises(ErroFatal, msg=conteudo):
                boots.boot_para('no1', 1)
            boots.fechar()


class PortaFalsa:
    """Imita a porta serial: entrega os pedaços e depois cai, como uma placa desconectada."""

    def __init__(self, pedacos):
        self.pedacos = list(pedacos)
        self.in_waiting = 0
        self.fechada = False

    def read(self, n):
        if not self.pedacos:
            raise OSError('placa desconectada')
        return self.pedacos.pop(0)

    def close(self):
        self.fechada = True


class LerAPlaca(unittest.TestCase):
    def test_leituras_saem_com_t_e_boot_e_mensagens_aparecem(self):
        with tempfile.TemporaryDirectory() as pasta:
            boots = ControleDeBoot('teste', pasta)
            porta = PortaFalsa([b'rst:0x1 boot\r\n', b'{"no":"no1","grandeza":"t","valor":2', b'1.5,"unidade":"C","seq":1}\r\n',
                                b'{"no":"no1","grandeza":"t","valor":21.6,"unidade":"C","seq":2}\n', b''])
            saida = queue.Queue()
            leitor = LeitorDaPlaca('falsa', 115200, boots, saida, abrir=lambda: porta)
            mensagens = []
            original, gateway.avisar = gateway.avisar, mensagens.append
            try:
                antes = gateway.agora_ms()
                leitor._ler_ate_cair()
            finally:
                gateway.avisar = original
                boots.fechar()
            primeira, segunda = saida.get_nowait(), saida.get_nowait()
            self.assertEqual((primeira['seq'], primeira['boot'], primeira['valor']), (1, 1, 21.5))
            self.assertEqual((segunda['seq'], segunda['boot']), (2, 1))
            self.assertGreaterEqual(primeira['t'], antes)
            self.assertGreater(segunda['t'], primeira['t'])
            self.assertIn('placa: rst:0x1 boot', mensagens)
            self.assertTrue(porta.fechada)


class EnvioAoServidor(unittest.TestCase):
    def leituras(self, n):
        return [{'no': 'no1', 'grandeza': 't', 'valor': 1, 'unidade': 'C', 'seq': s, 'boot': 1, 't': 0}
                for s in range(1, n + 1)]

    def responde(self, *respostas):
        respostas = list(respostas)
        enviados = []

        def post(lote):
            enviados.append(lote)
            resposta = respostas.pop(0)
            if isinstance(resposta, Exception):
                raise resposta
            return resposta + (None,) if len(resposta) == 2 else resposta

        return post, enviados

    def test_envio_aceito_esvazia_a_fila(self):
        post, enviados = self.responde((200, {'aceitas': 3, 'recusadas': []}))
        enviador = Enviador(post)
        for l in self.leituras(3):
            enviador.adicionar(l, agora=0)
        self.assertEqual(enviador.enviar(agora=1), 3)
        self.assertEqual(enviador.fila, [])
        self.assertNotIn('fila', enviados[0][0])
        self.assertNotIn('_chegada', enviados[0][0])  # campo interno não vai ao servidor

    def test_quando_enviar(self):
        enviador = Enviador(None)
        enviador.adicionar(self.leituras(1)[0], agora=10)
        self.assertFalse(enviador.pronto(10.1))  # pode vir mais uma linha junto
        self.assertTrue(enviador.pronto(10.3))  # as linhas pararam de chegar
        # Placa que escreve sem parar: a mais antiga não espera mais que 1 s.
        for i in range(1, 10):
            enviador.adicionar(self.leituras(1)[0], agora=10 + i * 0.1)
        self.assertTrue(enviador.pronto(11.0))

    def test_servidor_fora_guarda_e_marca_fila(self):
        post, _ = self.responde(urllib.error.URLError('recusada'), (503, {'erro': 'broker indisponível'}),
                                (200, {'aceitas': 2}))
        enviador = Enviador(post)
        for l in self.leituras(2):
            enviador.adicionar(l, agora=0)
        self.assertEqual(enviador.enviar(agora=0), 0)
        self.assertFalse(enviador.pronto(0.5))  # espera antes de tentar de novo
        self.assertEqual(enviador.enviar(agora=1), 0)
        self.assertEqual(enviador.espera_s, 2)
        self.assertTrue(all(l['fila'] == 1 for l in enviador.fila))
        self.assertEqual(enviador.enviar(agora=3), 2)
        self.assertEqual(enviador.fila, [])
        self.assertEqual(enviador.espera_s, 0)

    def test_erros_de_rede_nao_param_o_gateway(self):
        import http.client
        post, _ = self.responde(http.client.RemoteDisconnected('caiu'), TimeoutError('prazo'), ValueError('JSON'))
        enviador = Enviador(post)
        enviador.adicionar(self.leituras(1)[0], agora=0)
        for agora in (0, 10, 20):
            self.assertEqual(enviador.enviar(agora=agora), 0)
        self.assertEqual(len(enviador.fila), 1)

    def test_leitura_que_chega_durante_a_espera_tambem_e_da_fila(self):
        post, _ = self.responde((503, {}), (200, {'aceitas': 2}))
        enviador = Enviador(post)
        primeira, segunda, depois = self.leituras(3)
        enviador.adicionar(primeira, agora=0)
        enviador.enviar(agora=0)  # falha: o gateway passa a esperar
        enviador.adicionar(segunda, agora=0.5)  # chegou durante a espera
        self.assertEqual(segunda.get('fila'), 1)
        enviador.enviar(agora=5)  # o servidor voltou
        enviador.adicionar(depois, agora=6)  # chegou com tudo normal
        self.assertNotIn('fila', depois)

    def test_senha_errada_para_o_gateway(self):
        post, _ = self.responde((401, {'erro': 'o broker recusou o usuário'}))
        enviador = Enviador(post)
        enviador.adicionar(self.leituras(1)[0])
        with self.assertRaises(ErroFatal):
            enviador.enviar(agora=0)

    def test_leituras_recusadas_saem_da_fila(self):
        post, _ = self.responde((400, {'aceitas': 0, 'recusadas': [{'indice': 0, 'motivo': 't no futuro'}]}),
                                (400, {'erro': 'corpo inválido'}))
        enviador = Enviador(post)
        mensagens = []
        original, gateway.avisar = gateway.avisar, mensagens.append
        try:
            enviador.adicionar(self.leituras(1)[0])
            enviador.enviar(agora=0)
            self.assertEqual(enviador.fila, [])
            enviador.adicionar(self.leituras(1)[0])
            enviador.enviar(agora=1)  # 400 sem a lista de recusadas: mostra o erro
            self.assertEqual(enviador.fila, [])
        finally:
            gateway.avisar = original
        self.assertIn('t no futuro', mensagens[0])
        self.assertIn('corpo inválido', mensagens[1])

    def test_aviso_de_relogio_errado(self):
        enviador = Enviador(lambda lote: (200, {'aceitas': 1}, gateway.agora_ms() + 60000))
        mensagens = []
        original, gateway.avisar = gateway.avisar, mensagens.append
        try:
            enviador.adicionar(self.leituras(1)[0])
            enviador.enviar(agora=0)
        finally:
            gateway.avisar = original
        self.assertTrue(any('atrasado' in m for m in mensagens), mensagens)

    def test_fila_cheia_descarta_a_mais_antiga(self):
        enviador = Enviador(None)
        gateway.MAXIMO_NA_FILA, original = 3, gateway.MAXIMO_NA_FILA
        try:
            for l in self.leituras(4):
                enviador.adicionar(l)
        finally:
            gateway.MAXIMO_NA_FILA = original
        self.assertEqual([l['seq'] for l in enviador.fila], [2, 3, 4])

    def test_ao_encerrar_envia_ate_a_fila_parar_de_diminuir(self):
        gateway.LEITURAS_POR_ENVIO, original = 2, gateway.LEITURAS_POR_ENVIO
        try:
            post, enviados = self.responde((200, {'aceitas': 2}), (200, {'aceitas': 2}), (503, {}))
            enviador = Enviador(post)
            leitor = LeitorDaPlaca('falsa', 115200, None, queue.Queue())
            for l in self.leituras(5):
                leitor.saida.put(l)  # ainda não tinham passado ao enviador
            gateway.enviar_o_que_falta(leitor, enviador)
        finally:
            gateway.LEITURAS_POR_ENVIO = original
        self.assertEqual(len(enviados), 3)
        self.assertEqual(len(enviador.fila), 1)


class CarregarEnv(unittest.TestCase):
    def test_le_o_arquivo_sem_sobrescrever_o_ambiente(self):
        with tempfile.TemporaryDirectory() as pasta:
            arquivo = Path(pasta) / '.env'
            arquivo.write_text('# comentário\n'
                               'GATEWAY_TESTE_A=do_arquivo\n'
                               'GATEWAY_TESTE_B=do_arquivo\n'
                               'GATEWAY_TESTE_C="com # dentro"\n'
                               "GATEWAY_TESTE_D='aspas simples'\n"
                               'GATEWAY_TESTE_E=valor  # comentário no fim\n',
                               encoding='utf-8-sig')  # com a marca BOM, como salva o Bloco de Notas
            gateway.os.environ['GATEWAY_TESTE_B'] = 'do_ambiente'
            gateway.carregar_env(arquivo)
            ambiente = gateway.os.environ
            self.assertEqual(ambiente['GATEWAY_TESTE_A'], 'do_arquivo')
            self.assertEqual(ambiente['GATEWAY_TESTE_B'], 'do_ambiente')
            self.assertEqual(ambiente['GATEWAY_TESTE_C'], 'com # dentro')
            self.assertEqual(ambiente['GATEWAY_TESTE_D'], 'aspas simples')
            self.assertEqual(ambiente['GATEWAY_TESTE_E'], 'valor')


if __name__ == '__main__':
    unittest.main()
