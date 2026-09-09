package com.jiaban.records;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    private boolean valid(String app, String version, long build, String url, String sha, long size, int sdk) {
        return UpdatePolicy.validRelease(app, version, build, url, sha, size, sdk);
    }
    private final String url = UpdatePolicy.ORIGIN + "/downloads/jiaban-1.3.1.apk";
    private final String hash = "a".repeat(64);

    @Test public void acceptsOnlyFixedAppAndReleaseUrl() {
        assertTrue(valid(UpdatePolicy.APP_ID, "1.3.1", 131, url, hash, 3000000, 24));
        for (String other : new String[]{"http://jiaban-x2m.pages.dev/downloads/jiaban-1.3.1.apk", url + "?redirect=1", url.replace("jiaban-x2m", "other"), url.replace("1.3.1.apk", "../other.apk")})
            assertFalse(valid(UpdatePolicy.APP_ID, "1.3.1", 131, other, hash, 3000000, 24));
        assertFalse(valid("com.other.app", "1.3.1", 131, url, hash, 3000000, 24));
    }
    @Test public void rejectsMalformedAndOversizedMetadata() {
        assertFalse(valid(UpdatePolicy.APP_ID, "../1", 131, url, hash, 1, 24));
        assertFalse(valid(UpdatePolicy.APP_ID, "1.3.1", 0, url, hash, 1, 24));
        assertFalse(valid(UpdatePolicy.APP_ID, "1.3.1", 131, url, "bad-hash", 1, 24));
        assertFalse(valid(UpdatePolicy.APP_ID, "1.3.1", 131, url, hash, 0, 24));
        assertFalse(valid(UpdatePolicy.APP_ID, "1.3.1", 131, url, hash, UpdatePolicy.MAX_APK + 1, 24));
        assertFalse(valid(UpdatePolicy.APP_ID, "1.3.1", 131, url, hash, 1, 23));
    }
    @Test public void requiresSameNonemptySigningIdentity() {
        assertTrue(UpdatePolicy.sameSigners(new String[]{"original"}, new String[]{"original"}));
        assertFalse(UpdatePolicy.sameSigners(new String[]{"original"}, new String[]{"replacement"}));
        assertFalse(UpdatePolicy.sameSigners(new String[]{"original"}, new String[]{"original", "extra"}));
        assertFalse(UpdatePolicy.sameSigners(new String[]{}, new String[]{}));
        assertFalse(UpdatePolicy.sameSigners(null, new String[]{"original"}));
    }
}
