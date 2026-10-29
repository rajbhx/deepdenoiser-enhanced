const assert=require('node:assert/strict');
const {configure}=require('../plugins/withReleaseSigning');
const fixture=`android {
    signingConfigs {
        debug { storeFile file('debug.keystore') }
    }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
        }
    }
}`;
const result=configure(fixture);
assert.match(result,/DD_RELEASE_KEYSTORE/);
assert.match(result,/DD_RELEASE_STORE_PASSWORD/);
assert.match(result,/DD_RELEASE_KEY_ALIAS/);
assert.match(result,/DD_RELEASE_KEY_PASSWORD/);
assert.match(result,/DD_ALLOW_DEBUG_SIGNING/);
assert.match(result,/signingConfig null/);
assert.match(result,/debug \{ signingConfig signingConfigs\.debug \}/);
assert.equal(configure(result),result,'plugin must be idempotent');
assert.throws(()=>configure('android {}'),/signingConfigs/);
console.log('PASS release signing is user-keyed or unsigned, with explicit debug-test opt-in');
