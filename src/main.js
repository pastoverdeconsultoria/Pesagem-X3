import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Haptics } from '@capacitor/haptics';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Balanca, Bastao } from './devices.js';
import {
  Estabilidade, estatisticas, novaSessao, parseBrinco, fmtBrinco,
  fmt1, fmt0, parseNum, hora, dataBR, gerarCSV
} from './logic.js';
import { gerarPDF, nomeArquivo } from './report.js';

// ================== Estado ==================
const CHAVE = 'pesagem.sessoes.v1';
const nativo = Capacitor.isNativePlatform();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function carregar() { try { return JSON.parse(localStorage.getItem(CHAVE)) || []; } catch { return []; } }
function salvar() { try { localStorage.setItem(CHAVE, JSON.stringify(S.sessoes)); } catch { toast('Erro ao salvar no celular'); } }

const hoje = () => {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const S = {
  tela: 'inicio',
  sessoes: carregar(),
  atual: null,               // sessão aberta
  modoNovo: 'individual',
  pesoVivo: null, pesoTs: 0,
  pesoEditado: false,        // operador digitou o peso (não sobrescrever com o vivo)
  pendente: null,            // brinco lido aguardando peso
  ultimoPeriodoUsado: -1,    // período de peso já usado num registro
  dup: null,                 // { brinco, idx } brinco repetido aguardando decisão
  auto: localStorage.getItem('pref.auto') !== '0',
  ultimaLinha: '',
  balancaMsg: '', bastaoMsg: ''
};

const est = new Estabilidade({ tol: 1.0, holdMs: 1500, minKg: 15 });

// ================== Equipamentos ==================
const balanca = new Balanca({
  onPeso: kg => { S.pesoVivo = kg; S.pesoTs = Date.now(); est.update(kg); atualizaPeso(); },
  onEstado: (e, msg) => { S.balancaMsg = msg; atualizaEquip(); }
});

const bastao = new Bastao({
  onLinha: l => { S.ultimaLinha = l; const el = $('ultimaLinha'); if (el) el.textContent = l; },
  onBrinco: linha => {
    const b = parseBrinco(linha);
    if (b) brincoLido(b);
  },
  onEstado: (e, msg) => { S.bastaoMsg = msg; atualizaEquip(); }
});

// ================== Feedback ==================
let audioCtx = null;
function bip(freq = 1200, ms = 120) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.25, audioCtx.currentTime);
    o.start(); o.stop(audioCtx.currentTime + ms / 1000);
  } catch { /* sem áudio */ }
}
function vibra(ms = 200) { if (nativo) Haptics.vibrate({ duration: ms }).catch(() => {}); else navigator.vibrate?.(ms); }
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

// ================== Navegação ==================
function irInicio() {
  S.tela = 'inicio'; S.atual = null; S.pendente = null; S.dup = null;
  if (nativo) KeepAwake.allowSleep().catch(() => {});
  render();
}
function abrirSessao(id) {
  S.atual = S.sessoes.find(s => s.id === id);
  if (!S.atual) return;
  S.tela = 'sessao'; S.pendente = null; S.dup = null; S.pesoEditado = false;
  S.ultimoPeriodoUsado = est.inicioPeriodo();
  if (nativo) KeepAwake.keepAwake().catch(() => {});
  render();
  if (balanca.estado === 'desconectado') balanca.autoConectar();
  if (S.atual.modo === 'individual' && bastao.estado === 'desconectado') bastao.autoConectar();
}

// ================== Render ==================
function render() {
  fecharFolha();
  $('app').innerHTML = S.tela === 'inicio' ? telaInicio() : telaSessao();
  if (S.tela === 'sessao') { atualizaEquip(); atualizaPeso(); atualizaIndividual(); }
}

function telaInicio() {
  const abertas = S.sessoes.filter(s => !s.finalizada);
  const lista = [...S.sessoes].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
  return `
  <div class="topo"><h1><span class="marca">Pasto Verde Consultoria</span><br>Pesagem</h1></div>

  ${abertas.length ? `
  <div class="card">
    <h2>Em andamento</h2>
    ${abertas.map(s => `
      <div class="sessao-item">
        <div class="meio"><div class="t">${esc(s.cliente || 'Sem cliente')} · ${esc(s.lote || 'sem lote')}</div>
        <div class="q">${s.modo === 'lote' ? 'Lote' : 'Individual'} · ${dataBR(s.data)} · ${resumoCurto(s)}</div></div>
        <button class="btn peq" style="width:auto;padding:11px 16px" data-acao="abrir" data-id="${s.id}">Continuar</button>
      </div>`).join('')}
  </div>` : ''}

  <div class="card">
    <h2>Nova pesagem</h2>
    <label class="rot">Cliente / Fazenda</label>
    <input class="txt" id="nCliente" placeholder="Ex.: Fazenda Lago Azul" value="${esc(localStorage.getItem('ult.cliente') || '')}">
    <label class="rot">Lote / Piquete</label>
    <input class="txt" id="nLote" placeholder="Ex.: Lote 3 — Piquete 12">
    <label class="rot">Data</label>
    <input class="txt" id="nData" type="date" value="${hoje()}">
    <label class="rot">Modo</label>
    <div class="modos">
      <button class="modo ${S.modoNovo === 'individual' ? 'on' : ''}" data-acao="modo" data-modo="individual"><b>Individual</b><span>brinco + peso<br>(bastão)</span></button>
      <button class="modo ${S.modoNovo === 'lote' ? 'on' : ''}" data-acao="modo" data-modo="lote"><b>Lote</b><span>grupo + quantidade<br>(média)</span></button>
    </div>
    <button class="btn" style="margin-top:14px" data-acao="iniciar">Iniciar pesagem</button>
  </div>

  <div class="card">
    <h2>Sessões salvas</h2>
    <div class="lista">
      ${lista.length ? lista.map(s => `
        <div class="sessao-item" data-acao="opcoes" data-id="${s.id}">
          <div class="meio"><div class="t">${esc(s.cliente || 'Sem cliente')} · ${esc(s.lote || 'sem lote')}</div>
          <div class="q">${dataBR(s.data)} · ${s.modo === 'lote' ? 'Lote' : 'Individual'} · ${resumoCurto(s)}${s.finalizada ? '' : ' · <b style="color:var(--aviso)">aberta</b>'}</div></div>
          <span style="color:var(--sub);font-size:22px">›</span>
        </div>`).join('') : '<div class="vazio">Nenhuma sessão ainda</div>'}
    </div>
  </div>
  <p class="rodape">Balança Tru-Test S3 (Bluetooth) · Bastão SRS2 (Bluetooth clássico)<br>Dados ficam salvos neste celular</p>`;
}

function resumoCurto(s) {
  const st = estatisticas(s);
  return st.nAnimais ? `${st.nAnimais} an · méd ${fmt1(st.media)} kg` : 'sem registros';
}

function telaSessao() {
  const s = S.atual, ind = s.modo === 'individual';
  return `
  <div class="topo">
    <button class="btn-ic" data-acao="voltar">←</button>
    <h1>${esc(s.cliente || 'Sem cliente')}<small>${esc(s.lote || 'sem lote')} · ${dataBR(s.data)}</small></h1>
    <span class="selo">${ind ? 'Individual' : 'Lote'}</span>
  </div>

  <div class="equips">
    <button class="equip" id="eqBal" data-acao="folhaBalanca"><span class="dot"></span><span><b>Balança</b><small id="eqBalTxt">—</small></span></button>
    ${ind ? `<button class="equip" id="eqBas" data-acao="folhaBastao"><span class="dot"></span><span><b>Bastão</b><small id="eqBasTxt">—</small></span></button>` : ''}
  </div>
  <div id="alertas"></div>

  <div class="peso-card" id="pesoCard">
    <div class="peso-rot">Peso na balança <span class="estab nao" id="estab">—</span></div>
    <div class="peso-valor velho" id="peso">––<span class="un">kg</span></div>
  </div>

  ${ind ? blocoIndividual() : blocoLote()}

  <div class="totais" id="totais"></div>

  <div class="card">
    <h2>${ind ? 'Animais pesados' : 'Pesagens registradas'}</h2>
    <div class="lista" id="lista"></div>
  </div>

  <button class="btn contorno" data-acao="finalizar">Finalizar e gerar relatório</button>`;
}

function blocoIndividual() {
  return `
  <div class="card">
    <div class="brinco-box" id="brincoBox"><div class="b" id="brincoTxt">—</div><div class="s" id="brincoSub">Leia o brinco com o bastão</div></div>
    <p class="passo" id="passo" style="margin-top:10px"></p>
    <div class="toggle" style="margin-top:10px"><span>Registrar sozinho quando o peso estabilizar</span>
      <input type="checkbox" id="chkAuto" ${S.auto ? 'checked' : ''}></div>
    <details style="margin-top:10px">
      <summary style="font-size:13px;color:var(--sub)">Entrada manual (sem bastão / brinco perdido)</summary>
      <label class="rot">Brinco</label>
      <input class="txt mono" id="inBrinco" inputmode="numeric" placeholder="982 000…">
      <label class="rot">Peso (kg)</label>
      <input class="grande" id="inPesoInd" inputmode="decimal" placeholder="0,0">
      <button class="btn sec peq" style="margin-top:10px" data-acao="regManual">Registrar manualmente</button>
    </details>
    <button class="btn" style="margin-top:12px" id="btnRegAgora" data-acao="regAgora">Registrar agora</button>
  </div>`;
}

function blocoLote() {
  return `
  <div class="card">
    <label class="rot" style="margin-top:0">Peso do grupo (kg)</label>
    <input class="grande" id="inPeso" inputmode="decimal" placeholder="0,0">
    <label class="rot">Quantidade de animais na balança</label>
    <div class="stepper-row">
      <button class="stepper" data-acao="qtd" data-d="-1">−</button>
      <input class="grande" id="inQtd" type="number" inputmode="numeric" min="1" placeholder="0">
      <button class="stepper" data-acao="qtd" data-d="1">+</button>
    </div>
    <button class="btn" style="margin-top:12px" data-acao="regLote">Registrar pesagem</button>
  </div>`;
}

// ---------- atualizações parciais (sem redesenhar a tela) ----------
const ROT = { conectado: 'Conectado', conectando: 'Conectando…', desconectado: 'Toque p/ conectar', erro: 'Falhou — tocar' };

function atualizaEquip() {
  if (S.tela !== 'sessao') return;
  const bal = $('eqBal');
  if (bal) {
    bal.className = 'equip ' + balanca.estado;
    $('eqBalTxt').textContent = balanca.id ? (balanca.estado === 'desconectado' && !balanca.manual ? 'Reconectando…' : ROT[balanca.estado]) : 'Escolher balança';
  }
  const bas = $('eqBas');
  if (bas) {
    bas.className = 'equip ' + bastao.estado;
    $('eqBasTxt').textContent = bastao.endereco ? ROT[bastao.estado] : 'Escolher bastão';
  }
  const al = [];
  if (balanca.estado === 'erro' && S.balancaMsg) al.push(`<div class="alerta erro">Balança: ${esc(S.balancaMsg)}. Confira se ela está ligada e perto do celular.</div>`);
  if (S.atual?.modo === 'individual' && bastao.estado === 'erro' && S.bastaoMsg) al.push(`<div class="alerta erro">${esc(S.bastaoMsg)}</div>`);
  if (S.dup) {
    const r = S.atual.registros[S.dup.idx];
    al.push(`<div class="alerta aviso"><b>Brinco já pesado nesta sessão</b><br>${fmtBrinco(S.dup.brinco)} — ${fmt1(r.peso)} kg às ${hora(r.ts)}
      <div class="linha-btn" style="margin-top:9px"><button class="btn peq" data-acao="dupSubst">Substituir pelo peso atual</button><button class="btn sec peq" data-acao="dupIgnorar">Ignorar</button></div></div>`);
  }
  const box = $('alertas'); if (box) box.innerHTML = al.join('');
}

function atualizaPeso() {
  if (S.tela !== 'sessao') return;
  const el = $('peso');
  const velho = !S.pesoTs || Date.now() - S.pesoTs > 8000 || balanca.estado !== 'conectado';
  if (S.pesoVivo !== null) el.innerHTML = fmt1(S.pesoVivo) + '<span class="un">kg</span>';
  el.classList.toggle('velho', velho);
  const e = $('estab'), ok = !velho && est.estavel();
  e.className = 'estab ' + (ok ? 'sim' : 'nao');
  e.textContent = velho ? 'sem sinal' : ok ? 'ESTÁVEL' : (S.pesoVivo < est.minKg ? 'vazia' : 'estabilizando');
  if (S.atual.modo === 'lote') {
    const inp = $('inPeso');
    if (inp && !S.pesoEditado && S.pesoVivo !== null && document.activeElement !== inp) inp.value = fmt1(S.pesoVivo);
  } else {
    const inp = $('inPesoInd');
    if (inp && document.activeElement !== inp && S.pesoVivo !== null) inp.value = fmt1(S.pesoVivo);
  }
  atualizaIndividual();
  atualizaTotais();
}

function atualizaIndividual() {
  if (S.tela !== 'sessao' || S.atual.modo !== 'individual') return;
  const box = $('brincoBox'); if (!box) return;
  const p = S.pendente;
  box.classList.toggle('lido', !!p);
  $('brincoTxt').textContent = p ? fmtBrinco(p) : '—';
  $('brincoSub').textContent = p ? 'Brinco lido' : 'Leia o brinco com o bastão';
  const passo = $('passo');
  const velho = !S.pesoTs || balanca.estado !== 'conectado';
  if (!p) passo.innerHTML = 'Aguardando leitura do brinco';
  else if (velho) passo.innerHTML = '<b>Balança sem sinal</b> — conecte ou use a entrada manual';
  else if (!est.estavel()) passo.innerHTML = 'Aguardando o peso <b>estabilizar</b>…';
  else if (est.inicioPeriodo() <= S.ultimoPeriodoUsado) passo.innerHTML = 'Peso ainda é do animal anterior — aguardando troca';
  else passo.innerHTML = S.auto ? 'Registrando…' : 'Peso estável — toque em <b>Registrar agora</b>';
  const btn = $('btnRegAgora');
  if (btn) btn.disabled = !p || S.pesoVivo === null || S.pesoVivo <= 0;
}

function atualizaTotais() {
  if (S.tela !== 'sessao') return;
  const s = S.atual, st = estatisticas(s), ind = s.modo === 'individual';
  const t = $('totais');
  if (t) t.innerHTML = `
    <div class="tot"><div class="n">${st.nAnimais}</div><div class="l">Animais</div></div>
    <div class="tot"><div class="n">${fmt0(st.pesoTotal)}</div><div class="l">Peso total kg</div></div>
    <div class="tot d"><div class="n">${fmt1(st.media)}</div><div class="l">Média kg/an</div></div>`;
  const l = $('lista');
  if (!l) return;
  const sig = s.registros.length + ':' + (s.registros.at(-1)?.ts || 0) + ':' + (s.registros.at(-1)?.peso || 0);
  if (l.dataset.sig === sig) return;
  l.dataset.sig = sig;
  if (!s.registros.length) { l.innerHTML = '<div class="vazio">Nenhum registro ainda</div>'; return; }
  l.innerHTML = s.registros.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => ind ? `
    <div class="item"><span class="idx">#${i + 1}</span>
      <div class="meio"><div class="p">${fmtBrinco(r.brinco)}</div><div class="q">${hora(r.ts)}${r.manual ? ' · manual' : ''}${r.subst ? ' · substituído' : ''}</div></div>
      <span class="val">${fmt1(r.peso)} kg</span><button class="x" data-acao="apagar" data-i="${i}">✕</button></div>` : `
    <div class="item"><span class="idx">#${i + 1}</span>
      <div class="meio"><div class="p">${r.qtd} an · ${fmt1(r.peso)} kg</div><div class="q">${hora(r.ts)}</div></div>
      <span class="val">${fmt1(r.peso / r.qtd)}</span><button class="x" data-acao="apagar" data-i="${i}">✕</button></div>`).join('');
}

// ================== Pesagem individual ==================
function brincoLido(b) {
  if (S.tela !== 'sessao' || S.atual.modo !== 'individual') { toast('Brinco lido: ' + fmtBrinco(b)); return; }
  const regs = S.atual.registros;
  const ult = regs.at(-1);
  // releitura do mesmo animal ainda na balança: ignora em silêncio
  if (b === S.pendente) return;
  if (ult && ult.brinco === b && est.inicioPeriodo() <= S.ultimoPeriodoUsado) return;
  const idx = regs.findIndex(r => r.brinco === b);
  if (idx >= 0) { S.dup = { brinco: b, idx }; bip(500, 300); vibra(400); atualizaEquip(); return; }
  if (S.pendente) toast('Brinco ' + fmtBrinco(S.pendente) + ' descartado (sem peso)');
  S.pendente = b; S.dup = null;
  bip(900, 80); vibra(80);
  atualizaEquip(); atualizaIndividual();
}

function registraIndividual(brinco, peso, manual) {
  if (!brinco || !(peso > 0)) return;
  S.atual.registros.push({ brinco, peso: Math.round(peso * 10) / 10, ts: Date.now(), manual });
  S.ultimoPeriodoUsado = est.inicioPeriodo();
  if (brinco === S.pendente) S.pendente = null;
  salvar();
  bip(1400, 150); vibra(250);
  const c = $('pesoCard'); if (c) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  toast(`✔ ${fmtBrinco(brinco)} — ${fmt1(peso)} kg`);
  atualizaIndividual(); atualizaTotais();
}

function verificaAuto() {
  if (S.tela !== 'sessao' || S.atual.modo !== 'individual') return;
  atualizaPeso();
  if (!S.auto || !S.pendente || S.dup) return;
  if (balanca.estado !== 'conectado' || Date.now() - S.pesoTs > 8000) return;
  if (!est.estavel()) return;
  if (est.inicioPeriodo() <= S.ultimoPeriodoUsado) return;
  registraIndividual(S.pendente, est.peso, false);
}
setInterval(() => { if (S.tela === 'sessao') { if (S.atual.modo === 'individual') verificaAuto(); else atualizaPeso(); } }, 250);

// ================== Folhas (equipamentos, finalizar, sessão) ==================
function abrirFolha(html) { $('sheetBody').innerHTML = html; $('sheet').classList.add('on'); }
function fecharFolha() { $('sheet').classList.remove('on'); }
$('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') fecharFolha(); });

function folhaBalanca() {
  abrirFolha(`
    <h3>Balança Tru-Test S3</h3>
    <p>${balanca.id ? `Escolhida: <b>${esc(balanca.nome)}</b> · ${ROT[balanca.estado] || ''}` : 'Nenhuma balança escolhida ainda.'}</p>
    <p>Ligue a balança e deixe o Bluetooth do celular ligado. Ela só aceita um aparelho por vez: feche o app Data Link se estiver aberto.</p>
    <button class="btn" data-acao="balProcurar">Procurar balança</button>
    ${balanca.id ? `<div class="linha-btn"><button class="btn sec peq" data-acao="balReconectar">Reconectar</button><button class="btn perigo peq" data-acao="balDesconectar">Desconectar</button></div>` : ''}
    <button class="btn sec peq" data-acao="fechar">Fechar</button>`);
}

async function folhaBastao() {
  abrirFolha(`<h3>Bastão SRS2</h3><p>Buscando bastões pareados…</p>`);
  let devs = [], erro = '';
  try { devs = await bastao.pareados(); } catch (e) { erro = e?.message || String(e); }
  const prov = devs.filter(d => /srs|xrs|tru|stick|eid/i.test(d.name));
  const resto = devs.filter(d => !prov.includes(d));
  const opt = d => `<button class="dev-opt" data-acao="basEscolher" data-end="${esc(d.address)}" data-nome="${esc(d.name)}">
      <span>${esc(d.name)}<small>${esc(d.address)}</small></span><span style="color:var(--ouro)">${d.address === bastao.endereco ? '●' : 'Usar'}</span></button>`;
  abrirFolha(`
    <h3>Bastão SRS2</h3>
    ${bastao.endereco ? `<p>Escolhido: <b>${esc(bastao.nome)}</b> · ${ROT[bastao.estado] || ''}</p>` : ''}
    ${erro ? `<div class="alerta erro">${esc(erro)}</div>` : ''}
    ${prov.map(opt).join('')}
    ${resto.length ? `<p style="margin-top:4px">Outros aparelhos pareados:</p>${resto.map(opt).join('')}` : ''}
    ${!devs.length && !erro ? '<p>Nenhum aparelho pareado.</p>' : ''}
    <p><b>Primeira vez?</b> Pareie o bastão nas configurações de Bluetooth do Android (no bastão: Configurações → Bluetooth). Se pedir PIN, tente 0000 ou 1234. Depois volte aqui.</p>
    <p>O bastão só conecta em um aparelho por vez. Se a luz azul dele estiver acesa, ele está preso em outro celular ou na balança.</p>
    <button class="btn sec peq" data-acao="basAndroid">Abrir Bluetooth do Android</button>
    ${bastao.endereco ? `<div class="linha-btn"><button class="btn sec peq" data-acao="basReconectar">Reconectar</button><button class="btn perigo peq" data-acao="basDesconectar">Desconectar</button></div>` : ''}
    <p style="font-size:12px">Última leitura recebida: <span class="mono" id="ultimaLinha">${esc(S.ultimaLinha || '—')}</span></p>
    <button class="btn sec peq" data-acao="fechar">Fechar</button>`);
}

function folhaFinalizar() {
  const s = S.atual, st = estatisticas(s), ind = s.modo === 'individual';
  abrirFolha(`
    <h3>Resumo da sessão</h3>
    <div class="totais">
      <div class="tot"><div class="n">${st.nAnimais}</div><div class="l">Animais</div></div>
      <div class="tot"><div class="n">${fmt0(st.pesoTotal)}</div><div class="l">Peso total kg</div></div>
      <div class="tot d"><div class="n">${fmt1(st.media)}</div><div class="l">Média kg/an</div></div>
      <div class="tot"><div class="n">${fmt1(st.arroba)}</div><div class="l">@ média*</div></div>
      <div class="tot"><div class="n">${fmt1(st.cv)}%</div><div class="l">${ind ? 'CV' : 'CV entre pesagens'}</div></div>
      <div class="tot"><div class="n">${ind ? fmt1(st.min) + '–' + fmt1(st.max) : st.registros}</div><div class="l">${ind ? 'Mín–Máx kg' : 'Pesagens'}</div></div>
    </div>
    <p style="font-size:12px">* arroba estimada com rendimento de 50% (peso vivo ÷ 30)</p>
    <button class="btn" data-acao="pdf" data-id="${s.id}" ${st.registros ? '' : 'disabled'}>Gerar relatório PDF</button>
    <button class="btn sec" data-acao="csv" data-id="${s.id}" ${st.registros ? '' : 'disabled'}>Gerar planilha CSV</button>
    ${s.finalizada ? '' : `<button class="btn contorno" data-acao="encerrar">Encerrar sessão</button>`}
    <button class="btn sec peq" data-acao="fechar">Voltar à pesagem</button>`);
}

function folhaOpcoes(id) {
  const s = S.sessoes.find(x => x.id === id); if (!s) return;
  abrirFolha(`
    <h3>${esc(s.cliente || 'Sem cliente')} · ${esc(s.lote || 'sem lote')}</h3>
    <p>${dataBR(s.data)} · ${s.modo === 'lote' ? 'Lote' : 'Individual'} · ${resumoCurto(s)}</p>
    <button class="btn" data-acao="abrir" data-id="${s.id}">${s.finalizada ? 'Abrir (reabrir sessão)' : 'Continuar pesagem'}</button>
    <div class="linha-btn"><button class="btn sec peq" data-acao="pdf" data-id="${s.id}">PDF</button><button class="btn sec peq" data-acao="csv" data-id="${s.id}">CSV</button></div>
    <button class="btn perigo peq" data-acao="excluir" data-id="${s.id}">Excluir sessão</button>
    <button class="btn sec peq" data-acao="fechar">Fechar</button>`);
}

// ================== Exportar ==================
async function compartilhar(nome, conteudo, mime, ehTexto) {
  if (nativo) {
    const r = await Filesystem.writeFile({
      path: nome, data: conteudo, directory: Directory.Cache,
      ...(ehTexto ? { encoding: Encoding.UTF8 } : {})
    });
    try { await Share.share({ title: nome, files: [r.uri], dialogTitle: 'Enviar ' + nome }); }
    catch (e) { if (!/cancel/i.test(e?.message || '')) throw e; }
  } else {
    const blob = ehTexto ? new Blob([conteudo], { type: mime })
      : new Blob([Uint8Array.from(atob(conteudo), c => c.charCodeAt(0))], { type: mime });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
  }
}
async function exportarPDF(id) {
  const s = S.sessoes.find(x => x.id === id); if (!s?.registros.length) return toast('Sessão sem registros');
  toast('Gerando PDF…');
  try {
    const b64 = gerarPDF(s).output('datauristring').split(',')[1];
    await compartilhar(nomeArquivo(s, 'pdf'), b64, 'application/pdf', false);
  } catch (e) { toast('Erro ao gerar PDF: ' + (e?.message || e), 5000); }
}
async function exportarCSV(id) {
  const s = S.sessoes.find(x => x.id === id); if (!s?.registros.length) return toast('Sessão sem registros');
  try { await compartilhar(nomeArquivo(s, 'csv'), gerarCSV(s), 'text/csv', true); }
  catch (e) { toast('Erro ao gerar CSV: ' + (e?.message || e), 5000); }
}

// ================== Ações ==================
const acoes = {
  modo: el => { S.modoNovo = el.dataset.modo; document.querySelectorAll('.modo').forEach(m => m.classList.toggle('on', m === el)); },
  iniciar: () => {
    const cliente = $('nCliente').value.trim(), lote = $('nLote').value.trim(), data = $('nData').value || hoje();
    if (!cliente) { toast('Informe o cliente / fazenda'); $('nCliente').focus(); return; }
    localStorage.setItem('ult.cliente', cliente);
    const s = novaSessao({ modo: S.modoNovo, cliente, lote, data });
    S.sessoes.push(s); salvar(); abrirSessao(s.id);
  },
  abrir: el => { const s = S.sessoes.find(x => x.id === el.dataset.id); if (s?.finalizada) { s.finalizada = false; salvar(); } abrirSessao(el.dataset.id); },
  opcoes: el => folhaOpcoes(el.dataset.id),
  voltar: () => irInicio(),
  fechar: () => fecharFolha(),
  excluir: el => {
    if (!confirm('Excluir esta sessão e todos os registros? Não dá para desfazer.')) return;
    S.sessoes = S.sessoes.filter(s => s.id !== el.dataset.id); salvar(); render();
  },
  folhaBalanca: () => folhaBalanca(),
  folhaBastao: () => folhaBastao(),
  balProcurar: async () => { fecharFolha(); try { await balanca.procurar(); toast('Balança conectada'); } catch (e) { if (!/cancel/i.test(e?.message || '')) toast('Balança: ' + (e?.message || e), 5000); } },
  balReconectar: async () => { fecharFolha(); try { await balanca.conectar(); } catch { /* aviso já exibido */ } },
  balDesconectar: async () => { fecharFolha(); await balanca.desconectar(); },
  basEscolher: async el => { fecharFolha(); try { await bastao.escolher({ address: el.dataset.end, name: el.dataset.nome }); toast('Bastão conectado'); } catch { /* aviso já exibido */ } },
  basReconectar: async () => { fecharFolha(); try { await bastao.conectar(); toast('Bastão conectado'); } catch { /* aviso */ } },
  basDesconectar: async () => { fecharFolha(); await bastao.desconectar(); },
  basAndroid: () => bastao.abrirBluetoothAndroid(),
  qtd: el => { const i = $('inQtd'); i.value = Math.max(0, (parseInt(i.value) || 0) + parseInt(el.dataset.d)); },
  regLote: () => {
    const peso = parseNum($('inPeso').value), qtd = parseInt($('inQtd').value) || 0;
    if (!(peso > 0)) return toast('Peso precisa ser maior que zero');
    if (qtd < 1) return toast('Informe quantos animais estão na balança');
    S.atual.registros.push({ qtd, peso: Math.round(peso * 10) / 10, ts: Date.now() });
    salvar(); bip(1400, 150); vibra(200);
    $('inQtd').value = ''; S.pesoEditado = false;
    toast(`✔ ${qtd} animais — ${fmt1(peso)} kg (méd ${fmt1(peso / qtd)})`);
    atualizaPeso();
  },
  regAgora: () => {
    if (!S.pendente) return toast('Leia o brinco primeiro');
    if (!(S.pesoVivo > 0)) return toast('Sem peso da balança');
    if (!est.estavel() && !confirm('O peso ainda não estabilizou. Registrar mesmo assim?')) return;
    registraIndividual(S.pendente, S.pesoVivo, false);
  },
  regManual: () => {
    const b = parseBrinco($('inBrinco').value) || $('inBrinco').value.replace(/\D/g, '');
    const p = parseNum($('inPesoInd').value);
    if (!b) return toast('Informe o brinco');
    if (!(p > 0)) return toast('Informe o peso');
    if (S.atual.registros.some(r => r.brinco === b) && !confirm('Esse brinco já foi pesado nesta sessão. Registrar de novo?')) return;
    registraIndividual(b, p, true);
    $('inBrinco').value = '';
  },
  dupSubst: () => {
    const r = S.atual.registros[S.dup.idx];
    if (!(S.pesoVivo > 0)) return toast('Sem peso da balança');
    r.peso = Math.round(S.pesoVivo * 10) / 10; r.ts = Date.now(); r.subst = true;
    S.ultimoPeriodoUsado = est.inicioPeriodo();
    S.dup = null; salvar(); bip(1400, 150); vibra(250);
    toast(`✔ ${fmtBrinco(r.brinco)} atualizado — ${fmt1(r.peso)} kg`);
    atualizaEquip(); atualizaTotais();
    $('lista').dataset.sig = ''; atualizaTotais();
  },
  dupIgnorar: () => { S.dup = null; atualizaEquip(); },
  apagar: el => {
    const i = +el.dataset.i, r = S.atual.registros[i];
    const desc = S.atual.modo === 'lote' ? `${r.qtd} animais / ${fmt1(r.peso)} kg` : `${fmtBrinco(r.brinco)} / ${fmt1(r.peso)} kg`;
    if (!confirm('Apagar o registro #' + (i + 1) + ' (' + desc + ')?')) return;
    S.atual.registros.splice(i, 1); S.dup = null; salvar(); atualizaEquip(); atualizaTotais();
  },
  finalizar: () => folhaFinalizar(),
  encerrar: () => { S.atual.finalizada = true; salvar(); toast('Sessão encerrada e salva'); irInicio(); },
  pdf: el => exportarPDF(el.dataset.id),
  csv: el => exportarCSV(el.dataset.id)
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-acao]');
  if (!el) return;
  const fn = acoes[el.dataset.acao];
  if (fn) fn(el);
});
document.addEventListener('input', e => {
  if (e.target.id === 'inPeso') S.pesoEditado = e.target.value.trim() !== '';
});
document.addEventListener('change', e => {
  if (e.target.id === 'chkAuto') { S.auto = e.target.checked; localStorage.setItem('pref.auto', S.auto ? '1' : '0'); atualizaIndividual(); }
});

// Botão "voltar" do Android: fecha a folha ou volta ao início
if (nativo) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => {
      if ($('sheet').classList.contains('on')) fecharFolha();
      else if (S.tela === 'sessao') irInicio();
      else App.minimizeApp();
    });
  }).catch(() => {});
}

render();
