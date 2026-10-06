import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAaptAttribute, parseAaptXmlTree } from "../../src/tools/static.js";

/**
 * `manifest-aapt2-37.txt` is verbatim `aapt2 dump xmltree --file
 * AndroidManifest.xml` output for the demo APK the maintainer tests against,
 * captured from build-tools 37.0.0. It matters that this is real output and
 * not a hand-written sample: the bug these tests cover (every namespaced
 * attribute silently dropped) only appears in the URI attribute form that
 * build-tools 37 emits, and a hand-written sample written in the older
 * `android:` form would have kept passing.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const realOutput = readFileSync(join(FIXTURES, "manifest-aapt2-37.txt"), "utf8");

describe("parseAaptXmlTree on real build-tools 37 output", () => {
  const manifest = parseAaptXmlTree(realOutput);

  it("reads the manifest element attributes", () => {
    assert.equal(manifest.package, "com.edgeatzero.edgemedia.network.demo.android");
    assert.equal(manifest.versionCode, "1");
    assert.equal(manifest.versionName, "1.0");
    assert.equal(manifest.compileSdk, "37");
  });

  it("reads uses-sdk", () => {
    assert.equal(manifest.minSdk, "26");
    assert.equal(manifest.targetSdk, "37");
  });

  it("collects every uses-permission, in document order", () => {
    assert.deepEqual(manifest.permissions, [
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.ACCESS_WIFI_STATE",
      "android.permission.CHANGE_WIFI_MULTICAST_STATE",
      "android.permission.NEARBY_WIFI_DEVICES",
      "android.permission.ACCESS_LOCAL_NETWORK",
      "com.edgeatzero.edgemedia.network.demo.android.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
    ]);
  });

  it("collects components by tag, with their exported flag", () => {
    assert.deepEqual(manifest.activities, [
      {
        name: "com.edgeatzero.edgemedia.network.demo.android.MainActivity",
        exported: true,
      },
    ]);
    assert.deepEqual(manifest.receivers, [
      {
        name: "androidx.profileinstaller.ProfileInstallReceiver",
        exported: true,
      },
    ]);
    assert.deepEqual(manifest.providers, [
      {
        name: "org.jetbrains.compose.resources.AndroidContextProvider",
        exported: false,
      },
      {
        name: "androidx.startup.InitializationProvider",
        exported: false,
      },
    ]);
    assert.deepEqual(manifest.services, []);
  });
});

describe("parseAaptAttribute", () => {
  it("normalizes the URI namespace form to the prefix form", () => {
    assert.deepEqual(
      parseAaptAttribute(
        "    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=1",
      ),
      { key: "android:versionCode", value: "1" },
    );
  });

  it("still parses the older prefix-only form", () => {
    assert.deepEqual(parseAaptAttribute("    A: android:versionName(0x0101021c)=\"1.0\""), {
      key: "android:versionName",
      value: "1.0",
    });
  });

  it("maps a non-android namespace URI to its last path segment", () => {
    assert.deepEqual(
      parseAaptAttribute("  A: http://schemas.android.com/tools:ignore(0x7f010000)=lint"),
      { key: "tools:ignore", value: "lint" },
    );
  });

  it("leaves unnamespaced attributes unprefixed", () => {
    assert.deepEqual(
      parseAaptAttribute('    A: package="com.example" (Raw: "com.example")'),
      { key: "package", value: "com.example" },
    );
    assert.deepEqual(parseAaptAttribute("    A: platformBuildVersionCode=37"), {
      key: "platformBuildVersionCode",
      value: "37",
    });
  });

  it("keeps an '=' that belongs to the value", () => {
    assert.deepEqual(
      parseAaptAttribute('    A: android:value(0x01010024)="a=b" (Raw: "a=b")'),
      { key: "android:value", value: "a=b" },
    );
  });

  it("decodes the boolean encoding aapt2 uses for true", () => {
    assert.deepEqual(
      parseAaptAttribute(
        "    A: http://schemas.android.com/apk/res/android:exported(0x01010010)=(type 0x12)0xffffffff",
      ),
      { key: "android:exported", value: "0xffffffff" },
    );
  });

  it("returns null for lines that are not attributes", () => {
    assert.equal(parseAaptAttribute("  E: manifest (line=2)"), null);
    assert.equal(parseAaptAttribute("N: android=http://schemas.android.com/apk/res/android"), null);
  });
});
