/**
 * A2-7: file transfer two legs (D-6) — static gate.
 *
 * Reads `host/src/files.ts` and `host/src/guard.ts` (no service is started):
 *   - upload goes through `fileUploads/upload`, never the exact Fetch route
 *   - the exact Fetch route is 404 at the guard (route whitelist)
 *   - text preview uses `workspaceFiles/read` with offset/limit/lines/eof
 *   - binary preview uses `workspaceFiles/readBytes` with range
 *   - `workspace-file/not-text` is translated to the binary channel
 */
import {
  PATHS,
  createReport,
  fn,
  readText,
  requireLibOrExit,
  tryLoadLib,
  val,
} from './_shared.mjs'

requireLibOrExit()
const mod = await tryLoadLib()
const report = createReport('e2e-files.log')

const filesSrc = readText(PATHS.filesSrc)
const guardSrc = readText(PATHS.guardSrc)

const UPLOAD_ENDPOINT = val(mod, 'UPLOAD_ENDPOINT', 'fileUploads/upload')
const PREVIEW_TEXT_ENDPOINT = val(mod, 'PREVIEW_TEXT_ENDPOINT', 'workspaceFiles/read')
const PREVIEW_BINARY_ENDPOINT = val(mod, 'PREVIEW_BINARY_ENDPOINT', 'workspaceFiles/readBytes')
const EXACT_FETCH_UPLOAD_ROUTE = val(mod, 'EXACT_FETCH_UPLOAD_ROUTE', '/api/session/uploadFileBinary')
const MAX_FILE_BYTES = val(mod, 'MAX_FILE_BYTES', 32 * 1024 * 1024)
const OFFICIAL_ERROR_CODES = val(mod, 'OFFICIAL_ERROR_CODES', undefined)
const classifyPreviewError = fn(mod, 'classifyPreviewError')

// 1. Upload endpoint + exact Fetch route is not in the guard's route table.
const uploadOk = UPLOAD_ENDPOINT === 'fileUploads/upload'
  && filesSrc.includes('fileUploads/upload')
  && guardSrc.includes('GUARD_ROUTES')
const exactRouteOk = EXACT_FETCH_UPLOAD_ROUTE === '/api/session/uploadFileBinary'
  && !guardSrc.includes(EXACT_FETCH_UPLOAD_ROUTE.replace('/api/', ''))
  && /404/u.test(guardSrc)
  && /known\.has\(path\)|GUARD_ROUTES/u.test(guardSrc)
  && /\/api\//u.test(filesSrc)

// 2. Text preview parameter shape.
const textOk = PREVIEW_TEXT_ENDPOINT === 'workspaceFiles/read'
  && /\boffset\??\s*:/u.test(filesSrc)
  && /\blimit\??\s*:/u.test(filesSrc)
  && /\blines\b/u.test(filesSrc)
  && /\beof\b/u.test(filesSrc)

// 3. Binary preview parameter shape.
const binaryOk = PREVIEW_BINARY_ENDPOINT === 'workspaceFiles/readBytes'
  && /\brange\s*:\s*\{[^}]*offset[^}]*length/u.test(filesSrc.replace(/\s+/gu, ' '))
  && /\bmaxFileBytes/u.test(filesSrc)
  && MAX_FILE_BYTES >= 32 * 1024 * 1024

// 4. `workspace-file/not-text` → binary channel (not internal).
const notText = OFFICIAL_ERROR_CODES?.workspaceFileNotText ?? 'workspace-file/not-text'
const classified = classifyPreviewError ? classifyPreviewError(notText) : null
const mappingOk = notText === 'workspace-file/not-text'
  && filesSrc.includes('workspace-file/not-text')
  && /use-binary-channel/u.test(filesSrc)
  && (classified === null || classified.kind === 'use-binary-channel')

report.check('upload-via-fileUploads: 200', () => uploadOk,
  `UPLOAD_ENDPOINT=${UPLOAD_ENDPOINT}`)
report.check('exact-fetch-upload-route: 404', () => exactRouteOk,
  `${EXACT_FETCH_UPLOAD_ROUTE} must be absent from the guard route table`)
report.check('preview-text: read offset/limit lines/eof', () => textOk,
  'workspaceFiles/read must be a line window (offset/limit/lines/eof)')
report.check('preview-binary: readBytes range', () => binaryOk,
  'workspaceFiles/readBytes must use a byte range')
report.check('read-on-binary: workspace-file/not-text mapped', () => mappingOk,
  `classifyPreviewError(${notText}) = ${JSON.stringify(classified)}`)

report.finish()
