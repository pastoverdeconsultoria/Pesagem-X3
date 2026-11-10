package br.com.pastoverde.pesagem;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;

/**
 * Bluetooth clássico (SPP / RFCOMM) para o bastão Tru-Test SRS2.
 * O bastão envia cada brinco lido como texto, ex.: "982 000445531509\r\n".
 * Eventos para o JS: "data" { chunk } e "state" { connected, message }.
 */
@CapacitorPlugin(
    name = "BtSerial",
    permissions = { @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "connect") }
)
public class BtSerialPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private volatile BluetoothSocket socket;
    private volatile int geracao = 0;
    private volatile boolean fechandoManual = false;

    // ---------- utilidades ----------
    private BluetoothAdapter adaptador() {
        BluetoothManager m = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private boolean precisaPermissao() {
        return Build.VERSION.SDK_INT >= 31 && getPermissionState("connect") != PermissionState.GRANTED;
    }

    private static void fecharSilencioso(BluetoothSocket s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) { }
    }

    private void emitirEstado(boolean conectado, String msg) {
        JSObject o = new JSObject();
        o.put("connected", conectado);
        o.put("message", msg);
        notifyListeners("state", o);
    }

    // ---------- listar pareados ----------
    @PluginMethod
    public void listPaired(PluginCall call) {
        if (precisaPermissao()) { requestPermissionForAlias("connect", call, "listarAposPermissao"); return; }
        listar(call);
    }

    @PermissionCallback
    private void listarAposPermissao(PluginCall call) {
        if (precisaPermissao()) { call.reject("Permissão de Bluetooth negada. Libere em Configurações > Apps > Pesagem PV > Permissões."); return; }
        listar(call);
    }

    @SuppressLint("MissingPermission")
    private void listar(PluginCall call) {
        BluetoothAdapter a = adaptador();
        if (a == null) { call.reject("Este celular não tem Bluetooth"); return; }
        if (!a.isEnabled()) { call.reject("Bluetooth do celular está desligado"); return; }
        JSArray lista = new JSArray();
        try {
            Set<BluetoothDevice> pareados = a.getBondedDevices();
            if (pareados != null) {
                for (BluetoothDevice d : pareados) {
                    JSObject o = new JSObject();
                    String nome = d.getName();
                    o.put("name", nome == null ? d.getAddress() : nome);
                    o.put("address", d.getAddress());
                    o.put("type", d.getType());
                    lista.put(o);
                }
            }
        } catch (SecurityException e) {
            call.reject("Sem permissão de Bluetooth");
            return;
        }
        JSObject r = new JSObject();
        r.put("devices", lista);
        call.resolve(r);
    }

    // ---------- conectar ----------
    @PluginMethod
    public void connect(PluginCall call) {
        if (call.getString("address") == null) { call.reject("Endereço do bastão não informado"); return; }
        if (precisaPermissao()) { requestPermissionForAlias("connect", call, "conectarAposPermissao"); return; }
        conectar(call);
    }

    @PermissionCallback
    private void conectarAposPermissao(PluginCall call) {
        if (precisaPermissao()) { call.reject("Permissão de Bluetooth negada"); return; }
        conectar(call);
    }

    @SuppressLint("MissingPermission")
    private void conectar(final PluginCall call) {
        final String endereco = call.getString("address");
        new Thread(() -> {
            // encerra conexão anterior sem avisar "perdida"
            final int minhaGeracao;
            synchronized (BtSerialPlugin.this) {
                geracao++;
                minhaGeracao = geracao;
                fecharSilencioso(socket);
                socket = null;
            }

            BluetoothAdapter a = adaptador();
            if (a == null || !a.isEnabled()) { call.reject("Bluetooth do celular está desligado"); return; }
            try { a.cancelDiscovery(); } catch (SecurityException ignored) { }

            BluetoothDevice dev;
            try { dev = a.getRemoteDevice(endereco); }
            catch (IllegalArgumentException e) { call.reject("Endereço inválido"); return; }

            BluetoothSocket s = null;
            String erro = "";
            // 1) conexão segura padrão SPP
            try {
                s = dev.createRfcommSocketToServiceRecord(SPP_UUID);
                s.connect();
            } catch (IOException | SecurityException e1) {
                erro = String.valueOf(e1.getMessage());
                fecharSilencioso(s);
                s = null;
            }
            // 2) conexão sem criptografia
            if (s == null) {
                try {
                    s = dev.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                    s.connect();
                } catch (IOException | SecurityException e2) {
                    fecharSilencioso(s);
                    s = null;
                }
            }
            // 3) canal 1 direto (contorna aparelhos com SDP problemático)
            if (s == null) {
                try {
                    Method m = dev.getClass().getMethod("createRfcommSocket", int.class);
                    s = (BluetoothSocket) m.invoke(dev, 1);
                    if (s != null) s.connect();
                } catch (Exception e3) {
                    fecharSilencioso(s);
                    s = null;
                }
            }

            if (s == null) { call.reject("Não conectou ao bastão: " + erro); return; }

            synchronized (BtSerialPlugin.this) {
                if (minhaGeracao != geracao) { fecharSilencioso(s); call.reject("Conexão substituída"); return; }
                socket = s;
                fechandoManual = false;
            }
            iniciarLeitura(s, minhaGeracao);
            JSObject r = new JSObject();
            r.put("connected", true);
            call.resolve(r);
            emitirEstado(true, "Conectado");
        }).start();
    }

    private void iniciarLeitura(final BluetoothSocket s, final int minhaGeracao) {
        new Thread(() -> {
            byte[] buf = new byte[512];
            try {
                InputStream in = s.getInputStream();
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (n <= 0) continue;
                    JSObject o = new JSObject();
                    o.put("chunk", new String(buf, 0, n, StandardCharsets.ISO_8859_1));
                    notifyListeners("data", o);
                }
            } catch (IOException ignored) { }
            boolean avisar;
            synchronized (BtSerialPlugin.this) {
                avisar = (minhaGeracao == geracao) && !fechandoManual;
                if (minhaGeracao == geracao) { fecharSilencioso(socket); socket = null; }
            }
            if (avisar) emitirEstado(false, "Conexão com o bastão perdida — reconectando…");
        }).start();
    }

    // ---------- desconectar / estado ----------
    @PluginMethod
    public void disconnect(PluginCall call) {
        synchronized (this) {
            fechandoManual = true;
            geracao++;
            fecharSilencioso(socket);
            socket = null;
        }
        call.resolve();
        emitirEstado(false, "Desconectado");
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        BluetoothSocket s = socket;
        JSObject r = new JSObject();
        r.put("connected", s != null && s.isConnected());
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_BLUETOOTH_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Não abriu as configurações de Bluetooth");
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) {
            fechandoManual = true;
            geracao++;
            fecharSilencioso(socket);
            socket = null;
        }
    }
}
