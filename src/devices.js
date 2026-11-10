// Conexão com os equipamentos: balança S3 (BLE) e bastão SRS2 (Bluetooth clássico).
import { registerPlugin } from '@capacitor/core';
import { BleClient, numberToUUID } from '@capacitor-community/bluetooth-le';
import { decodeS3, LineSplitter } from './logic.js';

const SVC_PESO = numberToUUID(0x181d);   // Weight Scale
const CHR_PESO = numberToUUID(0x2a9d);   // Weight Measurement (indicate)

const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem storage */ } }
};

// ================= Balança S3 =================
export class Balanca {
  constructor({ onPeso, onEstado }) {
    this.onPeso = onPeso; this.onEstado = onEstado;
    this.id = ls.get('balanca.id'); this.nome = ls.get('balanca.nome') || 'S3';
    this.iniciado = false; this.manual = false; this.timer = null;
    this.estado = 'desconectado';
  }
  _set(estado, msg = '') { this.estado = estado; this.onEstado?.(estado, msg); }

  async _init() {
    if (this.iniciado) return;
    await BleClient.initialize({ androidNeverForLocation: true });
    this.iniciado = true;
  }

  // Abre a lista de balanças do Android para escolher
  async procurar() {
    await this._init();
    const dev = await BleClient.requestDevice({ namePrefix: 'S3', optionalServices: [SVC_PESO] });
    this.id = dev.deviceId; this.nome = dev.name || 'S3';
    ls.set('balanca.id', this.id); ls.set('balanca.nome', this.nome);
    await this.conectar();
  }

  async conectar() {
    if (!this.id) throw new Error('Nenhuma balança escolhida');
    await this._init();
    this.manual = false;
    clearTimeout(this.timer);
    this._set('conectando');
    try {
      await BleClient.connect(this.id, () => this._caiu(), { timeout: 10000 });
      await BleClient.startNotifications(this.id, SVC_PESO, CHR_PESO, dv => {
        const kg = decodeS3(dv);
        if (kg !== null) this.onPeso(kg);
      });
      this._set('conectado');
    } catch (e) {
      try { await BleClient.disconnect(this.id); } catch { /* ignore */ }
      this._set('erro', e?.message || String(e));
      this._tentarDeNovo();
      throw e;
    }
  }

  _caiu() {
    if (this.manual) return;
    this._set('desconectado', 'Conexão perdida — reconectando…');
    this._tentarDeNovo();
  }

  _tentarDeNovo() {
    if (this.manual || !this.id) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.conectar().catch(() => {}); }, 5000);
  }

  async desconectar() {
    this.manual = true;
    clearTimeout(this.timer);
    if (this.id) { try { await BleClient.disconnect(this.id); } catch { /* ignore */ } }
    this._set('desconectado');
  }

  async autoConectar() {
    if (this.id) { try { await this.conectar(); } catch { /* reconexão já agendada */ } }
  }
}

// ================= Bastão SRS2 =================
// Plugin nativo próprio (android/app/src/main/java/.../BtSerialPlugin.java)
export const BtSerial = registerPlugin('BtSerial');

export class Bastao {
  constructor({ onBrinco, onLinha, onEstado }) {
    this.onBrinco = onBrinco; this.onLinha = onLinha; this.onEstado = onEstado;
    this.endereco = ls.get('bastao.end'); this.nome = ls.get('bastao.nome') || 'Bastão';
    this.manual = false; this.timer = null; this.estado = 'desconectado';
    this.ocupado = false; this.flushTimer = null;
    this.split = new LineSplitter(linha => {
      this.onLinha?.(linha);
      this.onBrinco?.(linha);
    });
    this._ouvintes = false;
  }
  _set(estado, msg = '') { this.estado = estado; this.onEstado?.(estado, msg); }

  async _ouvir() {
    if (this._ouvintes) return;
    this._ouvintes = true;
    await BtSerial.addListener('data', ({ chunk }) => {
      this.split.push(chunk || '');
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.split.flush(), 300);
    });
    await BtSerial.addListener('state', ({ connected, message }) => {
      if (connected) { this._set('conectado'); return; }
      if (this.manual) { this._set('desconectado'); return; }
      this._set('desconectado', message || 'Conexão perdida — reconectando…');
      this._tentarDeNovo();
    });
  }

  async pareados() {
    const { devices } = await BtSerial.listPaired();
    return devices || [];
  }

  async escolher(dev) {
    this.endereco = dev.address; this.nome = dev.name || dev.address;
    ls.set('bastao.end', this.endereco); ls.set('bastao.nome', this.nome);
    await this.conectar();
  }

  async conectar() {
    if (!this.endereco) throw new Error('Nenhum bastão escolhido');
    if (this.ocupado) return;
    await this._ouvir();
    this.manual = false; this.ocupado = true;
    clearTimeout(this.timer);
    this._set('conectando');
    try {
      await BtSerial.connect({ address: this.endereco });
      this._set('conectado');
    } catch (e) {
      this._set('erro',
        'Não conectou. Confira se o bastão está ligado e se não está conectado em outro aparelho (celular, balança ou Data Link).');
      this._tentarDeNovo(10000);
      throw e;
    } finally {
      this.ocupado = false;
    }
  }

  _tentarDeNovo(ms = 5000) {
    if (this.manual || !this.endereco) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.conectar().catch(() => {}); }, ms);
  }

  async desconectar() {
    this.manual = true;
    clearTimeout(this.timer);
    try { await BtSerial.disconnect(); } catch { /* ignore */ }
    this._set('desconectado');
  }

  async abrirBluetoothAndroid() {
    try { await BtSerial.openSettings(); } catch { /* ignore */ }
  }

  async autoConectar() {
    if (this.endereco) { try { await this.conectar(); } catch { /* reconexão agendada */ } }
  }
}
