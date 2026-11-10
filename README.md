# Pesagem PV

App Android de pesagem de gado da Pasto Verde Consultoria, independente do PV Pro.

- **Balança Tru-Test S3** via Bluetooth LE (serviço Weight Scale `0x181D`, peso = uint16LE(bytes 1–2) × 0,05 kg)
- **Bastão Tru-Test SRS2** via Bluetooth clássico (SPP), brinco ISO `982 000445531509`
- Pesagem **individual** (brinco + peso, registro automático com peso estável) e em **lote** (peso + quantidade)
- Sessões salvas no celular, relatório **PDF** e planilha **CSV** compartilháveis

## Instalar

Baixe `pesagem-pv.apk` em **Releases → Latest** pelo celular e toque no arquivo.
Link direto: https://github.com/pastoverdeconsultoria/Pesagem-X3/releases/latest/download/pesagem-pv.apk

## Compilação

Cada push no `main` roda o workflow `Gerar APK` (testes → build web → Capacitor → Gradle) e publica uma release.
A chave de assinatura fixa (`android/app/pesagem.keystore`) permite atualizar por cima sem perder os dados.

## Estrutura

- `src/logic.js` — decodificação da balança, leitura do brinco, estabilidade, estatísticas, CSV (testado em `tests/`)
- `src/devices.js` — conexão BLE (balança) e SPP (bastão), reconexão automática
- `src/report.js` — relatório PDF (jsPDF)
- `src/main.js` — interface
- `android/app/src/main/java/br/com/pastoverde/pesagem/BtSerialPlugin.java` — plugin nativo do bastão
