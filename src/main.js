import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Haptics } from '@capacitor/haptics';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Balanca, Bastao } from './devices.js';
import {
  Estabilidade, estatisticas, novaSessao, parseBrinco, fmtBrinco,
  fmt1, fmt0, parseNum, hora, dataBR, gerarCSV,
  chaveFazenda, normNumero, ehChip, numeroDoChip, chipDoNumero, ativos,
  vincular, liberarChip
} from './logic.js';
import { gerarPDF, nomeArquivo } from './report.js';

// ================== Estado ==================
const CHAVE = 'pesagem.sessoes.v1';
const CHAVE_VINC = 'pesagem.brincos.v1';
const nativo = Capacitor.isNativePlatform();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ler(chave) { try { return JSON.parse(localStorage.getItem(chave)) || []; } catch { return []; } }
function salvar() { try { localStorage.setItem(CHAVE, JSON.stringify(S.sessoes)); } catch { toast('Erro ao salvar no celular'); } }
function salvarVinc() { try { localStorage.setItem(CHAVE_VINC, JSON.stringify(S.vinc)); } catch { toast('Erro ao salvar no celular'); } }

const hoje = () => {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const dataCurta = ts => new Date(ts).toLocaleDateString('pt-BR');

const S = {
  tela: 'inicio',
  sessoes: ler(CHAVE),
  vinc: ler(CHAVE_VINC),       // chip ↔ número da fazenda
  atual: null,                 // sessão aberta
  modoNovo: 'individual',
  pesoVivo: null, pesoTs: 0,
  pesoEditado: false,          // lote: operador digitou o peso
  pend: null,                  // animal identificado aguardando registro { chip, numero, origem }
  dup: null,                   // { idx, pend } animal já pesado nesta sessão
  ultimoPeriodoUsado: -1,      // período de peso já usado no último registro
  ultimaLinha: '',
  balancaMsg: '', bastaoMsg: '',
  fazBrincos: '', buscaBrincos: ''
};

const est = new Estabilidade({ tol: 1.0, holdMs: 1500, minKg: 15 });

// ================== Equipamentos ==================
const balanca = new Balanca({
  onPeso: kg => { S.pesoVivo = kg; S.pesoTs = Date.now(); est.update(kg); atualizaPeso(); },
  onEstado: (e, msg) => { S.balancaMsg = msg; atualizaEquip(); }
});

const bastao = new Bastao({
  onLinha: l => { S.ultimaLinha = l; const el = $('ultimaLinha'); if (el) el.textContent = l; },
  onBrinco: linha => { const b = parseBrinco(linha); if (b) chipLido(b, 'bastao'); },
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
  S.tela = 'inicio'; S.atual = null; S.pend = null; S.dup = null;
  if (nativo) KeepAwake.allowSleep().catch(() => {});
  render();
}
function abrirSessao(id) {
  S.atual = S.sessoes.find(s => s.id === id);
  if (!S.atual) return;
  S.tela = 'sessao'; S.pend = null; S.dup = null; S.pesoEditado = false;
  S.ultimoPeriodoUsado = est.inicioPeriodo();
  if (nativo) KeepAwake.keepAwake().catch(() => {});
  render();
  if (balanca.estado === 'desconectado') balanca.autoConectar();
  if (S.atual.modo === 'individual' && bastao.estado === 'desconectado') bastao.autoConectar();
}
function abrirBrincos(fazenda) {
  S.tela = 'brincos';
  S.fazBrincos = fazenda ?? (S.fazBrincos || localStorage.getItem('ult.cliente') || '');
  S.buscaBrincos = '';
  render();
}

// ================== Render ==================
function render() {
  fecharFolha();
  $('app').innerHTML = S.tela === 'inicio' ? telaInicio() : S.tela === 'brincos' ? telaBrincos() : telaSessao();
  if (S.tela === 'sessao') { atualizaEquip(); atualizaPeso(); atualizaIdent(); }
  if (S.tela === 'brincos') atualizaListaBrincos();
}

function clientesConhecidos() {
  const vistos = new Map();
  [...S.sessoes].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm))
    .forEach(s => { const k = chaveFazenda(s.cliente); if (k && !vistos.has(k)) vistos.set(k, s.cliente); });
  return [...vistos.values()];
}

function telaInicio() {
  const abertas = S.sessoes.filter(s => !s.finalizada);
  const lista = [...S.sessoes].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
  const nVinc = S.vinc.filter(v => !v.ate).length;
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
    <input class="txt" id="nCliente" list="lsClientes" placeholder="Ex.: Fazenda Lago Azul" value="${esc(localStorage.getItem('ult.cliente') || '')}">
    <datalist id="lsClientes">${clientesConhecidos().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label class="rot">Lote / Piquete</label>
    <input class="txt" id="nLote" placeholder="Ex.: Lote 3 — Piquete 12">
    <label class="rot">Data</label>
    <input class="txt" id="nData" type="date" value="${hoje()}">
    <label class="rot">Modo</label>
    <div class="modos">
      <button class="modo ${S.modoNovo === 'individual' ? 'on' : ''}" data-acao="modo" data-modo="individual"><b>Individual</b><span>brinco + peso<br>(bastão ou digitado)</span></button>
      <button class="modo ${S.modoNovo === 'lote' ? 'on' : ''}" data-acao="modo" data-modo="lote"><b>Lote</b><span>grupo + quantidade<br>(média)</span></button>
    </div>
    <button class="btn" style="margin-top:14px" data-acao="iniciar">Iniciar pesagem</button>
  </div>

  <button class="dev-opt" data-acao="brincos"><span>Brincos — chip ↔ número da fazenda<small>${nVinc} chip${nVinc === 1 ? '' : 's'} cadastrado${nVinc === 1 ? '' : 's'} · editar e reaproveitar</small></span><span style="color:var(--ouro);font-size:22px">›</span></button>

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

// ---------- Tela Brincos ----------
function telaBrincos() {
  const clientes = clientesConhecidos();
  return `
  <div class="topo">
    <button class="btn-ic" data-acao="voltar">←</button>
    <h1>Brincos<small>chip ↔ número da fazenda</small></h1>
  </div>
  <div class="card">
    <label class="rot" style="margin-top:0">Fazenda</label>
    <input class="txt" id="bFaz" list="lsClientesB" value="${esc(S.fazBrincos)}" placeholder="Cliente / Fazenda">
    <datalist id="lsClientesB">${clientes.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label class="rot">Buscar número ou chip</label>
    <input class="txt mono" id="bBusca" inputmode="numeric" placeholder="Ex.: 1234" value="${esc(S.buscaBrincos)}">
  </div>
  <div class="card">
    <h2 id="bTitulo">Chips cadastrados</h2>
    <div class="lista" id="bLista"></div>
  </div>
  <p class="rodape">O número é pedido na primeira leitura de cada chip.<br><b>Reaproveitar</b> libera o chip para outro animal; pesagens antigas continuam com o número da época.</p>`;
}

function natural(a, b) { return String(a).localeCompare(String(b), 'pt-BR', { numeric: true }); }

function atualizaListaBrincos() {
  const l = $('bLista'); if (!l) return;
  const busca = normNumero(S.buscaBrincos);
  const lista = ativos(S.vinc, S.fazBrincos)
    .filter(v => !busca || v.numero.includes(busca) || v.chip.includes(busca))
    .sort((a, b) => natural(a.numero, b.numero));
  $('bTitulo').textContent = `Chips cadastrados (${lista.length})`;
  l.innerHTML = lista.length ? lista.map(v => `
    <div class="item">
      <div class="meio"><div class="p" style="font-size:17px;color:var(--ouro)">${esc(v.numero)}</div>
        <div class="q mono">${fmtBrinco(v.chip)} · desde ${dataCurta(v.desde)}</div></div>
      <button class="btn sec peq" style="width:auto;padding:9px 12px" data-acao="vincEditar" data-chip="${v.chip}">Editar</button>
      <button class="btn perigo peq" style="width:auto;padding:9px 12px" data-acao="vincLiberar" data-chip="${v.chip}">Reaproveitar</button>
    </div>`).join('') : `<div class="vazio">${S.fazBrincos ? 'Nenhum chip cadastrado nesta fazenda' : 'Escolha a fazenda'}</div>`;
}

// ---------- Tela da sessão ----------
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
    <div class="brinco-box" id="brincoBox">
      <div class="b" id="identNum">—</div>
      <div class="s" id="identSub">Leia o chip com o bastão ou digite abaixo</div>
    </div>
    <div class="stepper-row" style="margin-top:10px">
      <input class="txt mono" id="inIdent" inputmode="numeric" enterkeyhint="go" placeholder="Número do animal ou chip" autocomplete="off">
      <button class="btn sec peq" style="width:auto;padding:0 18px" data-acao="identDigitado">OK</button>
    </div>
    <p class="passo" id="passo" style="margin-top:10px"></p>
    <button class="btn" style="margin-top:8px" id="btnReg" data-acao="registrar">Registrar</button>
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

function descAnimal(a) {
  if (!a) return '';
  return a.numero ? `Nº ${a.numero}` : a.chip ? fmtBrinco(a.chip) : '';
}

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
    al.push(`<div class="alerta aviso"><b>Animal já pesado nesta sessão</b><br>${esc(descAnimal({ numero: r.numero, chip: r.brinco }))} — ${fmt1(r.peso)} kg às ${hora(r.ts)}
      <div class="linha-btn" style="margin-top:9px"><button class="btn peq" data-acao="dupSubst">Substituir pelo peso atual</button><button class="btn sec peq" data-acao="dupManter">Manter peso anterior</button></div></div>`);
  }
  const box = $('alertas'); if (box) box.innerHTML = al.join('');
}

function semSinal() { return !S.pesoTs || Date.now() - S.pesoTs > 8000 || balanca.estado !== 'conectado'; }

function atualizaPeso() {
  if (S.tela !== 'sessao') return;
  const el = $('peso');
  const velho = semSinal();
  if (S.pesoVivo !== null) el.innerHTML = fmt1(S.pesoVivo) + '<span class="un">kg</span>';
  el.classList.toggle('velho', velho);
  const e = $('estab'), ok = !velho && est.estavel();
  e.className = 'estab ' + (ok ? 'sim' : 'nao');
  e.textContent = velho ? 'sem sinal' : ok ? 'ESTÁVEL' : (S.pesoVivo < est.minKg ? 'vazia' : 'estabilizando');
  if (S.atual.modo === 'lote') {
    const inp = $('inPeso');
    if (inp && !S.pesoEditado && S.pesoVivo !== null && document.activeElement !== inp) inp.value = fmt1(S.pesoVivo);
  }
  atualizaPasso();
  atualizaTotais();
}

function atualizaIdent() {
  if (S.tela !== 'sessao' || S.atual.modo !== 'individual') return;
  const box = $('brincoBox'); if (!box) return;
  const p = S.pend;
  box.classList.toggle('lido', !!p);
  if (!p) {
    $('identNum').textContent = '—';
    $('identSub').textContent = 'Leia o chip com o bastão ou digite abaixo';
  } else if (p.numero) {
    $('identNum').textContent = 'Nº ' + p.numero;
    $('identSub').innerHTML = p.chip ? `<span class="mono">${fmtBrinco(p.chip)}</span>` : 'sem chip';
  } else {
    $('identNum').textContent = fmtBrinco(p.chip);
    $('identSub').innerHTML = `chip sem número · <a href="#" data-acao="atribuir" style="color:var(--ouro)">atribuir número</a>`;
  }
  atualizaPasso();
}

function atualizaPasso() {
  if (S.tela !== 'sessao' || S.atual.modo !== 'individual') return;
  const passo = $('passo'), btn = $('btnReg'); if (!passo) return;
  const p = S.pend;
  if (!p) passo.innerHTML = 'Aguardando identificação do animal';
  else if (semSinal()) passo.innerHTML = '<b>Balança sem sinal</b> — conecte a balança';
  else if (!est.estavel()) passo.innerHTML = 'Aguardando o peso <b>estabilizar</b>…';
  else if (est.inicioPeriodo() <= S.ultimoPeriodoUsado) passo.innerHTML = 'Peso ainda é do animal anterior';
  else passo.innerHTML = 'Peso estável — toque em <b>Registrar</b>';
  if (btn) btn.disabled = !p || !(S.pesoVivo > 0) || semSinal();
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
  const sig = s.registros.map(r => r.ts + ':' + r.peso + ':' + (r.numero || '')).join('|');
  if (l.dataset.sig === sig) return;
  l.dataset.sig = sig;
  if (!s.registros.length) { l.innerHTML = '<div class="vazio">Nenhum registro ainda</div>'; return; }
  l.innerHTML = s.registros.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => ind ? `
    <div class="item"><span class="idx">#${i + 1}</span>
      <div class="meio"><div class="p">${r.numero ? 'Nº ' + esc(r.numero) : '<span style="color:var(--sub)">sem número</span>'}</div>
        <div class="q"><span class="mono">${r.brinco ? fmtBrinco(r.brinco) : 'sem chip'}</span> · ${hora(r.ts)}${r.subst ? ' · substituído' : ''}</div></div>
      <span class="val">${fmt1(r.peso)} kg</span><button class="x" data-acao="apagar" data-i="${i}">✕</button></div>` : `
    <div class="item"><span class="idx">#${i + 1}</span>
      <div class="meio"><div class="p">${r.qtd} an · ${fmt1(r.peso)} kg</div><div class="q">${hora(r.ts)}</div></div>
      <span class="val">${fmt1(r.peso / r.qtd)}</span><button class="x" data-acao="apagar" data-i="${i}">✕</button></div>`).join('');
}

// ================== Identificação do animal ==================
function identificar(pend) {
  const regs = S.atual.registros;
  // mesmo animal = mesmo chip, ou mesmo número da fazenda
  const idx = regs.findIndex(r =>
    (pend.chip && r.brinco === pend.chip) ||
    (pend.numero && r.numero && normNumero(r.numero) === normNumero(pend.numero)));
  if (idx >= 0) {
    S.pend = null; S.dup = { idx, pend };
    bip(500, 300); vibra(400);
  } else {
    S.pend = pend; S.dup = null;
    bip(900, 80); vibra(80);
  }
  atualizaEquip(); atualizaIdent();
}

function chipLido(chip, origem) {
  if (S.tela !== 'sessao' || S.atual.modo !== 'individual') {
    if (S.tela !== 'sessao') toast('Chip lido: ' + fmtBrinco(chip));
    return;
  }
  if (S.pend?.chip === chip || S.dup?.pend.chip === chip) return;           // releitura
  const ult = S.atual.registros.at(-1);
  if (ult?.brinco === chip && est.inicioPeriodo() <= S.ultimoPeriodoUsado) return; // ainda na balança
  const numero = numeroDoChip(S.vinc, S.atual.cliente, chip);
  if (numero) { identificar({ chip, numero, origem }); return; }
  // chip novo nesta fazenda: pede o número
  identificar({ chip, numero: '', origem });
  if (S.pend) folhaNumero(chip);
}

function identDigitado() {
  const inp = $('inIdent'); const v = inp.value.trim();
  if (!v) return toast('Digite o número do animal ou do chip');
  inp.value = ''; inp.blur();
  const limpo = v.replace(/[\s-]/g, '');
  if (ehChip(limpo)) { chipLido(limpo, 'digitado'); return; }
  const numero = normNumero(v);
  const chip = chipDoNumero(S.vinc, S.atual.cliente, numero);
  identificar({ chip: chip || '', numero, origem: 'digitado' });
}

// Pede/edita o número da fazenda para um chip
function folhaNumero(chip, { editar = false } = {}) {
  const atual = numeroDoChip(S.vinc, editar ? S.fazBrincos : S.atual.cliente, chip) || '';
  abrirFolha(`
    <h3>${editar ? 'Editar número' : 'Chip novo nesta fazenda'}</h3>
    <p>Chip <span class="mono">${fmtBrinco(chip)}</span>${editar ? '' : ' ainda não tem número cadastrado.'}</p>
    <label class="rot" style="margin:0">Número do animal na fazenda</label>
    <input class="grande" id="fNumero" inputmode="numeric" enterkeyhint="done" value="${esc(atual)}" autocomplete="off">
    <div id="fConflito"></div>
    <button class="btn" data-acao="numSalvar" data-chip="${chip}" data-editar="${editar ? 1 : ''}">Salvar</button>
    <button class="btn sec peq" data-acao="fechar">${editar ? 'Cancelar' : 'Pular (pesar sem número)'}</button>`);
  setTimeout(() => $('fNumero')?.focus(), 150);
}

function salvarNumero(chip, editar, mover = false) {
  const numero = normNumero($('fNumero').value);
  if (!numero) return toast('Digite o número');
  const fazenda = editar ? S.fazBrincos : S.atual.cliente;
  let r = vincular(S.vinc, fazenda, chip, numero);
  if (!r.ok && r.conflito && mover) {
    S.vinc = liberarChip(S.vinc, fazenda, r.conflito.chip);
    r = vincular(S.vinc, fazenda, chip, numero);
  }
  if (!r.ok) {
    if (r.conflito) {
      $('fConflito').innerHTML = `<div class="alerta aviso">O número <b>${esc(numero)}</b> já está no chip <span class="mono">${fmtBrinco(r.conflito.chip)}</span>.
        <div class="linha-btn" style="margin-top:9px"><button class="btn peq" data-acao="numMover" data-chip="${chip}" data-editar="${editar ? 1 : ''}">Passar o número para este chip</button></div>
        <p style="margin-top:6px;font-size:12px">O chip antigo fica livre (como reaproveitado).</p></div>`;
      return;
    }
    return toast(r.erro || 'Não salvou');
  }
  S.vinc = r.vinc; salvarVinc();
  fecharFolha();
  toast(`Chip ${fmtBrinco(chip).slice(-6)} = Nº ${numero}`);
  if (editar) { atualizaListaBrincos(); return; }
  if (S.pend?.chip === chip) { S.pend.numero = numero; identificar(S.pend); }
}

// ================== Registro ==================
function registrar() {
  const p = S.pend;
  if (!p) return toast('Identifique o animal primeiro');
  if (!(S.pesoVivo > 0) || semSinal()) return toast('Sem peso da balança');
  if (!est.estavel() && !confirm('O peso ainda não estabilizou. Registrar mesmo assim?')) return;
  if (est.inicioPeriodo() <= S.ultimoPeriodoUsado &&
      !confirm('Esse peso é o mesmo do registro anterior (o animal anterior pode não ter saído). Registrar mesmo assim?')) return;
  const peso = Math.round(S.pesoVivo * 10) / 10;
  S.atual.registros.push({ brinco: p.chip || '', numero: p.numero || '', peso, ts: Date.now(), manual: p.origem === 'digitado' });
  S.ultimoPeriodoUsado = est.inicioPeriodo();
  S.pend = null;
  salvar();
  bip(1400, 150); vibra(250);
  const c = $('pesoCard'); if (c) { c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }
  toast(`✔ ${descAnimal(p)} — ${fmt1(peso)} kg`);
  atualizaIdent(); atualizaTotais();
}

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
      <div class="tot"><div class="n">${ind ? fmt0(st.min) + '–' + fmt0(st.max) : st.registros}</div><div class="l">${ind ? 'Mín–Máx kg' : 'Pesagens'}</div></div>
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
  brincos: () => abrirBrincos(),
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
  // individual
  identDigitado: () => identDigitado(),
  atribuir: () => { if (S.pend?.chip) folhaNumero(S.pend.chip); },
  numSalvar: el => salvarNumero(el.dataset.chip, !!el.dataset.editar),
  numMover: el => salvarNumero(el.dataset.chip, !!el.dataset.editar, true),
  registrar: () => registrar(),
  dupSubst: () => {
    const r = S.atual.registros[S.dup.idx];
    if (!(S.pesoVivo > 0) || semSinal()) return toast('Sem peso da balança');
    if (!est.estavel() && !confirm('O peso ainda não estabilizou. Substituir mesmo assim?')) return;
    r.peso = Math.round(S.pesoVivo * 10) / 10; r.ts = Date.now(); r.subst = true;
    if (!r.numero && S.dup.pend.numero) r.numero = S.dup.pend.numero;
    S.ultimoPeriodoUsado = est.inicioPeriodo();
    S.dup = null; salvar(); bip(1400, 150); vibra(250);
    toast(`✔ ${descAnimal({ numero: r.numero, chip: r.brinco })} atualizado — ${fmt1(r.peso)} kg`);
    atualizaEquip(); atualizaTotais();
  },
  dupManter: () => { S.dup = null; toast('Peso anterior mantido'); atualizaEquip(); atualizaIdent(); },
  // brincos
  vincEditar: el => folhaNumero(el.dataset.chip, { editar: true }),
  vincLiberar: el => {
    const n = numeroDoChip(S.vinc, S.fazBrincos, el.dataset.chip);
    if (!confirm(`Reaproveitar o chip do Nº ${n}?\n\nO chip fica livre e, na próxima leitura, o app pede o número do novo animal. As pesagens antigas continuam com o Nº ${n}.`)) return;
    S.vinc = liberarChip(S.vinc, S.fazBrincos, el.dataset.chip); salvarVinc();
    toast('Chip liberado para reaproveitar'); atualizaListaBrincos();
  },
  // lote
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
  apagar: el => {
    const i = +el.dataset.i, r = S.atual.registros[i];
    const desc = S.atual.modo === 'lote' ? `${r.qtd} animais / ${fmt1(r.peso)} kg` : `${descAnimal({ numero: r.numero, chip: r.brinco })} / ${fmt1(r.peso)} kg`;
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
  if (el.tagName === 'A') e.preventDefault();
  const fn = acoes[el.dataset.acao];
  if (fn) fn(el);
});
document.addEventListener('input', e => {
  if (e.target.id === 'inPeso') S.pesoEditado = e.target.value.trim() !== '';
  if (e.target.id === 'bFaz') { S.fazBrincos = e.target.value; atualizaListaBrincos(); }
  if (e.target.id === 'bBusca') { S.buscaBrincos = e.target.value; atualizaListaBrincos(); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'inIdent') { e.preventDefault(); identDigitado(); }
  if (e.target.id === 'fNumero') { e.preventDefault(); document.querySelector('[data-acao=numSalvar]')?.click(); }
});

setInterval(() => { if (S.tela === 'sessao') atualizaPeso(); }, 300);

// Botão "voltar" do Android: fecha a folha ou volta ao início
if (nativo) {
  import('@capacitor/app').then(({ App }) => {
    App.addListener('backButton', () => {
      if ($('sheet').classList.contains('on')) fecharFolha();
      else if (S.tela !== 'inicio') irInicio();
      else App.minimizeApp();
    });
  }).catch(() => {});
}

// Simulação para testes no navegador (?sim): não afeta o app no celular
if (!nativo && new URLSearchParams(location.search).has('sim')) {
  window.__sim = {
    peso: kg => { balanca.estado = 'conectado'; balanca.id = 'sim'; balanca.onPeso(kg); atualizaEquip(); },
    brinco: linha => { bastao.estado = 'conectado'; bastao.endereco = 'sim'; bastao.split.push(linha + '\r\n'); atualizaEquip(); },
    estado: () => S
  };
}

render();
