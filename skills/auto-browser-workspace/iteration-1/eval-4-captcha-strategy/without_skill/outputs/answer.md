# 淘宝 & 虾皮(Shopee)消息收集自动化 — 验证码对抗方案

## 一、现状分析：auto-browser 已有的反爬能力

在制定方案前，先盘点 auto-browser 现有能力及其对淘宝/虾皮的覆盖率：

### 已内置的能力

| 能力 | 实现方式 | 对淘宝 | 对虾皮 |
|------|----------|--------|--------|
| **Cloudflare Turnstile 绕过** | 检测 `challenges.cloudflare.com`，60s 内人机鼠标轨迹 + iframe 内点击 checkbox + verify 按钮 | 部分页面有 Cloudflare 前置，可用 | 部分可用 |
| **reCAPTCHA v2 注入** | 通过 2captcha API 获取 token 并注入页面 (`AUTO_BROWSER_CAPTCHA_API_KEY`) | 不适用（淘宝不用 reCAPTCHA） | 不适用（虾皮不用 reCAPTCHA） |
| **图片验证码识别** | 截图 base64 → 2captcha 识别 | 淘宝部分场景有图片验证码，可用 | 虾皮可能触发，部分可用 |
| **Cookie 持久化** | `--cookies-path` 自动加载/保存浏览器 cookie，维持登录态 | **核心武器** | **核心武器** |
| **凭证自动填充** | 检测中文/英文登录表单，从 `credentials.json` 自动填入用户名密码 | 有效 | 有效 |
| **Handoff 机制** | 检测到验证码时自动暂停，转交人工处理，处理后 `resume` 继续 | **关键回退策略** | **关键回退策略** |
| **验证码检测信号** | 检测 `captcha/recaptcha/验证码/人机验证/图形验证码/安全验证` 等关键词 | 能识别到但未必能解决 | 能识别到但未必能解决 |

### 不支持的验证码类型（淘宝/虾皮真正使用的）

| 验证码类型 | 使用场景 | 难度 | auto-browser 现状 |
|------------|----------|------|-------------------|
| **阿里滑块验证码 (Aliyun Captcha)** | 淘宝登录、高频操作、异地登录 | 极高 | **不支持**。这是阿里自研的行为验证，需要轨迹模拟 + 滑块缺口识别 |
| **腾讯验证码 (TCaptcha)** | 虾皮部分地区登录 | 极高 | **不支持**。滑块 + 点选 + 语音组合 |
| **设备指纹检测** | 淘宝全站，通过 `navigator.webdriver`、Canvas fingerprint、WebGL、字体枚举等 | 高 | 部分绕过。Playwright 会暴露 `navigator.webdriver=true`，无内置 stealth 插件 |
| **行为分析** | 淘宝/虾皮分析鼠标轨迹、滚动模式、点击间隔、页面停留时间 | 高 | **仅有基础的 Cloudflare 人机鼠标**，远不及专业反爬要求 |
| **短信验证码** | 淘宝/虾皮异地登录、敏感操作 | 中 | 通过 handoff 机制转人工，不自带短信接收能力 |
| **二次验证（人脸/手势）** | 淘宝高危操作 | 高 | **不支持**，只能 handoff |

---

## 二、推荐方案：分层对抗策略

核心原则：**Cookie 复用 > Handoff 半自动 > 全自动尝试 > 放弃并切换方案**。

### Layer 1（最佳方案）：Cookie 持久化复用 — 全自动，零摩擦

**原理**：淘宝和虾皮的反爬机制主要针对"登录态建立过程"和"新设备首次访问"。一旦完成一次完整登录并持久化 cookie，后续所有任务都可以直接以已登录状态访问，**完全绕过所有验证码环节**。

**操作流程**：

```
第一次（手动辅助）：
  1. --headed 启动有头浏览器
  2. AI 自动填写账号密码
  3. 遇到滑块/短信 → handoff → 你手动完成
  4. 登录成功后继续执行任务
  5. cookies 自动保存到指定路径

后续（全自动）：
  1. --cookies-path 加载已保存的 cookies
  2. 直接进入消息页面（已经是登录态）
  3. 全自动收集消息
  4. 无需任何人工介入
```

**Cookie 保鲜策略（关键）**：
- 淘宝 cookie 有效期通常 1-7 天（取决于账号安全等级）
- 虾皮 cookie 有效期约 24 小时 - 7 天（地区差异大）
- **建议**：每天定时执行一次轻量任务（如访问首页），保持 cookie 活跃，可显著延长有效期
- 监控 cookie 过期信号：页面跳转到登录页、出现 `请登录` 文字 → 触发 handoff 重新登录

### Layer 2（回退方案）：Handoff 半自动模式 — 仅在 cookie 过期时使用

**适用场景**：
- Cookie 过期需要重新登录
- 淘宝/虾皮检测到异常行为，强制要求验证
- 首次配置新账号

**流程**：
```
1. AI 自动导航到登录页
2. AI 从 credentials.json 自动填入用户名密码
3. AI 检测到滑块/短信/二次验证 → 自动触发 handoff
4. 你手动完成验证（几秒到几十秒）
5. resume 命令让 AI 继续执行后续任务
```

**Handoff 触发条件**（auto-browser 已内置）：
- 页面 title 或 visibleText 包含：`captcha`, `验证码`, `人机验证`, `图形验证码`, `安全验证`, `滑块`, `滑动`
- Cloudflare 挑战超过 60s 未通过
- reCAPTCHA 检测到但无 solver 配置
- 检测到二次验证页面（`verification code`, `two-factor`, `authenticator`）

### Layer 3（兜底方案）：全自动尝试 — 仅在简单场景有效

auto-browser 内置的自动化验证码处理对淘宝/虾皮的主要验证码类型（阿里滑块、腾讯验证码）**基本无效**。但以下场景仍可自动处理：
- 简单的图片验证码（配置 2captcha API key）
- 淘宝/虾皮的 Cloudflare 前置页面（如果有的话）
- reCAPTCHA v2（如果站点使用了，需配置 `AUTO_BROWSER_CAPTCHA_API_KEY`）

### Layer 4（终极方案）：当以上都不可行时

如果 cookie 频繁过期、handoff 频率不可接受，考虑：
- **使用真实手机 + Appium/ADB** 对接淘宝/虾皮 App（App 端风控远弱于 Web）
- **对接第三方打码平台**：2captcha、CapSolver 等提供阿里滑块识别的服务，但成功率不稳定（30-70%）
- **使用已经登录的真人浏览器 Profile**：`--profile-path` 指向你日常使用的 Chrome Profile
- **低频操作**：降低采集频率（每小时/每天一次而非实时），减少风控触发概率

---

## 三、淘宝专项策略

淘宝的反爬是业内最强的之一，具体分析：

### 淘宝风控机制

1. **登录阶段**：阿里滑块 (Aliyun Captcha) — 滑动拼图，基于轨迹行为分析
2. **设备指纹**：检测 `navigator.webdriver`、浏览器指纹（Canvas、WebGL、字体）、屏幕分辨率、时区、语言
3. **行为分析**：鼠标轨迹、滚动行为、页面停留时间、点击热区
4. **网络层面**：IP 信誉库、请求频率、Header 一致性
5. **消息页面特有**：高频访问消息列表会触发二次滑块验证

### 淘宝专项建议

```
# 推荐配置：使用自己的 Chrome Profile（最高伪装度）
auto-browser run \
  --goal "访问淘宝消息中心，收集所有未读消息的内容和发送者" \
  --browser-family chrome \
  --executable-path "/usr/bin/google-chrome" \
  --profile-path "$HOME/.config/google-chrome" \
  --cookies-path "./taobao-cookies.json" \
  --headed \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

**为什么用真实 Chrome Profile**：
- 自带已登录的淘宝 session
- 设备指纹完全真实（因为就是你日常使用的浏览器）
- 行为特征自然（历史浏览记录、cookie 积累等）
- 风控系统将其视为"正常用户的另一个标签页"

**如果必须用 Playwright Chromium**（无真实 Profile）：
- 必须 `--headed` 模式（headless 在淘宝 100% 被拦截）
- 建议配置代理 IP（避免同一 IP 频繁访问）
- 降低操作频率（每次操作间加随机延迟 2-5 秒）
- `AGENT_BROWSER_PROXY` 配置住宅代理（淘宝对机房 IP 容忍度极低）

---

## 四、虾皮(Shopee)专项策略

虾皮的风控因地区（台湾/东南亚/拉美）差异很大，针对性分析：

### 虾皮风控机制

1. **登录阶段**：不同地区使用不同验证码
   - 台湾站 (`shopee.tw`)：常见短信验证 + 图片验证码
   - 东南亚站点：Google reCAPTCHA / 图片验证码
   - 部分站点有腾讯验证码 (TCaptcha)
2. **设备指纹**：较轻，但会检测异常登录地点
3. **行为分析**：比淘宝轻，但仍会检测高频请求
4. **App 端优惠**：虾皮 App 端风控远弱于 Web 端

### 虾皮专项建议

```
# 虾皮 Cookie 方案
auto-browser run \
  --goal "访问虾皮卖家中心，收集所有买家消息" \
  --browser-family chrome \
  --executable-path "/usr/bin/google-chrome" \
  --profile-path "$HOME/.config/google-chrome" \
  --cookies-path "./shopee-cookies.json" \
  --headed
```

**虾皮登录注意事项**：
- 部分地区（如台湾）虾皮登录强依赖短信验证，cookie 过期后只能通过 handoff 重新登录
- 建议使用 Chrome Profile + cookie 双保险
- 虾皮消息中心 API 可能有独立的 CSRF token，注意 cookie 中是否包含

---

## 五、消息收集的执行策略

### 架构建议：定时任务 + 状态监控

```
┌─────────────────────────────────────────────┐
│                 Cron / Systemd Timer         │
│            (每天 9:00, 14:00, 20:00)         │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│           健康检查：Cookie 是否有效           │
│       (访问消息页面，检测是否被重定向到登录页)  │
└─────────────────┬───────────────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
    有效 ▼              过期 ▼
┌──────────────┐  ┌──────────────────┐
│ 直接收集消息  │  │ Handoff 重新登录  │
│ (全自动执行)  │  │ → 保存新 Cookie   │
└──────┬───────┘  │ → 继续收集消息    │
       │          └──────────────────┘
       ▼
┌─────────────────────────────────────────────┐
│           提取消息内容 → 持久化存储           │
│     (写入数据库 / 发送到通知渠道 / 导出)      │
└─────────────────────────────────────────────┘
```

### Cookie 有效期监控脚本逻辑

```bash
# 概念：通过快速访问消息页面判断 cookie 是否有效
# 如果页面标题包含"登录"而非"消息"，说明 cookie 已过期
auto-browser run \
  --goal "打开消息页面，检查页面标题是否为 '消息中心' 而非 '登录'，如果是消息页面则直接 finish 并报告 'OK'" \
  --cookies-path "./taobao-cookies.json" \
  --headless \
  --json 2>&1 | jq -r '.resultSummary'
# 输出 "OK" = cookie 有效
# 输出 "handoff" 或包含 "登录" = cookie 过期
```

---

## 六、总结：靠谱程度排序

| 方案 | 对淘宝可靠性 | 对虾皮可靠性 | 人工参与 | 推荐度 |
|------|------------|------------|----------|--------|
| **真实 Chrome Profile + Cookie** | 90%+ | 95%+ | 初次配置 | ★★★★★ |
| **Playwright Chromium + Cookie** | 70% | 85% | 初次登录手动 | ★★★★ |
| **Cookie 过期自动 Handoff** | 依赖人工响应 | 依赖人工响应 | 每次过期 | ★★★ |
| **全自动 2captcha** | 5-20% (阿里滑块支持差) | 10-40% (取决于站点) | 零 | ★★ |
| **Headless Playwright 无 cookie** | <5% (几乎必被拦截) | <10% | 零 | ★ |

**最终推荐**：
1. 使用你自己的 Chrome Profile (`--profile-path`) + cookie 持久化 (`--cookies-path`) 作为主力方案
2. 建立 cookie 过期监控，过期时自动通知你进行 handoff 重新登录
3. 不要指望全自动解决淘宝/虾皮的验证码 — 滑块、设备指纹、行为分析的专业对抗不是 auto-browser 的设计目标
4. 对于纯消息收集（非下单/支付等敏感操作），cookie 方案的成功率远高于其他所有方案之和
