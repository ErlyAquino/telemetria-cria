// Formatação das leituras em CSV, para a exportação do painel.
//
// Dois formatos:
//   br            — separador ";" e vírgula decimal, como o Excel e o LibreOffice
//                   em português esperam. É o padrão, para uso em sala.
//   internacional — separador "," e ponto decimal, para Python, R e afins.
// Veja decisoes/2026-10-18-csv-no-padrao-brasileiro.md.

export const COLUNAS = ['data_hora', 'projeto', 'no', 'grandeza', 'valor', 'unidade', 'seq', 'boot', 't_ms'];

// Marca de início que faz o Excel abrir o arquivo como UTF-8.
const BOM = '\uFEFF';
const FIM_DE_LINHA = '\r\n';

export function criarFormatador({ formato = 'br', fusoHorario } = {}) {
  if (formato !== 'br' && formato !== 'internacional') {
    throw new Error(`formato de CSV desconhecido: ${formato}`);
  }
  const separador = formato === 'br' ? ';' : ',';
  const decimal = formato === 'br' ? ',' : '.';

  // "sv-SE" escreve a data como 2026-10-18 14:32:07, que ordena certo e
  // que as planilhas reconhecem como data e hora.
  const formatoDeData = new Intl.DateTimeFormat('sv-SE', {
    timeZone: fusoHorario,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function campo(texto) {
    let s = String(texto);
    // Célula que começa com = + - @ a planilha lê como fórmula: o apóstrofo a
    // mantém como texto. As regras do catálogo já impedem isso; é uma segunda trava.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (s.includes(separador) || s.includes('"') || s.includes('\n')) return `"${s.replaceAll('"', '""')}"`;
    return s;
  }

  function numero(valor) {
    return String(valor).replace('.', decimal);
  }

  return {
    cabecalho() {
      return (formato === 'br' ? BOM : '') + COLUNAS.join(separador) + FIM_DE_LINHA;
    },
    // registro: { t, projeto, no, grandeza, valor, unidade, seq, boot }
    linha(r) {
      return (
        [
          formatoDeData.format(new Date(r.t)),
          campo(r.projeto),
          campo(r.no),
          campo(r.grandeza),
          numero(r.valor),
          campo(r.unidade),
          r.seq ?? '',
          r.boot ?? '',
          r.t,
        ].join(separador) + FIM_DE_LINHA
      );
    },
  };
}
