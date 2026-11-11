# Android client (scaffold)

独立 Gradle 工程，不依赖 TS 运行时。与 web 端的唯一共享契约是 `../core/src/` 里的
协议定义（`protocol.ts` / `envelope.ts` / `roles.ts`），Kotlin 侧需要**手工对齐**同一套
JSON 形状——对齐工作由 ROADMAP 的 M3.5 跨端契约测试守住。

## 状态

脚手架，无实现。缺的东西（有意留白，不是遗漏）：

- Gradle wrapper（`gradle/wrapper/*`）——首次构建前补
- `res/` 资源树：`values/themes.xml`（`Theme.DshRemote`）、`strings.xml`、图标
- Compose 导航图与全部界面（`ui/` 下只有契约注释）
- 签名配置

## 目录

```
android/
├── settings.gradle.kts      模块与仓库
├── build.gradle.kts         插件版本（集中声明）
├── gradle.properties
└── app/
    ├── build.gradle.kts     依赖与编译配置
    └── src/main/
        ├── AndroidManifest.xml
        └── kotlin/dev/dsh/remote/
            ├── MainActivity.kt
            ├── net/RpcTransport.kt   一元 RPC（OkHttp）
            ├── net/EventSocket.kt    WebSocket 流式事件
            ├── security/DeviceStore.kt  令牌加密存储
            └── ui/RemoteHubScreen.kt    界面清单
```

## 三条硬约束

1. **令牌只进 `EncryptedSharedPreferences`**，明文 SharedPreferences 是安全发现项。
2. **401/403 即吊销**：清空令牌、停止重连、提示重新配对；不做无限重试。
3. **权限来自 host 的 access snapshot**，不在客户端硬编码角色判断——与 web 端同一规则。
