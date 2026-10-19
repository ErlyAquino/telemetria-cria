// Testes das imagens da câmera. Rode com "npm test", na pasta servidor/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOME_VALIDO, NO_VALIDO } from '../src/catalogo.js';
import { eJpeg, espacoLivre, listarImagens, salvarImagem, ultimasImagens } from '../src/imagens.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
// 10/11/2026, 14:52:07 em Recife (UTC-3).
const T = Date.UTC(2026, 10, 10, 17, 52, 7);

async function pastaTemporaria(t) {
  const pasta = await mkdtemp(join(tmpdir(), 'imagens-'));
  t.after(() => rm(pasta, { recursive: true, force: true }));
  return pasta;
}

test('reconhece JPEG pelo começo e pelo fim do arquivo', () => {
  assert.equal(eJpeg(JPEG), true);
  assert.equal(eJpeg(Buffer.from('não é imagem')), false);
  assert.equal(eJpeg(JPEG.subarray(0, 8)), false); // cortado no meio do envio
  assert.equal(eJpeg(undefined), false);
});

test('guarda com a data e a hora da escola, sem sobrescrever no mesmo segundo', async (t) => {
  const pasta = await pastaTemporaria(t);
  const primeira = await salvarImagem({ pasta, projeto: 'horta', no: 'no3', jpeg: JPEG, t: T, fusoHorario: 'America/Recife' });
  const segunda = await salvarImagem({ pasta, projeto: 'horta', no: 'no3', jpeg: JPEG, t: T, fusoHorario: 'America/Recife' });
  assert.equal(primeira.caminho, 'horta/no3/2026-11-10/14-52-07.jpg');
  assert.equal(segunda.caminho, 'horta/no3/2026-11-10/14-52-07-2.jpg');
  assert.deepEqual(await readFile(join(pasta, 'horta', 'no3', '2026-11-10', '14-52-07.jpg')), JPEG);
  // Nenhum temporário fica para trás.
  assert.deepEqual((await readdir(join(pasta, 'horta', 'no3', '2026-11-10'))).sort(), ['14-52-07-2.jpg', '14-52-07.jpg']);
});

test('várias fotos ao mesmo tempo no mesmo segundo: nenhuma estraga a outra', async (t) => {
  const pasta = await pastaTemporaria(t);
  // Cada foto com um conteúdo diferente, para conferir que nenhuma foi misturada.
  const fotos = [1, 2, 3, 4, 5].map((i) => Buffer.concat([JPEG.subarray(0, 4), Buffer.alloc(1000 * i, i), JPEG.subarray(4)]));
  const salvas = await Promise.all(
    fotos.map((jpeg) => salvarImagem({ pasta, projeto: 'horta', no: 'no3', jpeg, t: T, fusoHorario: 'America/Recife' })),
  );
  assert.equal(new Set(salvas.map((s) => s.caminho)).size, 5);
  for (const [i, salva] of salvas.entries()) {
    assert.deepEqual(await readFile(join(pasta, ...salva.caminho.split('/'))), fotos[i]);
  }
  assert.equal((await readdir(join(pasta, 'horta', 'no3', '2026-11-10'))).length, 5); // sem temporários
});

test('lista da mais nova para a mais antiga, atravessando os dias', async (t) => {
  const pasta = await pastaTemporaria(t);
  const salvar = (tt) => salvarImagem({ pasta, projeto: 'horta', no: 'no3', jpeg: JPEG, t: tt, fusoHorario: 'America/Recife' });
  await salvar(T - 24 * 3600 * 1000); // dia anterior
  await salvar(T);
  await salvar(T); // mesmo segundo: -2
  await salvar(T + 600 * 1000);
  // Arquivos que não seguem o padrão são ignorados.
  await writeFile(join(pasta, 'horta', 'no3', '2026-11-10', 'anotacao.txt'), 'x');
  const lista = await listarImagens({ pasta, projeto: 'horta', no: 'no3', limite: 10 });
  assert.deepEqual(
    lista.map((i) => i.caminho),
    [
      'horta/no3/2026-11-10/15-02-07.jpg',
      'horta/no3/2026-11-10/14-52-07-2.jpg',
      'horta/no3/2026-11-10/14-52-07.jpg',
      'horta/no3/2026-11-09/14-52-07.jpg',
    ],
  );
  assert.equal((await listarImagens({ pasta, projeto: 'horta', no: 'no3', limite: 2 })).length, 2);
  assert.deepEqual(await listarImagens({ pasta, projeto: 'horta', no: 'no9' }), []);
});

test('última imagem de cada nó, para o painel ao ligar', async (t) => {
  const pasta = await pastaTemporaria(t);
  await salvarImagem({ pasta, projeto: 'horta', no: 'no3', jpeg: JPEG, t: T, fusoHorario: 'America/Recife' });
  await salvarImagem({ pasta, projeto: 'teste', no: 'no7', jpeg: JPEG, t: T, fusoHorario: 'America/Recife' });
  await mkdir(join(pasta, 'lixo'), { recursive: true }); // pasta fora do catálogo
  const ultimas = await ultimasImagens({ pasta, nomeValido: NOME_VALIDO, noValido: NO_VALIDO });
  assert.deepEqual(
    ultimas.map(({ projeto, no, caminho }) => ({ projeto, no, caminho })),
    [
      { projeto: 'horta', no: 'no3', caminho: 'horta/no3/2026-11-10/14-52-07.jpg' },
      { projeto: 'teste', no: 'no7', caminho: 'teste/no7/2026-11-10/14-52-07.jpg' },
    ],
  );
  assert.ok(ultimas.every((u) => Number.isSafeInteger(u.t)));
});

test('espaço livre em bytes', async (t) => {
  const pasta = await pastaTemporaria(t);
  assert.ok((await espacoLivre(pasta)) > 0);
});
