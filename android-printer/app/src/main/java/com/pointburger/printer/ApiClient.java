package com.pointburger.printer;

import android.os.Build;
import android.util.Base64;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class ApiClient {
    private static final String BASE = "https://bot.pointburgerjg.com/printer-agent";

    static JSONObject pair(String code) throws Exception {
        JSONObject body = new JSONObject();
        body.put("code", code);
        body.put("deviceName", Build.MANUFACTURER + " " + Build.MODEL);
        return request("/pair", null, body, 201);
    }

    static JSONObject next(String token) throws Exception {
        return request("/next", token, new JSONObject(), 200);
    }

    static void complete(String token, String jobId, String leaseToken) throws Exception {
        JSONObject body = new JSONObject().put("jobId", jobId).put("leaseToken", leaseToken);
        request("/complete", token, body, 200);
    }

    static void fail(String token, String jobId, String leaseToken) {
        try {
            JSONObject body = new JSONObject().put("jobId", jobId).put("leaseToken", leaseToken);
            request("/fail", token, body, 200);
        } catch (Exception ignored) { }
    }

    static byte[] checkedContent(JSONObject job) throws Exception {
        byte[] bytes = Base64.decode(job.getString("contentBase64"), Base64.DEFAULT);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        StringBuilder actual = new StringBuilder();
        for (byte b : digest.digest(bytes)) actual.append(String.format("%02x", b));
        if (!MessageDigest.isEqual(actual.toString().getBytes(StandardCharsets.US_ASCII),
                job.getString("contentSha256").getBytes(StandardCharsets.US_ASCII))) {
            throw new SecurityException("Conteudo da comanda corrompido");
        }
        return bytes;
    }

    private static JSONObject request(String path, String token, JSONObject body, int expected) throws Exception {
        URL url = new URL(BASE + path);
        if (!"https".equals(url.getProtocol()) || !"bot.pointburgerjg.com".equals(url.getHost())) {
            throw new SecurityException("Servidor invalido");
        }
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = connection.getOutputStream()) { out.write(payload); }

        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        StringBuilder response = new StringBuilder();
        if (stream != null) try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null && response.length() < 1_000_000) response.append(line);
        }
        connection.disconnect();
        if (status != expected) throw new ApiException(status, "Servidor recusou a operacao");
        return response.length() == 0 ? new JSONObject() : new JSONObject(response.toString());
    }

    static final class ApiException extends Exception {
        final int status;
        ApiException(int status, String message) { super(message); this.status = status; }
    }
}
