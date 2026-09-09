package com.jiaban.records;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** The release channel is fixed, and updates must keep the installed signing identity. */
final class UpdatePolicy {
    static final String APP_ID = "com.jiaban.records";
    static final String ORIGIN = "https://jiaban-x2m.pages.dev";
    static final long MAX_APK = 25L * 1024 * 1024;

    static boolean validRelease(String appId, String version, long build, String url, String sha, long size, int minSdk) {
        return APP_ID.equals(appId) && version != null && version.matches("\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}")
            && build > 0 && build <= Integer.MAX_VALUE && minSdk >= 24 && minSdk <= 100
            && (ORIGIN + "/downloads/jiaban-" + version + ".apk").equals(url)
            && sha != null && sha.matches("[a-f0-9]{64}") && size > 0 && size <= MAX_APK;
    }

    static boolean sameSigners(String[] installed, String[] downloaded) {
        if (installed == null || downloaded == null || installed.length == 0 || downloaded.length == 0) return false;
        Set<String> a = new HashSet<>(Arrays.asList(installed)), b = new HashSet<>(Arrays.asList(downloaded));
        return a.equals(b);
    }
}
