package dev.dsh.remote.net

/**
 * Android protocol scaffold — **NOT IMPLEMENTED in this delivery** (M3 excluded by request).
 *
 * Retained only as a placeholder documenting the eventual wire shape. The
 * authoritative contract is `out/contract.json` (exported by
 * `scripts/contract-check.mjs`) and the DSH plugin's `core/src/protocol.ts`.
 * v1 has no socket upgrade anywhere: the downlink is three unary long-poll methods.
 *
 * Future shape (do not treat as current):
 *   POST {guardOrigin}/remote/rpc
 *   Authorization: Bearer <deviceToken>
 *   X-Hub-Protocol: 1
 *   body: { type:"client-request", rpcId, method:"<ns>/<method>", payload:{ args: {...} } }
 *   reply: { type:"server-response", rpcId, result:{ ok:true, value } | { ok:false, error } }
 *
 * - Reuse ONE OkHttpClient (connection pool + TLS session reuse matter on mobile).
 * - Treat 401/403 as "device revoked": surface to the UI, stop retrying.
 * - The token goes in the Authorization header only; never in a URL.
 */
interface RpcTransport {
    suspend fun <T : Any> call(method: String, payloadJson: String, decode: (String) -> T): T

    fun close()
}

/** NOT_IMPLEMENTED(M3.1) */
class OkHttpRpcTransport(
    private val guardOrigin: String,
    private val tokenProvider: () -> String?,
) : RpcTransport {
    override suspend fun <T : Any> call(method: String, payloadJson: String, decode: (String) -> T): T =
        throw NotImplementedError("OkHttpRpcTransport.call")

    override fun close() = throw NotImplementedError("OkHttpRpcTransport.close")
}
