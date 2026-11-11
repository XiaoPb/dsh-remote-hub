// Root build file. Versions are declared once here and consumed by :app.
// ⚠️ TODO(M3.0): pin to the versions the team actually uses, and add the
// Gradle wrapper (gradle/wrapper/gradle-wrapper.properties + jar) before the
// first build — the scaffold ships without a wrapper on purpose.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.0" apply false
}
