// Imagens da câmera da horta (ESP32-CAM, nó horta/no3).
//
// O nó envia um JPEG por HTTP, com a senha do projeto, e o servidor guarda o
// arquivo em IMAGENS_DIR/{projeto}/{no}/{AAAA-MM-DD}/{HH-MM-SS}.jpg, com a data
// e a hora da escola. As imagens não passam pelo MQTT nem pelo banco: um JPEG
// de 100 a 300 KB não cabe no buffer de um nó, e o banco é de séries temporais.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TAMANHO_MAXIMO_DA_IMAGEM = 2 * 1024 * 1024;
export const DIA_VALIDO = /^\d{4}-\d{2}-\d{2}$/;
export const ARQUIVO_VALIDO = /^(\d{2}-\d{2}-\d{2})(?:-(\d{1,3}))?\.jpg$/;

// JPEG começa com FF D8 FF e termina com FF D9.
export function eJpeg(dados) {
  const n = dados?.length ?? 0;
  return n > 4 && dados[0] === 0xff && dados[1] === 0xd8 && dados[2] === 0xff && dados[n - 2] === 0xff && dados[n - 1] === 0xd9;
}

// Dia e hora no fuso da escola: "2026-11-10" e "14-52-07".
function diaEHora(t, fusoHorario) {
  const texto = new Intl.DateTimeFormat('sv-SE', {
    timeZone: fusoHorario,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(t));
  const [dia, hora] = texto.split(' ');
  return { dia, hora: hora.replaceAll(':', '-') };
}

async function lerPasta(pasta) {
  try {
    return await readdir(pasta);
  } catch (erro) {
    if (erro.code === 'ENOENT') return [];
    throw erro;
  }
}

async function existe(caminho) {
  try {
    await stat(caminho);
    return true;
  } catch {
    return false;
  }
}

// Mais nova primeiro: "14-52-07-2.jpg" é mais nova que "14-52-07.jpg".
function maisNovaPrimeiro(a, b) {
  const [, horaA, nA = '1'] = a.match(ARQUIVO_VALIDO);
  const [, horaB, nB = '1'] = b.match(ARQUIVO_VALIDO);
  return horaA === horaB ? Number(nB) - Number(nA) : horaB.localeCompare(horaA);
}

// Espaço livre na pasta das imagens, em bytes.
export async function espacoLivre(pasta) {
  const s = await statfs(pasta);
  return s.bavail * s.bsize;
}

// Uma gravação por vez em cada pasta. Duas fotos no mesmo segundo (dois nós
// com o mesmo nome por engano, um teste com curl durante o envio da câmera)
// escolheriam o mesmo nome e uma estragaria a outra.
const filas = new Map();
function umaPorVez(chave, tarefa) {
  const atual = (filas.get(chave) ?? Promise.resolve()).then(tarefa);
  const fim = atual.catch(() => {});
  filas.set(chave, fim);
  fim.then(() => {
    if (filas.get(chave) === fim) filas.delete(chave);
  });
  return atual;
}

export async function salvarImagem({ pasta, projeto, no, jpeg, t = Date.now(), fusoHorario }) {
  const { dia, hora } = diaEHora(t, fusoHorario);
  const destino = join(pasta, projeto, no, dia);
  return umaPorVez(destino, async () => {
    await mkdir(destino, { recursive: true });
    // Duas imagens no mesmo segundo ganham -2, -3...
    let nome = `${hora}.jpg`;
    for (let n = 2; (await existe(join(destino, nome))) && n < 1000; n++) nome = `${hora}-${n}.jpg`;
    // Grava num temporário e troca de nome: quem lê nunca vê a imagem pela metade.
    const temporario = join(destino, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporario, jpeg);
      await rename(temporario, join(destino, nome));
    } catch (erro) {
      await rm(temporario, { force: true }); // disco cheio no meio: não deixa o pedaço para trás
      throw erro;
    }
    return { caminho: `${projeto}/${no}/${dia}/${nome}`, t };
  });
}

// As imagens mais novas de um nó: [{ caminho, dia, arquivo }].
export async function listarImagens({ pasta, projeto, no, limite = 20 }) {
  const base = join(pasta, projeto, no);
  const dias = (await lerPasta(base)).filter((d) => DIA_VALIDO.test(d)).sort().reverse();
  const lista = [];
  for (const dia of dias) {
    const arquivos = (await lerPasta(join(base, dia))).filter((a) => ARQUIVO_VALIDO.test(a)).sort(maisNovaPrimeiro);
    for (const arquivo of arquivos) {
      lista.push({ caminho: `${projeto}/${no}/${dia}/${arquivo}`, dia, arquivo });
      if (lista.length >= limite) return lista;
    }
  }
  return lista;
}

// A última imagem de cada nó, para o painel ao ligar o servidor:
// [{ projeto, no, caminho, t }], com t pela data de modificação do arquivo.
export async function ultimasImagens({ pasta, nomeValido, noValido }) {
  const ultimas = [];
  for (const projeto of (await lerPasta(pasta)).filter((p) => nomeValido.test(p))) {
    for (const no of (await lerPasta(join(pasta, projeto))).filter((n) => noValido.test(n))) {
      const [ultima] = await listarImagens({ pasta, projeto, no, limite: 1 });
      if (!ultima) continue;
      const { mtimeMs } = await stat(join(pasta, ...ultima.caminho.split('/')));
      ultimas.push({ projeto, no, caminho: ultima.caminho, t: Math.round(mtimeMs) });
    }
  }
  return ultimas;
}
