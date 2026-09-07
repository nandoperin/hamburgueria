package com.pointburger.printer;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.net.Uri;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

public class MainActivity extends Activity {
    private final List<String> addresses = new ArrayList<>();
    private Spinner printers;
    private EditText code;
    private TextView status;
    private SecureStore store;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        store = new SecureStore(this);
        buildUi();
        requestPermissionsIfNeeded();
        loadPrinters();
        updateStatus();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(32), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("Point Burger\nImpressora");
        title.setTextSize(28);
        root.addView(title);

        TextView explanation = new TextView(this);
        explanation.setText("Este app acessa somente a fila de impressão. Não acessa contatos, fotos, câmera ou microfone.");
        explanation.setTextSize(16);
        explanation.setPadding(0, dp(16), 0, dp(18));
        root.addView(explanation);

        code = new EditText(this);
        code.setHint("Código de 8 dígitos");
        code.setInputType(InputType.TYPE_CLASS_NUMBER);
        root.addView(code);

        Button pair = new Button(this);
        pair.setText("Vincular este celular");
        pair.setOnClickListener(v -> pair());
        root.addView(pair);

        printers = new Spinner(this);
        root.addView(printers);

        Button refresh = new Button(this);
        refresh.setText("Atualizar impressoras Bluetooth");
        refresh.setOnClickListener(v -> loadPrinters());
        root.addView(refresh);

        Button start = new Button(this);
        start.setText("Iniciar impressão automática");
        start.setOnClickListener(v -> startPrinting());
        root.addView(start);

        Button test = new Button(this);
        test.setText("Imprimir teste pelo Point Burger");
        test.setOnClickListener(v -> testPrinter());
        root.addView(test);

        Button stop = new Button(this);
        stop.setText("Parar neste celular");
        stop.setOnClickListener(v -> stopPrinting());
        root.addView(stop);

        status = new TextView(this);
        status.setTextSize(16);
        status.setPadding(0, dp(20), 0, 0);
        root.addView(status);
        setContentView(root);
    }

    private void requestPermissionsIfNeeded() {
        List<String> wanted = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            wanted.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
            wanted.add(Manifest.permission.BLUETOOTH_SCAN);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            wanted.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!wanted.isEmpty()) requestPermissions(wanted.toArray(new String[0]), 10);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        loadPrinters();
    }

    private boolean canUseBluetooth() {
        return Build.VERSION.SDK_INT < 31 || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void loadPrinters() {
        if (!canUseBluetooth()) { status.setText("Autorize Dispositivos próximos para localizar a impressora."); return; }
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        List<String> names = new ArrayList<>();
        addresses.clear();
        if (adapter != null) {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            for (BluetoothDevice device : bonded) {
                names.add((device.getName() == null ? "Impressora Bluetooth" : device.getName()) + " — " + device.getAddress());
                addresses.add(device.getAddress());
            }
        }
        printers.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names));
        String saved = store.printer();
        if (saved != null && addresses.contains(saved)) printers.setSelection(addresses.indexOf(saved));
        if (names.isEmpty()) status.setText("Nenhuma impressora pareada. Pareie a Volcora no RawBT e volte aqui.");
    }

    private void pair() {
        String value = code.getText().toString().trim();
        if (!value.matches("\\d{8}")) { status.setText("Digite o código de 8 dígitos enviado pelo administrador."); return; }
        status.setText("Vinculando...");
        new Thread(() -> {
            try {
                JSONObject result = ApiClient.pair(value);
                store.saveToken(result.getString("token"));
                runOnUiThread(() -> { code.setText(""); status.setText("Celular vinculado com segurança."); updateStatus(); });
            } catch (Exception e) {
                runOnUiThread(() -> status.setText("Código inválido, expirado ou conexão indisponível."));
            }
        }).start();
    }

    private void startPrinting() {
        if (store.token() == null) { status.setText("Vincule este celular primeiro."); return; }
        int selected = printers.getSelectedItemPosition();
        if (selected < 0 || selected >= addresses.size()) { status.setText("Selecione a Volcora."); return; }
        store.savePrinter(addresses.get(selected));
        store.setEnabled(true);
        requestBackgroundAccess();
        Intent intent = new Intent(this, PrinterService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        updateStatus();
    }

    private void requestBackgroundAccess() {
        if (Build.VERSION.SDK_INT < 23) return;
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null && !power.isIgnoringBatteryOptimizations(getPackageName())) {
            try {
                Intent request = new Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName()));
                startActivity(request);
            } catch (Exception ignored) {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            }
        }
    }

    private void testPrinter() {
        int selected = printers.getSelectedItemPosition();
        if (selected < 0 || selected >= addresses.size()) { status.setText("Selecione a Volcora."); return; }
        store.savePrinter(addresses.get(selected));
        Intent intent = new Intent(this, PrinterService.class).setAction(PrinterService.ACTION_TEST);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        status.setText("Teste enviado para a Volcora.");
    }

    private void stopPrinting() {
        store.setEnabled(false);
        stopService(new Intent(this, PrinterService.class));
        updateStatus();
    }

    private void updateStatus() {
        boolean paired = store.token() != null;
        status.setText("Celular: " + (paired ? "vinculado" : "não vinculado") +
                "\nImpressão automática: " + (store.enabled() ? "ATIVA" : "parada") +
                "\nMantenha o celular carregando e conectado à internet.");
    }
}
