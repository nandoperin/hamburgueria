package com.pointburger.printer;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PrinterService extends Service {
    static final String ACTION_TEST = "com.pointburger.printer.TEST";
    private static final String CHANNEL = "pointburger_print";
    private static final int NOTIFICATION_ID = 2107;
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean running;
    private SecureStore store;

    @Override public void onCreate() {
        super.onCreate();
        store = new SecureStore(this);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Impressão de comandas", NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification("Conectando à fila..."));
        if (intent != null && ACTION_TEST.equals(intent.getAction())) {
            worker.execute(() -> {
                try {
                    String printer = store.printer();
                    if (printer == null) throw new IllegalStateException("Impressora não selecionada");
                    byte[] page = ("\u001b@==========================================\n" +
                            "          POINT BURGER - TESTE\n" +
                            "==========================================\n" +
                            "Android conectado por Bluetooth.\n" +
                            "Fila segura pronta para comandas.\n\n\n\u001dV\u0000")
                            .getBytes(StandardCharsets.ISO_8859_1);
                    print(printer, page);
                    show("Teste impresso com sucesso");
                } catch (Exception e) {
                    show("Falha no teste — confira o Bluetooth");
                } finally {
                    stopSelf();
                }
            });
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            worker.execute(this::loop);
        }
        return START_STICKY;
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("Point Burger — Impressora")
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    private void show(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
    }

    private void loop() {
        while (running && store.enabled()) {
            String token = store.token();
            String printer = store.printer();
            if (token == null || printer == null) { show("Vinculação ou impressora ausente"); break; }
            JSONObject job = null;
            try {
                job = ApiClient.next(token);
                if (!job.optBoolean("jobReady", false)) {
                    show("Conectada — aguardando pedidos");
                } else {
                    String jobId = job.getString("jobId");
                    String lease = job.getString("leaseToken");
                    byte[] content = ApiClient.checkedContent(job);
                    show("Imprimindo pedido #" + jobId);
                    print(printer, content);
                    ApiClient.complete(token, jobId, lease);
                    show("Pedido #" + jobId + " impresso");
                }
            } catch (ApiClient.ApiException e) {
                if (e.status == 401) {
                    store.clearToken();
                    store.setEnabled(false);
                    show("Acesso revogado — vincule novamente");
                    break;
                }
                release(job, token);
                show("Servidor indisponível — tentando novamente");
            } catch (Exception e) {
                release(job, token);
                show("Impressora desconectada — tentando novamente");
            }
            try { Thread.sleep(5_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        running = false;
        stopSelf();
    }

    private void release(JSONObject job, String token) {
        if (job == null || !job.optBoolean("jobReady", false) || token == null) return;
        ApiClient.fail(token, job.optString("jobId"), job.optString("leaseToken"));
    }

    private void print(String address, byte[] content) throws Exception {
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Bluetooth não autorizado");
        }
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) throw new IllegalStateException("Bluetooth desligado");
        adapter.cancelDiscovery();
        BluetoothDevice device = adapter.getRemoteDevice(address);
        try (BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP)) {
            socket.connect();
            try (OutputStream out = socket.getOutputStream()) {
                out.write(content);
                out.flush();
                Thread.sleep(700);
            }
        }
    }

    @Override public void onDestroy() {
        running = false;
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
