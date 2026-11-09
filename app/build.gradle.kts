plugins {
    id("com.android.application")
}

android {
    namespace = "com.teamjang.modeltree"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.teamjang.modeltree"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        create("app") {
            storeFile = file("app.keystore")
            storePassword = "modeltreepass"
            keyAlias = "modeltree"
            keyPassword = "modeltreepass"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("app")
        }
        debug { signingConfig = signingConfigs.getByName("app") }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
