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
import android.os.PowerManager;

import org.json.JSONObject;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public class PrinterService extends Service {
    static final String ACTION_TEST = "com.pointburger.printer.TEST";
    private static final String CHANNEL = "pointburger_print";
    private static final int NOTIFICATION_ID = 2107;
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final LinkedBlockingQueue<String> signals = new LinkedBlockingQueue<>(10);
    private volatile boolean running;
    private SecureStore store;
    private PowerManager.WakeLock wakeLock;
    private OkHttpClient socketClient;
    private volatile WebSocket webSocket;
    private int reconnectAttempt;

    @Override public void onCreate() {
        super.onCreate();
        store = new SecureStore(this);
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                    "PointBurger:PrinterRealtime");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Impressão de comandas", NotificationManager.IMPORTANCE_LOW));
        socketClient = new OkHttpClient.Builder()
                .pingInterval(45, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification("Conectando à fila..."));
        if (intent != null && ACTION_TEST.equals(intent.getAction())) {
            if (running) {
                signals.offer("TEST");
                show("Teste aguardando a conexão Bluetooth");
                return START_STICKY;
            }
            worker.execute(() -> {
                try {
                    printTestPage();
                } catch (Exception e) {
                    show("Falha no teste — confira o Bluetooth");
                } finally {
                    if (store.enabled()) {
                        running = true;
                        worker.execute(this::loop);
                    } else {
                        stopSelf();
                    }
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
        String token = store.token();
        String printer = store.printer();
        if (token == null || printer == null) {
            show("Vinculação ou impressora ausente");
            running = false;
            stopSelf();
            return;
        }
        connectSocket(token);

        while (running && store.enabled()) {
            try {
                // O tempo limite é só uma garantia: ao reconectar ou a cada 15
                // minutos, confere se um aviso se perdeu. Não há polling curto.
                String signal = signals.poll(15, TimeUnit.MINUTES);
                if ("TEST".equals(signal)) {
                    try {
                        printTestPage();
                    } catch (Exception e) {
                        show("Falha no teste — impressão automática continua ativa");
                    }
                    continue;
                }
                if ("RECONNECT".equals(signal)) {
                    long delay = Math.min(30_000L, 1_000L << Math.min(reconnectAttempt++, 5));
                    Thread.sleep(delay);
                    if (running && store.enabled()) connectSocket(token);
                    continue;
                }
                drainQueue(token, printer);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        running = false;
        closeSocket();
        stopSelf();
    }

    private void connectSocket(String token) {
        closeSocket();
        Request request = new Request.Builder()
                .url("wss://bot.pointburgerjg.com/printer-agent/events")
                .header("Authorization", "Bearer " + token)
                .build();
        webSocket = socketClient.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                if (webSocket != socket) {
                    socket.cancel();
                    return;
                }
                reconnectAttempt = 0;
                show("Conectada em tempo real — aguardando pedidos");
                signals.offer("DRAIN");
            }

            @Override public void onMessage(WebSocket socket, String text) {
                if (webSocket == socket && text.length() <= 1024 && text.contains("\"print\"")) {
                    signals.offer("DRAIN");
                }
            }

            @Override public void onClosed(WebSocket socket, int code, String reason) {
                if (webSocket == socket && running && store.enabled()) signals.offer("RECONNECT");
            }

            @Override public void onFailure(WebSocket socket, Throwable error, Response response) {
                int status = response == null ? 0 : response.code();
                if (response != null) response.close();
                if (webSocket != socket) return;
                if (status == 401) {
                    store.clearToken();
                    store.setEnabled(false);
                    running = false;
                    show("Acesso revogado — vincule novamente");
                    signals.offer("STOP");
                    return;
                }
                if (running && store.enabled()) {
                    show("Conexão caiu — reconectando automaticamente");
                    signals.offer("RECONNECT");
                }
            }
        });
    }

    private void drainQueue(String token, String printer) {
        while (running && store.enabled()) {
            JSONObject job = null;
            try {
                job = ApiClient.next(token);
                if (!job.optBoolean("jobReady", false)) {
                    show("Conectada em tempo real — aguardando pedidos");
                    return;
                }
                String jobId = job.getString("jobId");
                String lease = job.getString("leaseToken");
                byte[] content = ApiClient.checkedContent(job);
                show("Imprimindo pedido #" + jobId);
                print(printer, content);
                ApiClient.complete(token, jobId, lease);
                show("Pedido #" + jobId + " impresso");
            } catch (ApiClient.ApiException e) {
                release(job, token);
                if (e.status == 401) {
                    store.clearToken();
                    store.setEnabled(false);
                    running = false;
                    show("Acesso revogado — vincule novamente");
                    return;
                }
                show("Servidor indisponível — nova tentativa em instantes");
                try {
                    Thread.sleep(15_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                signals.offer("DRAIN");
                return;
            } catch (Exception e) {
                release(job, token);
                show("Impressora desconectada — nova tentativa em instantes");
                try {
                    Thread.sleep(15_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                signals.offer("DRAIN");
                return;
            }
        }
    }

    private void closeSocket() {
        WebSocket socket = webSocket;
        webSocket = null;
        if (socket != null) socket.cancel();
    }

    private void printTestPage() throws Exception {
        String printer = store.printer();
        if (printer == null) throw new IllegalStateException("Impressora não selecionada");
        byte[] page = ("\u001b@==========================================\n" +
                "          POINT BURGER - TESTE\n" +
                "==========================================\n" +
                "Android conectado por Bluetooth.\n" +
                "Fila segura pronta para comandas.\n\n\n" +
                "\u001b\u0064\u0005\u001d\u0056\u0042\u0000")
                .getBytes(StandardCharsets.ISO_8859_1);
        print(printer, page);
        show("Teste impresso — fila automática ativa");
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
        signals.offer("STOP");
        closeSocket();
        worker.shutdownNow();
        if (socketClient != null) {
            socketClient.dispatcher().executorService().shutdown();
            socketClient.connectionPool().evictAll();
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        if (store.enabled()) {
            Intent restart = new Intent(getApplicationContext(), PrinterService.class);
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(restart);
                else startService(restart);
            } catch (Exception ignored) { }
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
