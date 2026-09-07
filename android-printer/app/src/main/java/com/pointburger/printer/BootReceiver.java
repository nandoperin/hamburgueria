package com.pointburger.printer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        SecureStore store = new SecureStore(context);
        if (!store.enabled() || store.token() == null || store.printer() == null) return;
        Intent service = new Intent(context, PrinterService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service); else context.startService(service);
    }
}
