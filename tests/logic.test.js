import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeS3, parseBrinco, fmtBrinco, LineSplitter, Estabilidade,
  estatisticas, faixas, gerarCSV, fmt1
} from '../src/logic.js';

const dv = bytes => new DataView(Uint8Array.from(bytes).buffer);

test('balança S3: bytes reais de campo', () => {
  assert.equal(decodeS3(dv([0x04, 0xE4, 0x07, 0x00])), 101);   // display 101 kg
  assert.equal(decodeS3(dv([0x04, 0x94, 0x07, 0x00])), 97);    // 1940 raw
  assert.equal(decodeS3(dv([0x04, 0xD0, 0x07, 0x00])), 100);   // 2000 raw
  assert.equal(decodeS3(dv([0x04])), null);
});

test('bastão SRS2: brinco no formato real', () => {
  assert.equal(parseBrinco('982 000445531509'), '982000445531509');
  assert.equal(parseBrinco('  982 000445531509\r'), '982000445531509');
  assert.equal(parseBrinco('982000445531509'), '982000445531509');
  assert.equal(parseBrinco('lixo'), null);
  assert.equal(fmtBrinco('982000445531509'), '982 000445531509');
});

test('separador de linhas junta pedaços do Bluetooth', () => {
  const out = [];
  const s = new LineSplitter(l => out.push(l));
  s.push('982 0004'); s.push('45531509\r\n982 00');
  assert.deepEqual(out, ['982 000445531509']);
  s.push('0111222333\r\n');
  assert.deepEqual(out, ['982 000445531509', '982 000111222333']);
  s.push('982 000999888777'); s.flush();   // sem quebra de linha
  assert.equal(out.at(-1), '982 000999888777');
});

test('estabilidade: animal entra, balança oscila e assenta', () => {
  const e = new Estabilidade({ tol: 1, holdMs: 1500, minKg: 15 });
  let t = 0;
  e.update(0, t); assert.equal(e.estavel(t + 5000), false);            // vazia
  e.update(380, t += 100); e.update(392, t += 200); e.update(405, t += 200);
  assert.equal(e.estavel(t + 500), false);                            // ainda subindo
  const inicio = t;
  e.update(405.5, t += 300); e.update(404.8, t += 300);               // dentro de ±1
  assert.equal(e.estavel(inicio + 1400), false);
  assert.equal(e.estavel(inicio + 1600), true);
  const p1 = e.inicioPeriodo();
  e.update(0, t += 2000); e.update(398, t += 500);                    // troca de animal
  assert.ok(e.inicioPeriodo() > p1);
});

test('estatísticas de lote batem com o relatório da sessão real', () => {
  const pesos = [822, 766, 812, 734, 872, 794, 690, 732, 770, 736, 754, 666, 754, 742, 766, 686, 760,
    692, 700, 766, 680, 740, 714, 732, 720, 758, 720, 824, 786, 736, 774, 814, 752];
  const s = { modo: 'lote', registros: pesos.map(p => ({ qtd: 2, peso: p, ts: 0 })) };
  const st = estatisticas(s);
  assert.equal(st.nAnimais, 66);
  assert.equal(st.pesoTotal, 24764);
  assert.equal(fmt1(st.media), '375,2');
  assert.equal(fmt1(st.cv), '6,1');
  assert.equal(st.min, 333); assert.equal(st.max, 436);
});

test('estatísticas individuais', () => {
  const s = { modo: 'individual', registros: [400, 420, 380].map((p, i) => ({ brinco: '98200000000000' + i, peso: p, ts: 0 })) };
  const st = estatisticas(s);
  assert.equal(st.nAnimais, 3); assert.equal(st.media, 400);
  assert.equal(st.min, 380); assert.equal(st.max, 420);
  assert.equal(fmt1(st.arroba), '13,3');
  assert.deepEqual(faixas([380, 400, 420]).map(f => f.n), [1, 2]);
});

test('CSV tem cabeçalho, linhas e total', () => {
  const s = { modo: 'individual', cliente: 'Faz. Teste', lote: 'L1', data: '2026-11-10',
    registros: [{ brinco: '982000445531509', peso: 401.5, ts: 0, manual: false }] };
  const csv = gerarCSV(s);
  assert.ok(csv.startsWith('﻿Cliente/Fazenda;Faz. Teste'));
  assert.ok(csv.includes('1;982000445531509;401,5;'));
  assert.ok(csv.includes('TOTAL;1 animais;401,5'));
});
