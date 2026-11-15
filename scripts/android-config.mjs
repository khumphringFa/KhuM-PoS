import fs from 'node:fs';
const manifest='android/app/src/main/AndroidManifest.xml';
let xml=fs.readFileSync(manifest,'utf8');
if(!xml.includes('android.permission.CAMERA'))xml=xml.replace('</manifest>','<uses-permission android:name="android.permission.CAMERA" /><uses-feature android:name="android.hardware.camera" android:required="false" /></manifest>');
xml=xml.replace(/android:allowBackup="true"/g,'android:allowBackup="false"');
fs.writeFileSync(manifest,xml);
const gradle='android/app/build.gradle';let g=fs.readFileSync(gradle,'utf8');
g=g.replace(/versionName "[^"]+"/, 'versionName "0.1.0"');
if(!g.includes('KHUM_KEYSTORE_PATH')){
 g=g.replace('    buildTypes {',`    signingConfigs {
        release {
            if (System.getenv('KHUM_KEYSTORE_PATH')) {
                storeFile file(System.getenv('KHUM_KEYSTORE_PATH'))
                storePassword System.getenv('KHUM_STORE_PASSWORD')
                keyAlias System.getenv('KHUM_KEY_ALIAS')
                keyPassword System.getenv('KHUM_KEY_PASSWORD')
            }
        }
    }
    buildTypes {`);
 g=g.replace('        release {','        release {',1);
 g=g.replace('            minifyEnabled false',"            if (System.getenv('KHUM_KEYSTORE_PATH')) signingConfig signingConfigs.release\n            minifyEnabled false");
}
fs.writeFileSync(gradle,g);

