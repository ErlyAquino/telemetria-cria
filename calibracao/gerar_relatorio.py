#!/usr/bin/env python3
"""Gera calibracao/relatorio-calibracao.md a partir dos registros da calibração.

Lê calibracao/coeficientes.csv (uma linha por calibração feita com o
calibrar.py) e os arquivos de pontos de cada calibração. Não precisa de placa
nem de servidor. Uso, na raiz do repositório:

    py calibracao/gerar_relatorio.py                 (Windows)
    python3 calibracao/gerar_relatorio.py            (Linux)
"""

import argparse
from datetime import datetime
from pathlib import Path

PASTA = Path(__file__).resolve().parent

NOMES = {'ph': 'pH', 'condutividade': 'Condutividade', 'temperatura': 'Temperatura', 'vazao': 'Vazão',
         'pressao': 'Pressão'}
UNIDADES = {'uS/cm': 'µS/cm', 'C': '°C'}


def ler_csv(arquivo):
    """Lê um CSV no padrão brasileiro (";" e vírgula decimal). Devolve uma lista de dicionários."""
    linhas = arquivo.read_text(encoding='utf-8-sig').splitlines()
    if not linhas:
        return []
    colunas = linhas[0].split(';')
    registros = []
    for linha in linhas[1:]:
        if not linha.strip():
            continue
        valores = linha.split(';')
        registros.append({c: (valores[i].lstrip("'") if i < len(valores) else '') for i, c in enumerate(colunas)})
    return registros


def numero(texto):
    try:
        return float(texto.replace(',', '.'))
    except (ValueError, AttributeError):
        return None


def br(x, casas):
    return '—' if x is None else f'{x:.{casas}f}'.replace('.', ',')


def unidade(u):
    return UNIDADES.get(u, u)


def reta(c):
    a, b = numero(c['inclinacao']), numero(c['deslocamento'])
    sinal = '−' if b is not None and b < 0 else '+'
    return f'{NOMES.get(c["sensor"], c["sensor"])} = {br(a, 6)} × {unidade(c["unidade_bruta"])} {sinal} {br(abs(b), 6)}'


def data(texto):
    try:
        return datetime.strptime(texto, '%Y-%m-%d %H:%M').strftime('%d/%m/%Y %H:%M')
    except ValueError:
        return texto


def gerar(pasta=PASTA):
    arquivo = pasta / 'coeficientes.csv'
    calibracoes = ler_csv(arquivo) if arquivo.exists() else []
    partes = [
        '# Relatório de calibração',
        '',
        f'Gerado em {datetime.now():%d/%m/%Y %H:%M} por `calibracao/gerar_relatorio.py`, a partir de '
        '`calibracao/coeficientes.csv` e dos arquivos de pontos de cada calibração. O procedimento está em '
        '`calibracao/README.md`.',
        '',
        'Cada reta converte o valor bruto do sensor na medida: medida = inclinação × bruto + deslocamento. A '
        'verificação usa uma solução que não entrou na calibração. Os critérios do plano de trabalho são pH dentro '
        'de ±0,2 e condutividade dentro de ±5%; o resultado que vale para a aceitação é o do teste de 24 h '
        '(`validacao/`).',
        '',
    ]
    if not calibracoes:
        partes += ['Nenhuma calibração registrada ainda.', '']
        return '\n'.join(partes)

    # A reta em uso é a última gravada no nó, para cada nó e sensor.
    em_uso = {}
    for c in calibracoes:
        if c.get('gravado_no_no') == 'sim':
            em_uso[(c['no'], c['sensor'])] = c
    partes += ['## Retas em uso nos nós', '']
    if em_uso:
        partes += ['| Nó | Sensor | Calibrado em | Reta | Verificação: erro | Resultado |',
                   '| --- | --- | --- | --- | --- | --- |']
        for (no, sensor), c in sorted(em_uso.items()):
            erro = numero(c['verificacao_erro'])
            partes.append(f'| {no} | {NOMES.get(sensor, sensor)} | {data(c["data_hora"])} | {reta(c)} | '
                          f'{br(erro, 3) + " " + unidade(c["unidade"]) if erro is not None else "—"} | '
                          f'{c["resultado"]} |')
    else:
        partes.append('Nenhuma reta foi gravada nos nós ainda.')
    partes.append('')

    for chave in sorted({(c['no'], c['sensor']) for c in calibracoes}):
        no, sensor = chave
        historico = [c for c in calibracoes if (c['no'], c['sensor']) == chave]
        ultima = historico[-1]
        partes += [f'## {NOMES.get(sensor, sensor)} — {no}', '',
                   f'### Última calibração: {data(ultima["data_hora"])} ({ultima["modo"]})', '']
        pontos_arquivo = pasta / ultima['arquivo_dos_pontos']
        if pontos_arquivo.exists():
            partes += ['| Uso | Referência | Bruto médio | Desvio | Amostras | Temperatura | Medida calculada | Erro |',
                       '| --- | --- | --- | --- | --- | --- | --- | --- |']
            for p in ler_csv(pontos_arquivo):
                u, ub = unidade(p['unidade']), unidade(p['unidade_bruta'])
                temperatura = numero(p['temperatura_C'])
                partes.append(
                    f'| {"calibração" if p["uso"] == "calibracao" else "verificação"} | {br(numero(p["referencia"]), 3)} {u} '
                    f'| {br(numero(p["bruto_medio"]), 5)} {ub} | {br(numero(p["desvio"]), 5)} {ub} | {p["amostras"]} '
                    f'| {br(temperatura, 1) + " °C" if temperatura is not None else "—"} '
                    f'| {br(numero(p["medida_calculada"]), 3)} {u} | {br(numero(p["erro"]), 3)} |')
            partes.append('')
        else:
            partes += [f'Arquivo de pontos `{ultima["arquivo_dos_pontos"]}` não encontrado.', '']
        partes += [f'Reta: {reta(ultima)}. Verificação: {ultima["resultado"]}. Gravada no nó: '
                   f'{ultima["gravado_no_no"]}. Pontos em `calibracao/{ultima["arquivo_dos_pontos"]}`.', '']
        if len(historico) > 1:
            partes += ['### Histórico', '', '| Data | Modo | Reta | Verificação: erro | Resultado | Gravada no nó |',
                       '| --- | --- | --- | --- | --- | --- |']
            for c in historico:
                erro = numero(c['verificacao_erro'])
                partes.append(f'| {data(c["data_hora"])} | {c["modo"]} | {reta(c)} | '
                              f'{br(erro, 3) if erro is not None else "—"} | {c["resultado"]} | {c["gravado_no_no"]} |')
            partes.append('')
    return '\n'.join(partes)


def main():
    analisador = argparse.ArgumentParser(description='Gera o relatório de calibração.')
    analisador.add_argument('--saida', default=str(PASTA / 'relatorio-calibracao.md'))
    opcoes = analisador.parse_args()
    Path(opcoes.saida).write_text(gerar(), encoding='utf-8')
    print(f'Relatório gravado em {opcoes.saida}')


if __name__ == '__main__':
    main()
