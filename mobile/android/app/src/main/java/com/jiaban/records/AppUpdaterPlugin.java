package com.jiaban.records;

import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private volatile Release latest;
    private volatile Release ready;

    private static class Release {
        final String version, url, sha, notes;
        final long code, size;
        final int minSdk;
        Release(JSONObject data) throws Exception {
            version = data.getString("version"); url = data.getString("url"); sha = data.getString("sha256");
            code = data.getLong("versionCode"); size = data.getLong("size"); minSdk = data.getInt("minSdk");
            notes = data.optString("notes", "体验优化与问题修复");
            if (data.getInt("schemaVersion") != 1 || notes.length() > 2000 || !UpdatePolicy.validRelease(
                data.getString("appId"), version, code, url, sha, size, minSdk)) throw new Exception("更新信息校验失败，请稍后重试");
        }
        JSObject json() {
            JSObject out = new JSObject(); out.put("version", version); out.put("versionCode", code);
            out.put("size", size); out.put("notes", notes); return out;
        }
    }

    private HttpURLConnection connect(String address) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (connection.getResponseCode() != 200) { connection.disconnect(); throw new Exception("更新服务暂时不可用，请稍后重试"); }
        return connection;
    }

    @SuppressWarnings("deprecation")
    private int packageFlags() { return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES; }

    @SuppressWarnings("deprecation")
    private long versionCode(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }

    @SuppressWarnings("deprecation")
    private PackageInfo installed() throws Exception { return getContext().getPackageManager().getPackageInfo(UpdatePolicy.APP_ID, packageFlags()); }

    @SuppressWarnings("deprecation")
    private String[] signers(PackageInfo info) {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
            ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        if (signatures == null) return new String[0];
        String[] values = new String[signatures.length];
        for (int i = 0; i < signatures.length; i++) values[i] = signatures[i].toCharsString();
        return values;
    }

    @PluginMethod
    public void check(PluginCall call) {
        io.execute(() -> {
            try {
                HttpURLConnection connection = connect(UpdatePolicy.ORIGIN + "/downloads/android-latest.json");
                Release release;
                try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 16384) throw new Exception("更新信息过大，请稍后重试");
                        output.write(buffer, 0, count);
                    }
                    release = new Release(new JSONObject(output.toString(StandardCharsets.UTF_8.name())));
                } finally { connection.disconnect(); }
                PackageInfo current = installed();
                latest = release;
                JSObject result = new JSObject(); result.put("currentVersion", current.versionName);
                result.put("available", release.code > versionCode(current));
                result.put("compatible", Build.VERSION.SDK_INT >= release.minSdk);
                result.put("release", release.json()); call.resolve(result);
            } catch (Exception error) { call.reject("暂时无法检查更新，请联网后重试"); }
        });
    }

    private File updateFile(Release release, boolean partial) throws Exception {
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("手机空间不足，无法保存更新");
        return new File(directory, "jiaban-" + release.version + (partial ? ".part" : ".apk"));
    }

    private String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        StringBuilder value = new StringBuilder();
        for (byte b : hash.digest()) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return value.toString();
    }

    @SuppressWarnings("deprecation")
    private void verify(File file, Release release) throws Exception {
        if (file.length() != release.size || !digest(file).equals(release.sha)) throw new Exception("下载不完整，请重新下载");
        PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), packageFlags());
        PackageInfo current = installed();
        if (archive == null || !UpdatePolicy.APP_ID.equals(archive.packageName) || versionCode(archive) != release.code
            || !release.version.equals(archive.versionName) || release.code <= versionCode(current)
            || !UpdatePolicy.sameSigners(signers(current), signers(archive))) throw new Exception("安装包身份校验失败，已停止安装");
    }

    @PluginMethod
    public void download(PluginCall call) {
        Release release = latest;
        if (release == null) { call.reject("请先检查更新"); return; }
        if (!downloading.compareAndSet(false, true)) { call.reject("正在下载，请稍候"); return; }
        io.execute(() -> {
            File partial = null;
            try {
                if (release.code <= versionCode(installed()) || Build.VERSION.SDK_INT < release.minSdk) throw new Exception("当前手机无需安装此版本");
                ready = null;
                File target = updateFile(release, false);
                // Only this app's updater cache is cleaned; exports and all user records remain untouched.
                File[] previous = target.getParentFile().listFiles();
                if (previous != null) for (File file : previous) {
                    if (file.isFile() && file.getName().matches("jiaban-\\d+\\.\\d+\\.\\d+\\.(apk|part)") && !file.delete()) {
                        throw new Exception("无法整理更新缓存，请重启应用后重试");
                    }
                }
                partial = updateFile(release, true);
                HttpURLConnection connection = connect(release.url);
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[65536]; int count, lastPercent = -1; long received = 0;
                    while ((count = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new Exception("下载已中断，请重试");
                        received += count;
                        if (received > release.size) throw new Exception("安装包大小不符，已停止下载");
                        output.write(buffer, 0, count);
                        int percent = (int) (received * 100 / release.size);
                        if (percent != lastPercent) { JSObject progress = new JSObject(); progress.put("percent", percent); notifyListeners("progress", progress); lastPercent = percent; }
                    }
                    output.getFD().sync();
                } finally { connection.disconnect(); }
                if (!partial.renameTo(target)) throw new Exception("无法保存安装包，请重试");
                verify(target, release); ready = release; call.resolve();
            } catch (Exception error) { call.reject(error instanceof java.io.IOException ? "下载中断或手机空间不足，请检查后重试" : error.getMessage()); }
            finally { if (partial != null && partial.exists()) partial.delete(); downloading.set(false); }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        Release release = ready;
        if (release == null) { call.reject("安装包尚未就绪，请重新下载"); return; }
        io.execute(() -> {
            try {
                File file = updateFile(release, false); verify(file, release);
                getActivity().runOnUiThread(() -> {
                    try {
                        JSObject result = new JSObject();
                        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            result.put("permissionRequired", true); call.resolve(result); return;
                        }
                        Uri uri = FileProvider.getUriForFile(getContext(), UpdatePolicy.APP_ID + ".fileprovider", file);
                        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.setClipData(ClipData.newRawUri("加班记录更新", uri));
                        getActivity().startActivity(intent); result.put("permissionRequired", false); call.resolve(result);
                    } catch (Exception error) { call.reject("无法打开系统安装页面，请稍后重试"); }
                });
            } catch (Exception error) { ready = null; call.reject(error.getMessage()); }
        });
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 26) getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + UpdatePolicy.APP_ID)));
                call.resolve();
            } catch (Exception error) { call.reject("请到手机设置中允许「加班记录」安装应用"); }
        });
    }

    @Override protected void handleOnDestroy() { io.shutdownNow(); }
}
