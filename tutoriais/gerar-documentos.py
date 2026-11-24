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
    py tutoriais/gerar-documentos.py --web PASTA             (cópia para um site)

Com --web, o HTML e o PDF também são copiados para PASTA, sem o número do
início do nome (02-guia-completo.html vira guia-completo.html). Nessa cópia, os
links para outros arquivos do repositório passam a apontar para o GitHub,
porque num site eles não existem ao lado da página.
"""

import argparse
import os
import posixpath
import re
import shutil
import subprocess
import sys
from pathlib import Path

PASTA = Path(__file__).resolve().parent
ESTILO = PASTA / 'estilo-documento.css'
# Tutoriais que ainda não têm versão gerada por este script ficam de fora do
# padrão: o 00 tem o PDF feito à mão, a partir do .odt.
PADRAO = ['02-guia-completo.md']
# Para onde vão, na cópia para um site, os links a outros arquivos do repositório.
REPOSITORIO = 'https://github.com/ErlyAquino/telemetria-cria/blob/main/'

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
    subir_logos(html)


def subir_logos(html):
    """Leva a faixa das logos do início do texto para antes do título.

    No Markdown a faixa vem logo depois do cabeçalho, que é onde o GitHub a
    mostra. No HTML o pandoc põe o título e o sumário antes do texto, e a faixa
    ficaria depois do sumário: aqui ela sobe para o topo da página.
    """
    texto = html.read_text(encoding='utf-8')
    titulo = texto.find('<header id="title-block-header">')
    inicio = texto.find('<p align="center" class="logos">')
    if titulo < 0 or inicio < titulo:
        return
    fim = texto.find('</p>', inicio) + len('</p>')
    # Só a faixa que abre o texto: a do fim do guia fica onde está.
    antes = texto[titulo:inicio].rstrip()
    if not antes.endswith(('</nav>', '</header>')):
        return
    faixa = texto[inicio:fim]
    texto = texto[:inicio] + texto[fim:]
    texto = texto[:titulo] + faixa + '\n' + texto[titulo:]
    html.write_text(texto, encoding='utf-8')


def gerar_pdf(html, pdf, navegador):
    comando = [
        navegador,
        '--headless=new', '--disable-gpu', '--no-sandbox',
        '--no-pdf-header-footer',
        # Marcadores (bookmarks) do PDF, a partir dos títulos. Chrome e Edge 122 ou mais novos.
        '--generate-pdf-document-outline',
        f'--print-to-pdf={pdf}',
        html.resolve().as_uri(),
    ]
    subprocess.run(comando, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    if not pdf.exists() or pdf.stat().st_size < 1000:
        raise RuntimeError(f'o navegador não gerou {pdf}')


def copiar_para_site(markdown, html, pdf, pasta):
    """Copia o HTML (e o PDF) para a pasta de um site.

    Os links relativos, como ../mqtt/catalogo-topicos.md, são trocados pelo
    endereço do arquivo no GitHub. O PDF fica ao lado, com um link no título.
    """
    pasta.mkdir(parents=True, exist_ok=True)
    nome = re.sub(r'^\d+-', '', markdown.stem)
    # Caminho da pasta do tutorial dentro do repositório (ex.: "tutoriais").
    base = markdown.resolve().parent.relative_to(PASTA.parent).as_posix()

    def para_o_github(achado):
        destino = achado.group(1)
        if re.match(r'^([a-z][a-z0-9+.-]*:|#|/)', destino, re.I):
            return achado.group(0)
        return f'href="{REPOSITORIO}{posixpath.normpath(posixpath.join(base, destino))}"'

    texto = re.sub(r'href="([^"]*)"', para_o_github, html.read_text(encoding='utf-8'))
    if pdf:
        shutil.copyfile(pdf, pasta / f'{nome}.pdf')
        texto = texto.replace(
            '</header>',
            f'<p class="baixar-pdf"><a href="{nome}.pdf">Baixar este guia em PDF</a></p>\n</header>', 1)
    destino = pasta / f'{nome}.html'
    destino.write_text(texto, encoding='utf-8')
    print(f'Site: {destino} ({destino.stat().st_size // 1024} KB)')


def main():
    analisador = argparse.ArgumentParser(description='Gera HTML e PDF dos tutoriais.')
    analisador.add_argument('arquivos', nargs='*', help='arquivos .md (padrão: ' + ', '.join(PADRAO) + ')')
    analisador.add_argument('--so-html', action='store_true', help='não gera o PDF')
    analisador.add_argument('--web', metavar='PASTA', type=Path,
                            help='copia o HTML e o PDF para a pasta de um site, com os links apontando para o GitHub')
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
        pdf = None
        if navegador:
            pdf = markdown.with_suffix('.pdf')
            gerar_pdf(html, pdf, navegador)
            print(f'PDF:  {pdf} ({pdf.stat().st_size // 1024} KB)')
        if opcoes.web:
            copiar_para_site(markdown, html, pdf, opcoes.web)


if __name__ == '__main__':
    main()
