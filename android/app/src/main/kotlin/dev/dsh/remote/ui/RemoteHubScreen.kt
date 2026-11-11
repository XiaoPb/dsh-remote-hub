package dev.dsh.remote.ui

/**
 * Compose surfaces to build (ROADMAP M3.4).
 *
 *   PairingScreen   — 6-digit code entry; the code is typed by a human who is
 *                     physically at the host. No QR in v1 (⚠️ open question Q5).
 *   SessionList     — sessions.list(); hidden entirely for roles that lack it.
 *   SessionDetail   — read-only transcript for `read-only`, composer for `control`+.
 *   ApprovalSheet   — approvals.respond(); the highest-risk surface, so it shows
 *                     exactly which tool call is being approved, never a summary.
 *   DeviceInfo      — role badge, role-gated action list, "unpair" button.
 *
 * Every screen reads permissions from the access snapshot, never from a
 * locally hardcoded role — same rule as the web client (DESIGN §7.3).
 *
 * TODO(M3.4): implement.
 */
internal object Screens {
    const val PLACEHOLDER = "NOT_IMPLEMENTED(M3.4)"
}
