plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "dev.dsh.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.dsh.remote"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.5"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Protocol layer: plain HTTPS + WebSocket. No DSH SDK exists for Android,
    // so the JSON envelope from core/ is re-implemented in Kotlin and must be
    // kept in lockstep by the cross-platform contract tests (ROADMAP M3.5).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Device token at rest. ⚠️ androidx.security-crypto is in maintenance mode;
    // if it is dropped, move to Keystore-wrapped AES-GCM. Never plain SharedPreferences.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
