// Lógica pura do app (sem dependência de interface ou Bluetooth) — testável em Node.

// ---------- Balança Tru-Test S3 ----------
// Weight Measurement 0x2A9D: byte0 = flags, bytes1-2 = uint16 LE.
// Fator confirmado em campo: 2020 raw = 101 kg  → 0,05 kg por unidade.
// (A S3 declara 0,1 kg em 0x2A9E, mas o valor real é 0,05 — ignorar o declarado.)
export const FATOR_S3 = 0.05;
export function decodeS3(dataView) {
  if (!dataView || dataView.byteLength < 3) return null;
  return dataView.getUint16(1, true) * FATOR_S3;
}

// ---------- Bastão SRS2 ----------
// Saída padrão: "982 000445531509" (ISO 11784, 3 dígitos + 12 dígitos), uma linha por leitura.
const RE_EID = /(\d{3})[\s-]?(\d{12})/;
export function parseBrinco(line) {
  if (!line) return null;
  const m = String(line).match(RE_EID);
  return m ? m[1] + m[2] : null;
}
export function fmtBrinco(b) {
  if (!b) return '';
  const s = String(b);
  return /^\d{15}$/.test(s) ? s.slice(0, 3) + ' ' + s.slice(3) : s;
}

// Junta pedaços recebidos do Bluetooth em linhas. Se o bastão não mandar
// quebra de linha, a linha é liberada após um tempo sem dados (flush()).
export class LineSplitter {
  constructor(onLine) { this.buf = ''; this.onLine = onLine; }
  push(chunk) {
    this.buf += chunk;
    const parts = this.buf.split(/\r\n|\r|\n/);
    this.buf = parts.pop();
    for (const p of parts) if (p.trim()) this.onLine(p.trim());
  }
  flush() {
    if (this.buf.trim()) this.onLine(this.buf.trim());
    this.buf = '';
  }
}

// ---------- Estabilidade do peso ----------
// A S3 não informa "estável". Consideramos estável quando o peso fica dentro
// de ±tol kg por pelo menos holdMs, acima do peso mínimo.
export class Estabilidade {
  constructor({ tol = 1.0, holdMs = 1500, minKg = 15 } = {}) {
    this.tol = tol; this.holdMs = holdMs; this.minKg = minKg;
    this.peso = null; this.ancora = null; this.desde = 0;
  }
  update(kg, agora = Date.now()) {
    if (this.ancora === null || Math.abs(kg - this.ancora) > this.tol) {
      this.ancora = kg;
      this.desde = agora;
    }
    this.peso = kg;
  }
  estavel(agora = Date.now()) {
    return this.peso !== null && this.peso >= this.minKg && agora - this.desde >= this.holdMs;
  }
  // instante em que começou o período atual de peso (usado para não
  // reaproveitar o mesmo peso parado para dois brincos diferentes)
  inicioPeriodo() { return this.desde; }
}

// ---------- Estatísticas ----------
function dp(vals) {
  if (!vals.length) return 0;
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
}

export function estatisticas(sessao) {
  const regs = sessao?.registros || [];
  if (sessao?.modo === 'lote') {
    const nAnimais = regs.reduce((s, r) => s + r.qtd, 0);
    const pesoTotal = regs.reduce((s, r) => s + r.peso, 0);
    const media = nAnimais ? pesoTotal / nAnimais : 0;
    const medias = regs.map(r => r.peso / r.qtd);
    const d = dp(medias);
    const mMed = medias.length ? medias.reduce((s, v) => s + v, 0) / medias.length : 0;
    return {
      registros: regs.length, nAnimais, pesoTotal, media,
      min: medias.length ? Math.min(...medias) : 0,
      max: medias.length ? Math.max(...medias) : 0,
      dp: d, cv: mMed ? (d / mMed) * 100 : 0, arroba: media / 30
    };
  }
  const pesos = regs.map(r => r.peso);
  const n = pesos.length;
  const pesoTotal = pesos.reduce((s, v) => s + v, 0);
  const media = n ? pesoTotal / n : 0;
  const d = dp(pesos);
  return {
    registros: n, nAnimais: n, pesoTotal, media,
    min: n ? Math.min(...pesos) : 0,
    max: n ? Math.max(...pesos) : 0,
    dp: d, cv: media ? (d / media) * 100 : 0, arroba: media / 30
  };
}

// Faixas de peso por animal (para o gráfico do relatório)
export function faixas(valores, largura = 25) {
  if (!valores.length) return [];
  const ini = Math.floor(Math.min(...valores) / largura) * largura;
  const fim = Math.floor(Math.max(...valores) / largura) * largura;
  const out = [];
  for (let a = ini; a <= fim; a += largura) {
    out.push({ de: a, ate: a + largura, n: valores.filter(v => v >= a && v < a + largura).length });
  }
  return out;
}

// ---------- Formatação ----------
export const fmt1 = n => (Number(n) || 0).toFixed(1).replace('.', ',');
export const fmt0 = n => Math.round(Number(n) || 0).toLocaleString('pt-BR');
export const parseNum = v => parseFloat(String(v ?? '').replace(',', '.')) || 0;
export const hora = (ts = Date.now()) =>
  new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dataBR = iso => (iso ? iso.split('-').reverse().join('/') : '');

// ---------- CSV ----------
export function gerarCSV(sessao) {
  const st = estatisticas(sessao);
  const L = [];
  L.push(`Cliente/Fazenda;${sessao.cliente || ''}`);
  L.push(`Lote/Piquete;${sessao.lote || ''}`);
  L.push(`Data;${dataBR(sessao.data)}`);
  L.push(`Modo;${sessao.modo === 'lote' ? 'Lote' : 'Individual'}`);
  L.push('');
  if (sessao.modo === 'lote') {
    L.push('Pesagem;Hora;Animais;Peso_kg;Media_kg_animal');
    sessao.registros.forEach((r, i) =>
      L.push(`${i + 1};${hora(r.ts)};${r.qtd};${fmt1(r.peso)};${fmt1(r.peso / r.qtd)}`));
    L.push(`TOTAL;;${st.nAnimais};${fmt1(st.pesoTotal)};${fmt1(st.media)}`);
  } else {
    L.push('N;Brinco;Peso_kg;Hora;Origem');
    sessao.registros.forEach((r, i) =>
      L.push(`${i + 1};${r.brinco};${fmt1(r.peso)};${hora(r.ts)};${r.manual ? 'manual' : 'automatico'}`));
    L.push(`TOTAL;${st.nAnimais} animais;${fmt1(st.pesoTotal)};;`);
    L.push(`MEDIA;;${fmt1(st.media)};;`);
  }
  return '﻿' + L.join('\r\n') + '\r\n';
}

// ---------- Sessões ----------
export function novaSessao({ modo, cliente, lote, data }) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    modo, cliente: cliente || '', lote: lote || '', data,
    criadaEm: new Date().toISOString(), finalizada: false, registros: []
  };
}
