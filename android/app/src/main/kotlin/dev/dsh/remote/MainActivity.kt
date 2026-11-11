package dev.dsh.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text

/**
 * Single-activity Compose host.
 *
 * TODO(M3.2): replace the placeholder with the navigation graph:
 *   Pairing → SessionList → SessionDetail → ApprovalSheet
 *
 * ⚠️ The theme referenced by AndroidManifest (`Theme.DshRemote`) and the
 * res/ tree (values/themes.xml, strings.xml, mipmap icons) still have to be
 * created — omitted from the scaffold intentionally.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            // NOT_IMPLEMENTED(M3.2): RemoteHubApp()
            Text("dsh-remote-hub scaffold")
        }
    }
}
