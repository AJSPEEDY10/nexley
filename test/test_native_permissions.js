/* What the native wrap asks the phone for, and whether it has said why.
 *
 * Two checklist items, both from GROWTH_AND_LAUNCH.md §11: "justify every
 * permission the native wrap requests" and "privacy labels must match what the
 * app actually collects".
 *
 * THE TRAP THIS ENCODES, found 2026-09-09: ios/App/App/Info.plist had NO usage
 * strings at all, while app.html has two `capture="environment"` file inputs. In
 * a WKWebView that opens the system camera, and iOS does not show a prompt when
 * the string is missing — it TERMINATES the app. Every camera tap in the iOS
 * build would have crashed it, on the first photo a student ever tried to take.
 *
 * The test is a cross-file invariant on purpose: it reads what the WEB app does
 * and asserts the NATIVE shells have kept up. That is the direction the drift
 * goes — a feature ships in app/, and the two wrappers are not touched.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const appHtml = read('app/app.html');
const plist = read('ios/App/App/Info.plist');
const manifest = read('android/app/src/main/AndroidManifest.xml');

/* Info.plist without a plist parser: the value is the <string> after the <key>. */
function plistString(key) {
  const re = new RegExp('<key>' + key + '</key>\\s*<string>([\\s\\S]*?)</string>');
  const m = re.exec(plist);
  return m ? m[1].trim() : null;
}

console.log('\n1. The web app opens the camera, so iOS must have been told why');
const capturesCamera = /<input[^>]*type="file"[^>]*capture=/i.test(appHtml);
const picksImages = /<input[^>]*type="file"[^>]*accept="image\/\*"/i.test(appHtml);
ok('app.html still has a camera-capture input (if not, this whole file needs revisiting)',
  capturesCamera);
ok('app.html still has an image picker', picksImages);

[['NSCameraUsageDescription', capturesCamera],
 ['NSPhotoLibraryUsageDescription', picksImages]].forEach(function (pair) {
  const key = pair[0], needed = pair[1];
  const val = plistString(key);
  if (!needed) return;
  ok(key + ' is present — without it iOS kills the app, it does not prompt', !!val);
  ok(key + ' is a real sentence, not a placeholder',
    !!val && val.length >= 60, val ? val.length + ' chars' : 'missing');
  /* Apple rejects strings that restate the permission instead of the reason. */
  ok(key + ' says what it is FOR, not just what it wants',
    !!val && !/^(we need|this app needs|required for|access to)/i.test(val), val || '');
});

console.log('\n2. Nothing is requested that Nexley does not use');
const NOT_USED = ['NSMicrophoneUsageDescription', 'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription', 'NSContactsUsageDescription',
  'NSCalendarsUsageDescription', 'NSFaceIDUsageDescription',
  'NSPhotoLibraryAddUsageDescription', 'NSBluetoothAlwaysUsageDescription'];
NOT_USED.forEach(k => ok('iOS does not ask for ' + k.replace(/^NS|UsageDescription$/g, ''),
  plistString(k) === null));

/* The app manifest itself. Plugins merge their own in at build time — the local
   notifications plugin brings POST_NOTIFICATIONS, WAKE_LOCK, RECEIVE_BOOT_COMPLETED
   and SCHEDULE_EXACT_ALARM — and those are a deliberate consequence of the
   reminders feature. What this guards is the app's OWN manifest quietly growing
   one nobody decided on. */
console.log('\n3. Android asks for exactly one permission of its own');
const ANDROID_ALLOWED = ['android.permission.INTERNET'];
const declared = (manifest.match(/<uses-permission[^>]*android:name="([^"]+)"/g) || [])
  .map(s => /android:name="([^"]+)"/.exec(s)[1]);
declared.forEach(p => ok('declared and expected: ' + p, ANDROID_ALLOWED.indexOf(p) !== -1,
  'not on the allow-list — was this decided, or did something add it?'));
ANDROID_ALLOWED.forEach(p => ok('still declared: ' + p, declared.indexOf(p) !== -1));
ok('no CAMERA permission — the file input hands off to the camera app instead',
  declared.indexOf('android.permission.CAMERA') === -1);

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
