package dev.dsh.remote.security

/**
 * Device token + pairing state at rest.
 *
 * Rules:
 * - Token goes in EncryptedSharedPreferences (Keystore-backed). Plain
 *   SharedPreferences is a finding, not a shortcut.
 * - Only ONE device identity per install; re-pairing replaces it atomically.
 * - `clear()` must be called on 401/403 and on `device.revoked`.
 *
 * TODO(M3.2): implement.
 */
interface DeviceStore {
    fun saveToken(deviceId: String, token: String, role: String)
    fun token(): String?
    fun role(): String?
    fun clear()
}

/** NOT_IMPLEMENTED(M3.2) */
class EncryptedDeviceStore(
    // context injected rather than held statically, so tests can use a temp file
    private val encryptedPrefs: android.content.SharedPreferences,
) : DeviceStore {
    override fun saveToken(deviceId: String, token: String, role: String) =
        throw NotImplementedError("EncryptedDeviceStore.saveToken")

    override fun token(): String? = throw NotImplementedError("EncryptedDeviceStore.token")
    override fun role(): String? = throw NotImplementedError("EncryptedDeviceStore.role")
    override fun clear() = throw NotImplementedError("EncryptedDeviceStore.clear")
}
