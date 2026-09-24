# CUSTOMER PWA + MERCHANT CONTACT — Phase 1 实施计划

## 范围与基线

- 基线：`main` 的 `67bc6b3f9471f18e684b78cb2c414658a7a6ee22`。
- 实施位置：隔离 worktree `feature/customer-pwa-merchant-contact-phase1`；绝不在原始脏 worktree 开发。
- 本期仅做 PWA、公开商家联系方式、顾客顶部联系栏及可信 owner 商家资料设置。
- 明确不做：顾客自助查看/改期、12 小时规则、员工头像、Logo 上传、前台拖动改期、支付、OTP/SMS 行为变更。
- 不改变 `/api/booking/*`、`/api/appointments-db`、`/api/staff/appointments` 或既有 PII 授权策略。

## 交付内容

### PWA

1. 新增 manifest，使用内置、无客户资料的 GG 默认 SVG 图标；`display: standalone`、适当的主题色和可审查 start URL/scope。
2. 在预约页及会员页提供 manifest、theme-color、Apple Web App 元数据；注册 service worker。
3. worker 仅缓存公共静态资源与无 PII 的离线页；`/api/**`、后台、staff、会员私密响应一律 network-only，绝不写入 Cache Storage。
4. Android Chrome 与 iOS/iPadOS Safari 可添加到主屏幕；standalone 启动无商家上下文时显示安全提示，不回退到其他店。

### 顾客商家联系栏

预约页和会员页复用同一顶部栏，显示店名、电话、WhatsApp、会员入口与预约入口。

- 无公开电话或 WhatsApp 时隐藏该按钮。
- 电话由规范化号码生成 `tel:`；WhatsApp 由服务端生成 `https://wa.me/<digits>`；所有动态文字使用 `textContent`，外链强制 HTTPS 与 `noopener noreferrer`。
- 手机和 iPad 的交互控件最小 44px；中文/英文词条进入共享 i18n。
- 仅请求公开 DTO，不显示 customer、owner、staff 的私人电话、email、notes、账户或内部媒体 key。

### 店铺资料设置与 API

在既有每店一行的 `shop_customer_settings` 中增加：

- `public_contact_phone`
- `public_whatsapp_phone`
- `public_website_url`
- `public_instagram_url`

新 migration 包含只读 preflight、事务 schema、只读 verification 和 rollback SQL。字段 nullable，默认不回填；不修改预约、客户、owner membership 或员工数据。schema migration 使用 `BEGIN`、`SET LOCAL lock_timeout='5s'`、`SET LOCAL statement_timeout='30s'`，重复执行安全。

接口：

- `GET /api/customer/public-config?shopSlug=`：按活动 shop slug 返回严格白名单公开资料，`Cache-Control: no-store`，拒绝 `shopId` 等身份参数。
- `GET /api/owner/customer-site-settings`：可信 owner session 读取本店资料，`no-store`。
- `PATCH /api/owner/customer-site-settings`：由 `req.ownerAuth.shopId` 限定本店，字段 allowlist、电话/URL 严格校验、same-origin 校验与 `no-store`。

权限：`owner`、`manager`、`admin` 均可编辑（本期按产品要求）；`front_desk` 只读；staff/customer/匿名禁止。全部 SQL 以可信 session `shop_id` 为范围，禁止客户端提交/切换 `shopId`。

## 测试与验收

- migration first run、second run、schema drift、rollback guard、两店隔离。
- public DTO 无 PII，非法 shop/跨店参数拒绝；owner/manager/admin 可更新，front_desk 只读，staff/匿名拒绝；电话、WhatsApp、HTTPS URL 输入校验。
- 顾客顶部栏在有/无联系方式、中文/英文、长店名、手机/iPad 视图下可用，所有按钮达到 44px。
- manifest/service worker 审查与自动化契约：不缓存 API/private pages，离线页不含 PII，standalone 元数据存在。
- 回归 `/api/booking/*`、可信 owner 完整电话、staff 电话掩码、legacy booking read routes 410。
- 本地 PostgreSQL 17 preflight 成功后运行专项测试、完整串行测试两轮和 `git diff --check`；不得访问 Production、部署或合并 main。

## 后续阶段

- Phase 2：顾客仅查看本人预约、严格超过 12 小时的自助改期、服务端原子防撞/技能/排班/多租户校验与审计。
- Phase 3：员工头像安全上传/展示，以及前台/老板端更丰富的改期交互。
