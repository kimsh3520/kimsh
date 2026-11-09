plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.teamjang.ytmp3"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.teamjang.ytmp3"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "1.3"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    signingConfigs {
        create("app") {
            storeFile = file("app.keystore")
            storePassword = "ytmp3pass"
            keyAlias = "ytmp3"
            keyPassword = "ytmp3pass"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("app")
        }
        debug { signingConfig = signingConfigs.getByName("app") }
    }

    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:library:0.17.3")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.17.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
