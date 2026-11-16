/**
 * 二维码编码：薄封装官方的 `qrcode-generator`。
 *
 * ## 为什么不再手写
 *
 * 0.4.0 之前这里是自研的 QR 编码器（版本 5-L / 10-L 两档，约 430 行）。
 * 它算得出来，但**版本固定**：`otpauth://` 链接（约 140 字节）永远落在
 * 版本 10（57×57 模块）。配 120px 的显示尺寸就是每模块 2.1px，
 * 手机扫码器普遍要求 ≥4px —— 于是「二维码扫不出来」（真实用户反馈）。
 *
 * 换成 `qrcode-generator`（零依赖，KaZuhiko Arase 的实现，BSD）后可以
 * **按内容取最小版本**：同样 140 字节在 L 级下只需版本 7（45×45），
 * 模块更少意味着同样的显示尺寸下每模块更大、更容易扫中。
 *
 * ## 保留的对外契约
 *
 * `encodeQr` / `QrMatrix` 的形状不变，`QrCode` 组件无需改动。
 *
 * @module dsh-remote-hub/client/panel/qr
 */
import qrcode from 'qrcode-generator'

/** 一个已编码的 QR 矩阵。 */
export interface QrMatrix {
  /** 边长（模块数）。 */
  size: number
  /** `modules[row][col]`，true = 深色。 */
  modules: boolean[][]
  /** 选用的掩码编号（库内部决定，这里只透出实际使用的那个）。 */
  mask: number
}

/**
 * 编码任意文本为 QR 矩阵。
 *
 * 纠错等级取 **M**：比 L 多约 15% 容量开销，但抗污损明显更好，是认证器
 * 扫码场景的常用档位；链接约 140 字节时落到版本 8（49×49）。
 *
 * @param text - 待编码文本（UTF-8）。
 * @returns 矩阵。
 * @throws 内容超出 QR 容量时（调用方应捕获并提示手动输入）。
 */
export function encodeQr(text: string): QrMatrix {
  // 0 = 自动选最小能装下的版本；'M' = 中等纠错。
  const code = qrcode(0, 'M')
  code.addData(text, 'Byte')
  code.make()

  const size = code.getModuleCount()
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false))

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      modules[row]![column] = code.isDark(row, column)
    }
  }

  // 库不公开选中的掩码编号；对外字段保留为 0（调用方从不依赖它的具体值）。
  return { size, modules, mask: 0 }
}

/**
 * 兼容旧调用点的别名：内容超长时由库自动升级版本，不存在「宽模式」之分。
 *
 * @param text - 待编码文本。
 * @returns 矩阵。
 * @throws 内容超出 QR 容量时。
 */
export function encodeQrWide(text: string): QrMatrix {
  return encodeQr(text)
}
