#!/usr/bin/env python3
"""Gera as versões em HTML e em PDF dos tutoriais escritos em Markdown.

O HTML sai num arquivo só, com as imagens e o estilo embutidos, pronto para
mandar por e-mail ou abrir sem internet. O PDF é impresso a partir desse HTML
por um navegador em modo sem janela (Edge no Windows; Chrome ou Chromium no
Linux).

Precisa do pandoc (https://pandoc.org) e de um desses navegadores. Uso, na
raiz do repositório:

    py tutoriais/gerar-documentos.py                        (todos os tutoriais)
    py tutoriais/gerar-documentos.py tutoriais/02-guia-completo.md
    py tutoriais/gerar-documentos.py --so-html ...
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

PASTA = Path(__file__).resolve().parent
ESTILO = PASTA / 'estilo-documento.css'
# Tutoriais que ainda não têm versão gerada por este script ficam de fora do
# padrão: o 00 tem o PDF feito à mão, a partir do .odt.
PADRAO = ['02-guia-completo.md']

NAVEGADORES = [
    'msedge', 'chrome', 'google-chrome', 'chromium', 'chromium-browser',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
]


def achar_navegador():
    for nome in NAVEGADORES:
        caminho = shutil.which(nome) or (nome if Path(nome).is_file() else None)
        if caminho:
            return caminho
    return None


def gerar_html(markdown, html):
    comando = [
        'pandoc', str(markdown),
        '--from', 'gfm+smart',
        '--to', 'html5',
        '--standalone',
        '--embed-resources',
        '--toc', '--toc-depth=3',
        '--css', str(ESTILO),
        '--metadata', 'lang=pt-BR',
        '--resource-path', str(markdown.parent),
        '--output', str(html),
    ]
    subprocess.run(comando, check=True)


def gerar_pdf(html, pdf, navegador):
    comando = [
        navegador,
        '--headless=new', '--disable-gpu', '--no-sandbox',
        '--no-pdf-header-footer',
        f'--print-to-pdf={pdf}',
        html.resolve().as_uri(),
    ]
    subprocess.run(comando, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    if not pdf.exists() or pdf.stat().st_size < 1000:
        raise RuntimeError(f'o navegador não gerou {pdf}')


def main():
    analisador = argparse.ArgumentParser(description='Gera HTML e PDF dos tutoriais.')
    analisador.add_argument('arquivos', nargs='*', help='arquivos .md (padrão: ' + ', '.join(PADRAO) + ')')
    analisador.add_argument('--so-html', action='store_true', help='não gera o PDF')
    opcoes = analisador.parse_args()

    if not shutil.which('pandoc'):
        sys.exit('Falta o pandoc: instale pelo site https://pandoc.org/installing.html (Windows e Linux).')
    navegador = None if opcoes.so_html else achar_navegador()
    if not opcoes.so_html and not navegador:
        sys.exit('Nenhum navegador para o PDF: instale o Microsoft Edge, o Google Chrome ou o Chromium, '
                 'ou use --so-html.')

    arquivos = [Path(a) for a in opcoes.arquivos] or [PASTA / nome for nome in PADRAO]
    for markdown in arquivos:
        if not markdown.exists():
            sys.exit(f'Arquivo não encontrado: {markdown}')
        html = markdown.with_suffix('.html')
        gerar_html(markdown, html)
        print(f'HTML: {html} ({html.stat().st_size // 1024} KB)')
        if navegador:
            pdf = markdown.with_suffix('.pdf')
            gerar_pdf(html, pdf, navegador)
            print(f'PDF:  {pdf} ({pdf.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
