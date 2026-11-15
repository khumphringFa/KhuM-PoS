import fs from "node:fs";
const manifest = "android/app/src/main/AndroidManifest.xml";
let xml = fs.readFileSync(manifest, "utf8");
if (!xml.includes("android.permission.CAMERA"))
  xml = xml.replace(
    "</manifest>",
    '<uses-permission android:name="android.permission.CAMERA" /><uses-feature android:name="android.hardware.camera" android:required="false" /></manifest>',
  );
xml = xml.replace(/android:allowBackup="true"/g, 'android:allowBackup="false"');
fs.writeFileSync(manifest, xml);
const gradle = "android/app/build.gradle";
let g = fs.readFileSync(gradle, "utf8");
g = g.replace(/versionName "[^"]+"/, 'versionName "0.1.0"');
if (!g.includes("KHUM_KEYSTORE_PATH")) {
  g = g.replace(
    "    buildTypes {",
    `    signingConfigs {
        release {
            if (System.getenv('KHUM_KEYSTORE_PATH')) {
                storeFile file(System.getenv('KHUM_KEYSTORE_PATH'))
                storePassword System.getenv('KHUM_STORE_PASSWORD')
                keyAlias System.getenv('KHUM_KEY_ALIAS')
                keyPassword System.getenv('KHUM_KEY_PASSWORD')
            }
        }
    }
    buildTypes {`,
  );
  g = g.replace("        release {", "        release {", 1);
  g = g.replace(
    "            minifyEnabled false",
    "            if (System.getenv('KHUM_KEYSTORE_PATH')) signingConfig signingConfigs.release\n            minifyEnabled false",
  );
}
fs.writeFileSync(gradle, g);

// Use the same KhuM mark for the installed app and native launch screen.
const res = 'android/app/src/main/res';
fs.mkdirSync(`${res}/drawable`, {recursive:true});
fs.writeFileSync(`${res}/drawable/khum_icon.xml`, `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><path android:fillColor="#0c332d" android:pathData="M0,0H108V108H0Z"/><path android:fillColor="#00000000" android:strokeColor="#f8bd62" android:strokeWidth="8" android:strokeLineCap="round" android:pathData="M34,30V78M34,57L72,30M34,57L74,78"/><path android:fillColor="#eae7d9" android:pathData="M80,25A6,6 0,1 0,80 37A6,6 0,1 0,80 25"/></vector>`);
let manifestXml=fs.readFileSync(manifest,'utf8').replace(/android:icon="[^"]+"/,'android:icon="@drawable/khum_icon"').replace(/android:roundIcon="[^"]+"/,'android:roundIcon="@drawable/khum_icon"');
fs.writeFileSync(manifest,manifestXml);
for(const dir of fs.readdirSync(res).filter(d=>d.startsWith('drawable'))){const file=`${res}/${dir}/splash.png`;if(fs.existsSync(file))fs.unlinkSync(file);}
fs.writeFileSync(`${res}/drawable/splash.xml`,`<layer-list xmlns:android="http://schemas.android.com/apk/res/android"><item android:drawable="@color/khum_splash"/><item android:width="96dp" android:height="96dp" android:gravity="center" android:drawable="@drawable/khum_icon"/></layer-list>`);
fs.writeFileSync(`${res}/values/khum_colors.xml`,`<resources><color name="khum_splash">#0c332d</color></resources>`);
