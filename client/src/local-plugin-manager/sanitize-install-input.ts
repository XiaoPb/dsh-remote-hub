/**
 * @provenance @deepseek-ai/dsh-client-ui-plugin-manager/src/client/sanitize-install-input.ts @ 0.2.2-rc.1
 * Vendored verbatim from the official plugin manager client. Only imports were rewritten (see
 * scripts/vendor-local-plugin-ui.mjs) so this plugin reuses the official page byte-for-byte while
 * keeping its host-provided runtime surface. Do not hand-edit: regenerate instead.
 */
/** Privacy-safe installation input classification shared by click and result events. */

/**
 * Keep registry package names and plain versions; classify other installer inputs without their contents.
 * @param spec - user-entered installation spec.
 * @returns an identifier safe to send without URL credentials, tokens, or local paths.
 */
export function sanitizeInstallInput(spec: string): string {
  if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*^~+<>=| -]+)?$/iu.test(spec)) return spec
  if (/^(?:git[+:]|git@|github:|gitlab:|bitbucket:)/iu.test(spec)) return '[git]'
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(spec)) return '[url]'
  return '[path-or-other]'
}
