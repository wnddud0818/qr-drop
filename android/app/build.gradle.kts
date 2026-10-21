plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.qrrecv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.qrrecv"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 개인용이라 디버그 키로 서명 (설치용 APK 바로 생성)
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // 화면은 저장소의 web/ 폴더를 그대로 에셋으로 넣는다 (web/qr-recv.html을 고치면 앱에도 반영)
    sourceSets {
        getByName("main") {
            assets.srcDir(rootProject.file("../web"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.core:core:1.13.1")
}
