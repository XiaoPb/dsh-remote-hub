#!/usr/bin/env python3
"""
远端真实浏览器验证：Firefox Marionette 驱动真实 DSH 页面，验证整机接管。

Marionette 协议格式：[type, id, error, result]
  - 握手：{"applicationType":"gecko","marionetteProtocol":3}
  - 所有命令返回 [1, id, null, {value: ...}]

用法：python3 verify-page-marionette.py <dsh-url>
"""
import json
import socket
import sys
import time

PORT = 2828


class Marionette:
    """极简 Marionette 客户端。"""

    def __init__(self, port=PORT, timeout=60):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.msg_id = 0
        self._read_frame()  # 握手欢迎帧

    def _read_frame(self):
        """按 `len:json` 读一帧。"""
        buf = b""
        while True:
            head, sep, rest = buf.partition(b":")
            if sep and head.isdigit() and len(rest) >= int(head):
                return json.loads(rest[:int(head)])
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("marionette closed")
            buf += chunk

    def cmd(self, name, params=None):
        """执行命令，返回 [1, id, null, result] 的 result。"""
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, name, params or {}]).encode()
        self.sock.sendall(f"{len(payload)}:".encode() + payload)
        msg = self._read_frame()
        if len(msg) < 4:
            raise RuntimeError(f"{name}: malformed {msg}")
        if msg[2]:
            raise RuntimeError(f"{name}: {msg[2]}")
        return msg[3]

    def close(self):
        try:
            self.cmd("WebDriver:DeleteSession")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


CHECK_SCRIPT = """
const t = globalThis.__DSH_TRANSPORT__ || null;
let raw = null;
try { raw = localStorage.getItem('remote-hub.mode'); } catch (e) {}
let mode = null, origin = null;
if (raw) { try { const p = JSON.parse(raw); mode = p.mode; origin = p.origin; } catch (e) {} }
return JSON.stringify({
  hasTransport: t !== null,
  hasFetch: typeof (t && t.fetch) === 'function',
  hasWs: typeof (t && t.createWebSocket) === 'function',
  streamBaseUrl: t ? (t.streamBaseUrl || null) : null,
  ownsHost: t ? t.ownsHost === true : null,
  openStream: (t && t.openStream) ? 'present' : 'absent',
  keys: t ? Object.keys(t) : [],
  mode: mode,
  modeOrigin: origin,
  body: (document.body ? document.body.innerText : '').slice(0, 600),
});
"""


def main(url):
    print(f"目标: {url[:70]}")
    m = Marionette()
    try:
        session = m.cmd("WebDriver:NewSession", {"capabilities": {}})
        print(f"session: {session.get('sessionId', '?')[:16]}...")

        m.cmd("WebDriver:Navigate", {"url": url})
        print("已导航，等待页面加载与 carrier 轮询（3×2s）...")
        # 轮询间隔 2s；给足页面加载 + 一次轮询 + reload 的时间
        for _ in range(3):
            time.sleep(2)
            result = m.cmd("WebDriver:ExecuteScript", {
                "script": CHECK_SCRIPT, "args": [],
            })
            value = json.loads(result.get("value", "{}"))
            if value.get("mode") == "cloud" and value.get("hasTransport"):
                break

        print("\n=== 页面运行时状态 ===")
        for key in ("hasTransport", "hasFetch", "hasWs", "streamBaseUrl", "ownsHost", "openStream", "mode", "modeOrigin"):
            print(f"  {key:14}: {value.get(key)}")
        print(f"  keys          : {', '.join(value.get('keys') or [])}")

        body = value.get("body", "")
        print("\n=== 页面文本（前 500 字）===")
        print(body[:500].replace("\n", " | "))

        # 判定：transport 已注入 且 指向远端
        ok = (
            value.get("hasTransport") is True
            and value.get("hasFetch") is True
            and value.get("hasWs") is True
            and value.get("openStream") == "absent"
            and isinstance(value.get("streamBaseUrl"), str)
            and value.get("streamBaseUrl", "").startswith("http")
        )
        print(f"\n结论：{'✅ 整机接管在真实浏览器中生效' if ok else '❌ 未生效'}")
        return 0 if ok else 1
    finally:
        m.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: verify-page-marionette.py <dsh-url>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
