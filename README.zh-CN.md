# cline2dsh

Cline 免费模型 → DeepSeek Harness (DSH)。一个 DSH 原生 `LlmAdapter` 插件：用本机已登录的 Cline 桌面版账号令牌，直接流式调用 Cline 后端（`api.cline.bot/api/v1`），**只暴露免费模型**（`:free` 后缀）。

架构参考 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（native adapter 模式），Wire 层复用 DSH 自带的 pi-ai openai-completions 实现。

## 工作原理

1. **凭据与身份**：每次请求现读 Cline 桌面版的本地凭据文件（`~/.cline/data/settings/providers.json`，mtime 缓存），拿 `accessToken`（Bearer）和 `accountId`（`clineUserId` 头），并带上 Cline 客户端身份头（`X-CLIENT-TYPE: cline-sdk` 等，`CLINE_CLIENT_TYPE`/`CLINE_CLIENT_VERSION` 环境变量可覆盖）。`cline-free/*` 前缀的模型在后端按客户端身份放行——只带 Bearer 会 403 "only available via Cline product surfaces"。插件**从不自己刷新令牌**——WorkOS 的 refreshToken 是轮换式，插件自刷会把桌面版踢下线；桌面版开着时会自动续期。
2. **免费模型来源**（并集，2026-10-04 实测 21 个）：
   - Cline 推广免费舰队：`GET /api/v1/ai/cline/recommended-models` 的 `free` 桶（`cline-free/deepseek-v4.1-flash`、`stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash`、`cline-free/muse-spark-1.3-contributor`）；
   - OpenRouter 通道：`GET /models` 里带 `:free` 后缀的 17 个。
   - `clinePass` 桶（14 个）需要 Cline Pass 订阅（无订阅 403 ENTITLEMENT_ERROR），默认不暴露，`includeClinePass: true` 可开。
3. **模型目录**（三级回退）：live（上面两源并集）→ 7 天磁盘缓存（`~/.cline2dsh/cache/catalog.json`）→ 编译期静态名单。附带 OpenRouter 公开元数据补全上下文窗口/图片输入（尽力而为，失败不影响目录）。
4. **流式看门狗**：首事件 30s / 正文空闲 120s 双窗口，防止上游静默挂死回合。

## 安装

要求：DSH ≥ 0.1.7、Node.js ≥ 20、Cline 桌面版已登录。

```sh
# 从 npm（发布后）
dsh plugin --profile web add cline2dsh

# 或从源码
git clone https://github.com/lfapex/cline2dsh.git
cd cline2dsh && npm install && npm run build
dsh plugin --profile web add file:$PWD
```

桌面版（desktop profile）把 `--profile web` 换成 `--profile desktop`。装完重启 profile，模型选择器出现 `cline2dsh` provider。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: cline2dsh
      name: 'cline2dsh'
      config:
        freeOnly: true            # 只暴露免费模型（默认 true）
        includeClinePass: false   # Pass 桶需订阅，默认关
        refreshSeconds: 300       # 目录刷新周期
        baseURL: https://api.cline.bot/api/v1
        credentialsPath: ''       # 留空 = ~/.cline/data/settings/providers.json
```

## 排障

- 健康快照：`~/.cline2dsh/cache/catalog.json`（模型目录缓存）。
- 日志报 `CLINE_NOT_LOGGED_IN` / `CLINE_NOT_INSTALLED` → 打开 Cline 桌面版登录一次。
- 请求 401 → 访问令牌过期，打开 Cline 桌面版让它自动刷新，然后继续用。
- 日志报 429 → Cline 免费额度限流（与桌面版共享配额）。

## 已知限制

- 消耗的是你 Cline 账号的免费额度，与 Cline 桌面版共享，并非无限量。
- 令牌过期后需要打开一次 Cline 桌面版（插件故意不自刷新，见"工作原理"）。
- 上游若增加请求签名/设备校验会失效。

## License

MIT
