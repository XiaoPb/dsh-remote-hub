/**
 * Public surface of the shared contract layer.
 *
 * Both halves import `@core/...`; the build inlines it into `lib/index.js` and
 * `lib/client.js` respectively — one source, two artifacts, zero drift.
 *
 * @module @core
 */
export * from './protocol.js'
export * from './roles.js'
export * from './device.js'
export * from './capabilities.js'
export * from './capabilities-redlines.js'
export * from './redact.js'
export * from './carrier-contract.js'
export * from './local-plugin-manager.js'
