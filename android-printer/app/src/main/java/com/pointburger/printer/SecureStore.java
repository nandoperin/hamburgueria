package com.pointburger.printer;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureStore {
    private static final String ALIAS = "pointburger_printer_token_v1";
    private final SharedPreferences prefs;

    SecureStore(Context context) {
        prefs = context.getSharedPreferences("printer_settings", Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    void saveToken(String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        prefs.edit()
                .putString("token", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("token_iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .apply();
    }

    String token() {
        try {
            String encrypted = prefs.getString("token", null);
            String iv = prefs.getString("token_iv", null);
            if (encrypted == null || iv == null) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            clearToken();
            return null;
        }
    }

    void clearToken() { prefs.edit().remove("token").remove("token_iv").apply(); }
    void savePrinter(String address) { prefs.edit().putString("printer", address).apply(); }
    String printer() { return prefs.getString("printer", null); }
    void setEnabled(boolean enabled) { prefs.edit().putBoolean("enabled", enabled).apply(); }
    boolean enabled() { return prefs.getBoolean("enabled", false); }
}
