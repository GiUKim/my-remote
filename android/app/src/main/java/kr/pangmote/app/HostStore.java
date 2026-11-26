package kr.pangmote.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The app's list of PCs (hosts.json in the app's own storage). A PC added with a host window's QR code holds the
 * device token the host gave over the session's own connection; its secret is kept only encrypted, with a key of the
 * Android Keystore that never leaves it (AES-256-GCM): the file alone (a backup is off anyway) tells nothing. Nothing
 * here keeps an access key: a PC reached with the key is not kept (the key is typed each time, or the PC is added with
 * a QR code).
 */
final class HostStore {
    private static final String KEY_ALIAS = "pangmote-hosts";
    private final File file;
    private final File idFile;
    private JSONArray hosts;

    HostStore(Context ctx) {
        file = new File(ctx.getFilesDir(), "hosts.json");
        idFile = new File(ctx.getFilesDir(), "install-id");
        hosts = read();
    }

    private JSONArray read() {
        try {
            if (!file.exists()) return new JSONArray();
            JSONObject o = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            JSONArray a = o.optJSONArray("hosts");
            return a != null ? a : new JSONArray();
        } catch (Exception e) {
            // A file that cannot be read is kept aside, never written over (its tokens may still be good).
            try { Files.move(file.toPath(), new File(file.getPath() + ".bad-" + System.currentTimeMillis()).toPath()); } catch (Exception ignored) { }
            return new JSONArray();
        }
    }

    private void write() {
        try {
            File tmp = new File(file.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(new JSONObject().put("hosts", hosts).toString(1).getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception ignored) { }
    }

    /** This install's own name (the host replaces the token of an app that pairs again with it). Random, says nothing. */
    synchronized String installId() {
        try {
            if (idFile.exists()) return new String(Files.readAllBytes(idFile.toPath()), StandardCharsets.UTF_8).trim();
            String id = UUID.randomUUID().toString();
            Files.write(idFile.toPath(), id.getBytes(StandardCharsets.UTF_8));
            return id;
        } catch (Exception e) {
            return "";
        }
    }

    /** The list for the list's page: names and what the PCs said they are, never a secret. */
    synchronized JSONArray publicList() {
        JSONArray out = new JSONArray();
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject h = hosts.optJSONObject(i);
            if (h == null || !h.has("dev")) continue; // a PC whose QR pairing never finished is not one
            try {
                out.put(new JSONObject().put("id", h.optString("id")).put("name", h.optString("name")).put("pc", h.optString("pc"))
                    .put("os", h.optString("os")).put("osName", h.optString("osName")).put("lastAt", h.optLong("lastAt")));
            } catch (Exception ignored) { }
        }
        return out;
    }

    private JSONObject find(String id) {
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject h = hosts.optJSONObject(i);
            if (h != null && id.equals(h.optString("id"))) return h;
        }
        return null;
    }

    /** A new entry for a PC being added with a QR code; it counts once the host gave it a token. */
    synchronized String addPending() {
        byte[] b = new byte[8];
        new SecureRandom().nextBytes(b);
        StringBuilder id = new StringBuilder();
        for (byte x : b) id.append(String.format("%02x", x));
        try { hosts.put(new JSONObject().put("id", id.toString()).put("added", System.currentTimeMillis())); } catch (Exception ignored) { }
        write();
        return id.toString();
    }

    /** Entries without a token (a QR pairing that did not finish) go. */
    synchronized void dropUnpaired() {
        JSONArray keep = new JSONArray();
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject h = hosts.optJSONObject(i);
            if (h != null && h.has("dev")) keep.put(h);
        }
        if (keep.length() != hosts.length()) { hosts = keep; write(); }
    }

    synchronized boolean setDevice(String hostId, String devId, String secret) {
        JSONObject h = find(hostId);
        if (h == null || !devId.matches("[0-9a-f]{16}") || !secret.matches("[A-Za-z0-9_-]{43}")) return false;
        try {
            h.put("dev", new JSONObject().put("id", devId).put("enc", seal(secret)));
            h.remove("verified");
            write();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    synchronized void setVerified(String hostId) {
        JSONObject h = find(hostId);
        if (h == null) return;
        try { h.put("verified", true); write(); } catch (Exception ignored) { }
    }

    /** { id, secret } of the PC's token, or null. */
    synchronized JSONObject device(String hostId) {
        JSONObject h = find(hostId);
        JSONObject d = h != null ? h.optJSONObject("dev") : null;
        if (d == null) return null;
        try { return new JSONObject().put("id", d.optString("id")).put("secret", open(d.optString("enc"))); } catch (Exception e) { return null; }
    }

    /** What the PC said it is (its page tells, mrShell.hostInfo): the list shows it; a name not given yet is its own. */
    synchronized void info(String hostId, String pc, String os, String osName, boolean connected) {
        JSONObject h = find(hostId);
        if (h == null) return;
        try {
            if (!pc.isEmpty()) h.put("pc", pc);
            if (!os.isEmpty()) h.put("os", os);
            if (!osName.isEmpty()) h.put("osName", osName);
            if (h.optString("name").isEmpty() && !pc.isEmpty()) h.put("name", pc);
            if (connected) h.put("lastAt", System.currentTimeMillis());
            write();
        } catch (Exception ignored) { }
    }

    synchronized void rename(String hostId, String name) {
        JSONObject h = find(hostId);
        if (h == null) return;
        try { h.put("name", name.trim().length() > 60 ? name.trim().substring(0, 60) : name.trim()); write(); } catch (Exception ignored) { }
    }

    synchronized void remove(String hostId) {
        JSONArray keep = new JSONArray();
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject h = hosts.optJSONObject(i);
            if (h != null && !hostId.equals(h.optString("id"))) keep.put(h);
        }
        hosts = keep;
        write();
    }

    // ---- the Keystore's key ----------------------------------------------------------------------------------------

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    private static String seal(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    private static String open(String sealed) throws Exception {
        int i = sealed.indexOf(':');
        byte[] iv = Base64.decode(sealed.substring(0, i), Base64.NO_WRAP);
        byte[] ct = Base64.decode(sealed.substring(i + 1), Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(c.doFinal(ct), StandardCharsets.UTF_8);
    }
}
