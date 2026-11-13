/**
 * 扫码弹层：`getUserMedia` 预览 + 自研 QR 解码（不依赖 BarcodeDetector）。
 *
 * 为什么不用 `BarcodeDetector`：Electron/Chromium 在 Windows 上通常没有该 API
 * （只在 Android/ChromeOS/macOS 稳定），依赖它会让按钮在目标平台上不可用。
 * 这里用 `qr-decode.ts` 逐帧解码，并兼容 `BarcodeDetector`（存在时优先，快很多）。
 *
 * 生命周期：打开时申请一次摄像头 → 逐帧（~8fps）识别 → 命中即回调并关闭；
 * 关闭/卸载时**必须**停掉所有 track，否则摄像头指示灯常亮。
 *
 * @module dsh-remote-hub/client/panel/QrScanner
 */
import React from 'react'

import { decodeQrGray, type GrayImage } from './qr-decode.js'

/** 弹层属性。 */
export interface QrScannerProps {
  /** 识别到文本（原始内容，由 caller 再解析）。 */
  onResult: (text: string) => void
  /** 关闭（取消 / 命中后由 caller 卸载）。 */
  onClose: () => void
  /** 注入解码（测试用）。 */
  decode?: (gray: GrayImage) => string | undefined
}

/** 采集画布的目标宽度（越小越快；37 模块的码在 480px 下每模块约 12px）。 */
const TARGET_WIDTH = 480

/** 逐帧间隔（毫秒）；8fps 足够扫码，又不至于吃完 CPU。 */
const FRAME_INTERVAL_MS = 120

/** 系统 `BarcodeDetector` 的最小形状（存在且可用时才走快路径）。 */
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

/**
 * 扫码弹层组件。
 * @param props - 见 `QrScannerProps`。
 * @returns React 节点。
 */
export function QrScanner(props: QrScannerProps): React.ReactNode {
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [hint, setHint] = React.useState<string>('正在启动摄像头…')
  const stoppedRef = React.useRef(false)
  const streamRef = React.useRef<MediaStream | null>(null)

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const decode = props.decode ?? decodeQrGray

    const stop = (): void => {
      stoppedRef.current = true
      if (timer !== undefined) clearTimeout(timer)
      const stream = streamRef.current
      streamRef.current = null
      for (const track of stream?.getTracks() ?? []) track.stop()
    }

    const canvas = globalThis.document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })

    const tick = async (): Promise<void> => {
      if (cancelled || stoppedRef.current) return
      const video = videoRef.current
      if (video !== null && video.readyState >= 2 && context !== null) {
        try {
          const width = TARGET_WIDTH
          const ratio = video.videoHeight / video.videoWidth || 1
          const height = Math.round(width * ratio)
          canvas.width = width
          canvas.height = height
          context.drawImage(video, 0, 0, width, height)

          // 快路径：系统条码识别（若存在）。
          const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
          let text: string | undefined
          if (Detector !== undefined) {
            try {
              const detector = new Detector({ formats: ['qr_code'] })
              const results = await detector.detect(canvas)
              text = results[0]?.rawValue
            } catch {
              text = undefined // 系统识别失败就退回自研解码。
            }
          }
          if (text === undefined) {
            const data = context.getImageData(0, 0, width, height)
            const gray: GrayImage = {
              width,
              height,
              data: new Uint8Array(width * height),
            }
            for (let i = 0, p = 0; i < data.data.length; i += 4, p++) {
              // 亮度近似（Rec.601），够用且快。
              gray.data[p] = Math.round(
                (data.data[i] ?? 0) * 0.299 + (data.data[i + 1] ?? 0) * 0.587 + (data.data[i + 2] ?? 0) * 0.114,
              )
            }
            text = decode(gray)
          }
          if (text !== undefined) {
            setHint('识别成功')
            stop()
            props.onResult(text)
            return
          }
        } catch (cause) {
          setError(`识别失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      timer = setTimeout(() => { void tick() }, FRAME_INTERVAL_MS)
    }

    const start = async (): Promise<void> => {
      const media = globalThis.navigator?.mediaDevices
      if (media?.getUserMedia === undefined) {
        setError('当前环境不支持摄像头（navigator.mediaDevices 不可用）。')
        return
      }
      try {
        const stream = await media.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video !== null) {
          video.srcObject = stream
          await video.play().catch(() => {})
        }
        setHint('把二维码对准摄像头…')
        void tick()
      } catch (cause) {
        const name = (cause as { name?: string }).name
        setError(
          name === 'NotAllowedError'
            ? '摄像头权限被拒绝：请在系统/浏览器设置里允许本应用使用摄像头。'
            : `无法打开摄像头：${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }

    void start()
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  return React.createElement(
    'div',
    {
      'data-testid': 'qr-scanner',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '扫描二维码',
      style: {
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.62)',
      },
      onClick: (event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) props.onClose()
      },
    },
    React.createElement('div', {
      style: {
        width: 560, maxWidth: '92vw', borderRadius: 14, overflow: 'hidden',
        background: '#111', color: '#fff', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      },
    },
    React.createElement('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', fontSize: 14,
      },
    },
    React.createElement('strong', null, '扫描配对二维码'),
    React.createElement('button', {
      type: 'button',
      'data-testid': 'qr-scanner-close',
      onClick: () => props.onClose(),
      style: {
        background: 'transparent', border: '1px solid rgba(255,255,255,0.35)',
        color: '#fff', borderRadius: 8, padding: '4px 12px', cursor: 'pointer',
      },
    }, '关闭')),

    React.createElement('div', { style: { position: 'relative', background: '#000', minHeight: 280 } },
      React.createElement('video', {
        ref: videoRef,
        'data-testid': 'qr-scanner-video',
        muted: true,
        playsInline: true,
        style: { width: '100%', display: 'block', maxHeight: '60vh', objectFit: 'cover' },
      }),
      // 取景框提示
      React.createElement('div', {
        'aria-hidden': true,
        style: {
          position: 'absolute', inset: '18% 18%', border: '2px solid rgba(255,255,255,0.8)',
          borderRadius: 10, pointerEvents: 'none',
        },
      })),

    React.createElement('p', {
      'data-testid': 'qr-scanner-hint',
      style: { margin: 0, padding: '10px 16px 14px', fontSize: 13, opacity: 0.85 },
    }, error ?? hint)),

    error !== null
      ? React.createElement('p', {
        'data-testid': 'qr-scanner-error',
        role: 'alert',
        style: {
          margin: 0, padding: '10px 16px', fontSize: 13, background: 'rgba(220,60,60,0.18)',
        },
      }, error)
      : null,
  )
}
