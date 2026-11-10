package br.com.pastoverde.pesagem;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // plugin próprio do bastão SRS2 (Bluetooth clássico)
        registerPlugin(BtSerialPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
