// Relatório PDF no padrão Pasto Verde Consultoria (texto vetorial, gerado offline no celular).
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { estatisticas, faixas, fmt1, fmt0, fmtBrinco, hora, dataBR } from './logic.js';

const VERDE = [42, 82, 64];
const OURO = [200, 169, 81];
const CREME = [247, 246, 242];
const TINTA = [18, 36, 27];
const CINZA = [91, 107, 96];
const LINHA = [227, 224, 216];

export function gerarPDF(sessao) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  const st = estatisticas(sessao);
  const individual = sessao.modo !== 'lote';

  // ---- Cabeçalho ----
  doc.setFillColor(...VERDE);
  doc.roundedRect(M, M, W - 2 * M, 26, 2, 2, 'F');
  doc.setTextColor(...OURO);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text('PASTO VERDE CONSULTORIA', M + 6, M + 9);
  doc.setTextColor(...CREME); doc.setFontSize(17);
  doc.text('Relatório de Pesagem', M + 6, M + 19);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.setTextColor(205, 214, 206);
  const meta = [
    `Data: ${dataBR(sessao.data)}`,
    `Modo: ${individual ? 'individual (brinco)' : 'lote'}`,
    'Balança: Tru-Test S3'
  ];
  meta.forEach((t, i) => doc.text(t, W - M - 6, M + 8 + i * 5.5, { align: 'right' }));

  // ---- Identificação ----
  let y = M + 35;
  doc.setTextColor(...TINTA); doc.setFontSize(10);
  doc.setFont('helvetica', 'bold'); doc.text('Cliente/Fazenda:', M, y);
  doc.setFont('helvetica', 'normal'); doc.text(sessao.cliente || '—', M + 30, y);
  doc.setFont('helvetica', 'bold'); doc.text('Lote/Piquete:', W / 2 + 4, y);
  doc.setFont('helvetica', 'normal'); doc.text(sessao.lote || '—', W / 2 + 29, y);

  // ---- Seção ----
  const secao = (titulo, yy) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...VERDE);
    doc.text(titulo.toUpperCase(), M, yy);
    doc.setDrawColor(...OURO); doc.setLineWidth(0.6);
    doc.line(M, yy + 1.8, W - M, yy + 1.8);
    return yy + 7;
  };

  // ---- Cards de resumo ----
  y = secao('Resumo', y + 10);
  const cards = individual
    ? [
        ['Animais', String(st.nAnimais)],
        ['Peso total (kg)', fmt0(st.pesoTotal)],
        ['Média (kg)', fmt1(st.media), true],
        ['@ média*', fmt1(st.arroba)],
        ['Mínimo (kg)', fmt1(st.min)],
        ['Máximo (kg)', fmt1(st.max)],
        ['Desvio padrão (kg)', fmt1(st.dp)],
        ['CV', fmt1(st.cv) + '%']
      ]
    : [
        ['Pesagens', String(st.registros)],
        ['Animais', String(st.nAnimais)],
        ['Peso total (kg)', fmt0(st.pesoTotal)],
        ['Média (kg/animal)', fmt1(st.media), true],
        ['@ média*', fmt1(st.arroba)],
        ['Mín. grupo (kg/an)', fmt1(st.min)],
        ['Máx. grupo (kg/an)', fmt1(st.max)],
        ['CV entre pesagens', fmt1(st.cv) + '%']
      ];
  const cols = 4, gap = 3, cw = (W - 2 * M - gap * (cols - 1)) / cols, ch = 17;
  cards.forEach(([rot, val, dest], i) => {
    const cx = M + (i % cols) * (cw + gap);
    const cy = y + Math.floor(i / cols) * (ch + gap);
    if (dest) { doc.setFillColor(...VERDE); doc.roundedRect(cx, cy, cw, ch, 1.5, 1.5, 'F'); }
    else { doc.setDrawColor(...LINHA); doc.setLineWidth(0.3); doc.roundedRect(cx, cy, cw, ch, 1.5, 1.5, 'S'); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.setTextColor(...(dest ? OURO : VERDE));
    doc.text(val, cx + cw / 2, cy + 8.5, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8);
    doc.setTextColor(...(dest ? [205, 214, 206] : CINZA));
    doc.text(rot.toUpperCase(), cx + cw / 2, cy + 13.5, { align: 'center' });
  });
  y += Math.ceil(cards.length / cols) * (ch + gap) + 4;

  // ---- Distribuição (só individual: é peso real de cada animal) ----
  if (individual && sessao.registros.length) {
    y = secao('Distribuição por faixa de peso', y + 2);
    const fx = faixas(sessao.registros.map(r => r.peso), 25);
    const maxN = Math.max(...fx.map(f => f.n), 1);
    const barW = W - 2 * M - 52;
    fx.forEach(f => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...CINZA);
      doc.text(`${f.de}–${f.ate} kg`, M + 30, y + 3.4, { align: 'right' });
      doc.setFillColor(231, 228, 220); doc.rect(M + 33, y, barW, 4.6, 'F');
      if (f.n) { doc.setFillColor(...VERDE); doc.rect(M + 33, y, (barW * f.n) / maxN, 4.6, 'F'); }
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...VERDE);
      doc.text(String(f.n), M + 35 + barW, y + 3.6);
      y += 6.4;
    });
    y += 3;
  }

  // ---- Tabela ----
  y = secao('Detalhamento', y + 2);
  const head = individual
    ? [['Nº', 'Número', 'Chip (brinco eletrônico)', 'Peso (kg)', 'Hora']]
    : [['Pesagem', 'Hora', 'Animais', 'Peso (kg)', 'Média/animal']];
  const body = individual
    ? sessao.registros.map((r, i) => [String(i + 1), r.numero || '—', r.brinco ? fmtBrinco(r.brinco) : '—', fmt1(r.peso) + (r.subst ? '*' : ''), hora(r.ts)])
    : sessao.registros.map((r, i) => [`#${i + 1}`, hora(r.ts), String(r.qtd), fmt1(r.peso), fmt1(r.peso / r.qtd)]);
  const foot = individual
    ? [['', `${st.nAnimais} animais`, `Média ${fmt1(st.media)} kg`, fmt1(st.pesoTotal), '']]
    : [['Total', '—', String(st.nAnimais), fmt1(st.pesoTotal), fmt1(st.media)]];

  autoTable(doc, {
    startY: y, head, body, foot,
    margin: { left: M, right: M, bottom: 18 },
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.6, textColor: TINTA, lineColor: LINHA, lineWidth: { bottom: 0.2 } },
    headStyles: { fillColor: [240, 238, 231], textColor: VERDE, fontStyle: 'bold', fontSize: 7.5 },
    footStyles: { fillColor: [240, 238, 231], textColor: TINTA, fontStyle: 'bold' },
    columnStyles: individual
      ? { 0: { halign: 'left', cellWidth: 12 }, 1: { halign: 'left', fontStyle: 'bold' }, 2: { halign: 'left' }, 3: { halign: 'right' }, 4: { halign: 'right' } }
      : { 0: { halign: 'left' }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    didParseCell: d => {
      if (d.section !== 'body') {
        const al = d.column.index > (individual ? 2 : 0) ? 'right' : 'left';
        d.cell.styles.halign = al;
      }
    }
  });
  y = doc.lastAutoTable.finalY + 6;

  // ---- Nota ----
  const nota = individual
    ? '* Arroba estimada com rendimento de carcaça de 50% (peso vivo ÷ 30). Peso com asterisco: substituído por nova pesagem na mesma sessão. Rendimento real varia com acabamento e categoria. Peso vivo de curral sofre efeito de enchimento (trato/água); sem jejum, tende a ficar acima do peso de balança comercial.'
    : '* Arroba estimada com rendimento de carcaça de 50% (peso vivo ÷ 30). Pesagem em grupo: o CV é calculado entre pesagens e subestima a variação individual real do lote. Para uniformidade e GMD por animal, use a pesagem individual.';
  doc.setFontSize(7.8); doc.setFont('helvetica', 'normal');
  const linhas = doc.splitTextToSize(nota, W - 2 * M - 8);
  const altura = linhas.length * 3.6 + 5;
  if (y + altura > doc.internal.pageSize.getHeight() - 18) { doc.addPage(); y = M; }
  doc.setFillColor(251, 246, 233); doc.rect(M, y, W - 2 * M, altura, 'F');
  doc.setFillColor(...OURO); doc.rect(M, y, 1, altura, 'F');
  doc.setTextColor(90, 81, 54);
  doc.text(linhas, M + 4, y + 4.6);

  // ---- Rodapé ----
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    const H = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...LINHA); doc.setLineWidth(0.3); doc.line(M, H - 12, W - M, H - 12);
    doc.setFontSize(7.5); doc.setTextColor(...CINZA); doc.setFont('helvetica', 'normal');
    doc.text('Pasto Verde Consultoria · Pesagem via balança Tru-Test S3' + (individual ? ' + bastão SRS2' : ''), M, H - 7.5);
    doc.text(`Página ${p} de ${total}`, W - M, H - 7.5, { align: 'right' });
  }
  return doc;
}

export function nomeArquivo(sessao, ext) {
  const limpa = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const partes = ['pesagem', limpa(sessao.cliente), limpa(sessao.lote), sessao.data].filter(Boolean);
  return partes.join('_') + '.' + ext;
}
