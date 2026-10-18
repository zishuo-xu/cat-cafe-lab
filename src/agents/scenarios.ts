/**
 * 演示场景：猫猫们的台词、交接卡、review 结论都在这里。
 *
 * 约定：
 * - beats 按 (stage, cat) 播放，一个 beat 一个 turn；
 * - 同一 (stage, cat) 下连续的 handoff / artifact 会在一次 think 里一起交付
 *   （比如 planning 时宪宪一次发两张卡、working 时金渐层一次交「实现稿 + 交接卡」）；
 * - beat 上的 fault 是演示埋点，mock brain 会把它透传到对应的 handoff turn；
 * - 台词中文、克制（一条消息 1~4 句）；交接卡按 what / why / tradeoff /
 *   openQuestions / nextAction 五栏写满。
 */

import type { Scenario } from "../domain/types.ts";

export const SCENARIOS: Scenario[] = [
  // ───────────────────────── 场景 1：登录页 · 记住我 ─────────────────────────
  {
    id: "remember_me",
    name: "登录页 · 记住我",
    sampleBrief: "给登录页加一个「记住我」勾选框，7 天内免登录。",
    tags: ["登录", "记住我", "token", "login", "remember", "auth", "免登录", "cookie"],
    beats: [
      {
        stage: "intake",
        cat: "xianxian",
        turn: {
          kind: "message",
          text: "收到——{{brief}}。能做，但先钉两件事：token 存在哪、7 天到了谁负责清；再把活拆成设计和实现两张卡。",
          delayMs: 420,
        },
      },

      // ── planning：先接住需求，再一次发两张五栏交接卡 ──
      {
        stage: "planning",
        cat: "xianxian",
        turn: {
          kind: "message",
          text: "风险我摆桌上了，活拆两张卡：烁烁管勾选框的状态和文案，金渐层管后端 token。谁有异议，现在说。",
          delayMs: 420,
        },
      },
      {
        stage: "planning",
        cat: "xianxian",
        turn: {
          kind: "handoff",
          to: "shuoshuo",
          text: "烁烁，先你这边。勾选框不是画个方块，它得说清楚「这台设备以后不用再登」。",
          card: {
            what: "设计登录页「记住我」：默认态、勾选与取消的文案、首次登录和再次进入两种状态下的显示规则；交一张状态图和最终文案。",
            why: "7 天免登录是拿安全换方便，用户得一眼看懂自己在换什么；文案含糊会被当成默认勾选，投诉和误用都会来。",
            tradeoff:
              "默认勾选转化率高，但违背预期，无障碍也站不住；我倾向默认不勾，用一句辅助说明解释收益，接受一点转化损失。",
            openQuestions: [
              "勾上后要不要在登录按钮下方提示「本设备 7 天内免登录」？",
              "再次进入登录页时，勾选框保持上次的选择还是复位？",
              "取消勾选只清本设备，还是清掉所有设备的 remember-me？",
            ],
            nextAction: "今天内出状态图 + 文案，直接 @ 我；拿不准的先按「默认不勾」走，别自己拍。",
          },
          delayMs: 480,
        },
      },
      {
        stage: "planning",
        cat: "xianxian",
        turn: {
          kind: "handoff",
          to: "jinjianceng",
          text: "金渐层，后端归你。先别急着写，把过期和吊销这两条想清楚再动手。",
          card: {
            what: "实现 remember-me token 的签发、校验、过期与吊销：登录成功后按勾选状态决定是否下发长期凭证，校验通过就跳过登录；退出时要能吊销单台设备。",
            why: "不写过期的凭证等于永久通行证，不做吊销用户退出也停不掉；这两条是底线，不是优化项。",
            tradeoff:
              "cookie 还是 localStorage：cookie 能设 HttpOnly 和 SameSite，抗 XSS 更好、跨域要多配；localStorage 好接但脚本能读。选 HttpOnly cookie，接受多配一处。",
            openQuestions: [
              "7 天从登录算，还是从最后一次使用算？",
              "token 存数据库，还是签名 token 加黑名单？",
              "同一账号多设备登录要不要互踢？",
            ],
            nextAction: "先出后端方案 + diff 骨架，完成后把交接卡 @ 砚砚 走 review，别直接合。",
          },
          delayMs: 480,
        },
      },

      // ── working：设计稿 + 实现稿 ──
      {
        stage: "working",
        cat: "shuoshuo",
        turn: {
          kind: "artifact",
          text: "设计稿交了：状态图加三段文案。勾选这件事，说白了是把「我信这台设备」讲成人话。@宪宪 措辞你过一眼。",
          mentions: ["xianxian"],
          artifact: {
            kind: "design",
            title: "登录页 · 记住我 交互与文案 v1",
            body: [
              "状态图",
              "未勾选 --点--> 已勾选 --点--> 未勾选",
              "登录成功（已勾选） → 进入首页，7 天内再次打开直接进",
              "登录成功（未勾选） → 关掉浏览器后需要重新登录",
              "",
              "文案",
              "标签：记住我（本设备 7 天内免登录）",
              "辅助说明：只在这台设备上生效，公共电脑别勾。",
              "取消勾选：已清除本设备的免登录状态。",
            ].join("\n"),
          },
          delayMs: 520,
        },
      },
      {
        stage: "working",
        cat: "jinjianceng",
        turn: {
          kind: "artifact",
          text: "v1 通了：cookie 下发、校验、退出吊销都在。能跑，但我知道有个坑，先交出来让砚砚看。",
          artifact: {
            kind: "patch",
            title: "remember-me 后端实现 v1",
            body: [
              "diff 摘要",
              "+ POST /api/auth/login  body.rememberMe → 签发 rm_token",
              "+ middleware：校验 rm_token，命中则跳过登录",
              "+ POST /api/auth/logout → 删除 rm_token",
              "+ 表 rm_token：user_id / token_hash / created_at",
              "自测：登录 → 关浏览器 → 重开，直进首页；退出后再开需要登录。",
            ].join("\n"),
          },
          delayMs: 520,
        },
      },
      {
        stage: "working",
        cat: "jinjianceng",
        turn: {
          kind: "handoff",
          to: "yanyan",
          text: "砚砚，卡贴这儿了，过期和并发那两块重点帮我盯一下。",
          card: {
            what: "review remember-me 后端 v1：token 签发/校验/吊销链路、过期策略、同账号并发登录下的覆盖行为。",
            why: "这块写错就是长期凭证泄漏；我看不出自己的盲区，需要外部眼睛。",
            tradeoff: "数据库存 hash、单条 token 覆盖旧 token，简单，但多设备会互踢；先接受。",
            openQuestions: ["7 天固定过期，还是每次使用自动续？", "多设备并存现在要不要支持？", "token 轮换要做吗？"],
            nextAction: "按 blocker / minor 编号回我，我改完出 v2 再交接。",
          },
          delayMs: 460,
        },
        // 演示埋点：这张卡写了给砚砚，但没 @，消息不会投递 → 任务卡住，等「催一下」。
        fault: "missed_mention",
      },

      // ── reviewing：砚砚打回 ──
      {
        stage: "reviewing",
        cat: "yanyan",
        turn: {
          kind: "review",
          verdict: "request_changes",
          title: "review · remember-me v1：不通过",
          text: "看完了，不通过。第 1 条，token 表没有过期时间，7 天免登录实际变成了永久免登录；第 2 条，勾选框默认勾选、也没绑 label，读屏用户不知道它在问什么。先改，别合。",
          mentions: ["jinjianceng"],
          findings: [
            {
              severity: "blocker",
              title: "token 没有过期时间，7 天免登录变成永久免登录",
              detail:
                "rm_token 只有 created_at，没有 expires_at，middleware 也不判断过期。cookie 一旦泄漏就是永久有效，只有手动退出才能吊销。签发时写入 expires_at = 登录时间 + 7 天，校验时过期就清 cookie 并回登录页。",
            },
            {
              severity: "minor",
              title: "勾选框默认勾选，且没有和 label 绑定",
              detail:
                "登录页模板里 checkbox 直接写了 checked，label 没有 for，也没有 aria-describedby。默认不勾，补 label[for] 和辅助说明的关联，让「本设备」能被读屏读出来。",
            },
          ],
          delayMs: 460,
        },
      },

      // ── revising：金渐层出 v2 ──
      {
        stage: "revising",
        cat: "jinjianceng",
        turn: {
          kind: "artifact",
          text: "改完了。过期字段、校验、默认不勾、label 都补了，这次自己先对着 review 意见走了一遍。",
          artifact: {
            kind: "patch",
            title: "remember-me 后端实现 v2",
            body: [
              "diff 摘要（基于 v1）",
              "+ rm_token.expires_at = 登录时间 + 7 天",
              "+ middleware：expires_at < now → 清 cookie，回登录页",
              "+ 登录页：checkbox 默认不勾，label[for] + aria-describedby",
              "+ logout：删除当前设备的 token",
              "自测：v1 的三条 finding 逐条复验通过。",
            ].join("\n"),
          },
          delayMs: 520,
        },
      },
      {
        stage: "revising",
        cat: "jinjianceng",
        turn: {
          kind: "handoff",
          to: "yanyan",
          text: "v2 交接，@砚砚 只改了你圈的那两条，其他没动，方便你比对。",
          card: {
            what: "review remember-me v2：只针对 v1 的 blocker 和 minor 改动（过期字段与校验、勾选框默认态与无障碍），其余链路保持不变。",
            why: "只动被点名的部分，review 面积小；扩大范围就要重跑一遍自测。",
            tradeoff: "固定 7 天过期简单、可预期；滑动续期体验更好，但会把「7 天」变成看不见的承诺，这版先不做。",
            openQuestions: ["多设备并存什么时候做？", "滑动续期要不要排进下一版？"],
            nextAction: "确认 blocker 关掉、minor 收掉，我就等宪宪落决策。",
          },
          delayMs: 460,
        },
      },

      // ── reviewing：通过 ──
      {
        stage: "reviewing",
        cat: "yanyan",
        turn: {
          kind: "review",
          verdict: "approve",
          title: "review · remember-me v2：通过",
          text: "这版可以。第 1 条过期和校验都在，blocker 关掉；第 2 条默认不勾、label 也补了，minor 收掉。approve，剩下交给宪宪记。",
          mentions: ["xianxian"],
          findings: [],
          delayMs: 460,
        },
      },

      // ── done：宪宪落决策 + 教训 ──
      {
        stage: "done",
        cat: "xianxian",
        turn: {
          kind: "decision",
          text: "收工。决策和教训各记一条进共享记忆，下次谁再提 remember-me 相关需求，直接接着往下走。",
          artifact: {
            title: "决策 · remember-me v1",
            body: [
              "做了什么：登录页「记住我」，7 天内免登录",
              "最终方案：HttpOnly cookie + 数据库存 token hash；签发时写 expires_at（固定 7 天，不滑动）；退出吊销单设备",
              "默认态：勾选框默认不勾，文案限定「本设备」",
              "review：1 blocker（无过期时间）+ 1 minor（默认勾选/无障碍），v2 通过",
              "未做：多设备并存、滑动续期、token 轮换，留给后续",
            ].join("\n"),
          },
          memory: [
            {
              kind: "decision",
              title: "remember-me 用 HttpOnly cookie，固定 7 天过期，默认不勾选",
              body: "登录页「记住我」：签发 rm_token 时写入 expires_at = 登录时间 + 7 天，固定过期、不做滑动续期；HttpOnly + SameSite cookie，数据库只存 token hash；勾选框默认不勾，文案限定「本设备」。",
              tags: ["remember_me", "remember-me", "auth", "token", "security", "cookie"],
            },
            {
              kind: "lesson",
              title: "长期凭证先写 expires_at，再谈体验",
              body: "review 凭证相关实现时，先看有没有过期时间和吊销路径，再看体验优化；没有过期时间的「记住我」等于永久通行证。",
              tags: ["review", "security", "token", "auth", "lesson"],
            },
          ],
          delayMs: 500,
        },
      },
    ],
  },

  // ───────────────────────── 场景 2：后台 · 导出 CSV ─────────────────────────
  {
    id: "export_csv",
    name: "后台 · 导出 CSV",
    sampleBrief: "后台加一个导出 CSV 的按钮，只有管理员能下载全量数据。",
    tags: ["导出", "csv", "权限", "后台", "export", "admin", "下载"],
    beats: [
      {
        stage: "intake",
        cat: "xianxian",
        turn: {
          kind: "message",
          // 记忆复用：接着上次 remember-me 的决策往下走，而不是从零开始。
          text: "收到——{{brief}}。能做。先钉两件事：管理员怎么判定、导出跑到一半失败时用户看到什么。",
          delayMs: 420,
        },
      },

      // ── planning：先接住需求（引用上次决策），再一次发两张卡 ──
      {
        stage: "planning",
        cat: "xianxian",
        turn: {
          kind: "message",
          // 记忆复用：宪宪直接把上次 remember-me 的决策搬到这张桌上。
          text: "接着上次的记忆：{{memory}}。这次导出沿用同一套权限边界，不新起一套。卡两张：烁烁做按钮和三态，金渐层做异步导出和权限。",
          delayMs: 420,
        },
      },
      {
        stage: "planning",
        cat: "xianxian",
        turn: {
          kind: "handoff",
          to: "shuoshuo",
          text: "烁烁，导出按钮和进度得让人看见「它在跑」，不然用户会连点五次。",
          card: {
            what: "设计后台「导出 CSV」按钮与三种状态：空闲、导出中（排队 / 生成中）、失败可重试；给出按钮文案和失败提示。",
            why: "导出是慢操作，没反馈就会被重复点击，最后生成一堆重复任务；失败态不说人话，用户只能找客服。",
            tradeoff: "实时进度条更准，但要额外通道；先用轮询加阶段性文案（排队中 / 生成中 / 可下载），够用、实现轻。",
            openQuestions: ["导出中允许取消吗？", "完成后提示停留多久？", "移动端要不要支持导出？"],
            nextAction: "出按钮和三态文案，@ 我确认后直接给金渐层用。",
          },
          delayMs: 480,
        },
      },
      {
        stage: "planning",
        cat: "xianxian",
        turn: {
          kind: "handoff",
          to: "jinjianceng",
          text: "金渐层，导出归你。权限校验别只拦在前端，也别只拦在路由上。",
          card: {
            what: "实现后台导出 CSV：创建异步导出任务、按管理员权限过滤数据、生成文件并给下载地址；非管理员只能导出自己可见的范围，越权直接 403。",
            why: "全量数据能绕过权限导出，等于把库复制一份；同步生成遇上大表会拖死请求，所以走异步任务。",
            tradeoff: "同步实现快但会超时；异步要加任务表和轮询，复杂度换稳定。选异步，文件 24 小时过期。",
            openQuestions: [
              "「管理员」是全局角色，还是按空间授权？",
              "导出列要不要允许用户自选？",
              "文件落本地盘还是对象存储？",
            ],
            nextAction: "先出接口 + 权限校验骨架，完成后 @ 砚砚 review。",
          },
          delayMs: 480,
        },
      },

      // ── working：设计三态 + 后端实现 ──
      {
        stage: "working",
        cat: "shuoshuo",
        turn: {
          kind: "artifact",
          text: "UI 稿给了：按钮加三态文案。导出的等待感要像等咖啡，别像等电梯。@宪宪 措辞你看下。",
          mentions: ["xianxian"],
          artifact: {
            kind: "design",
            title: "后台导出 · 按钮与三态 v1",
            body: [
              "状态",
              "空闲：[导出 CSV] 可点",
              "导出中：按钮禁用，显示「正在生成（排队中 / 生成中）…」",
              "失败：提示「生成失败，点这里重试」，保留上次参数",
              "成功：提示「已生成，24 小时内可下载」+ [下载] 按钮",
              "",
              "文案",
              "按钮：导出 CSV",
              "排队中：前面还有任务，大概 30 秒。",
              "生成中：正在打包，别关页面，好了会提示。",
              "失败：这次没生成成功，点重试就行，参数还在。",
            ].join("\n"),
          },
          delayMs: 520,
        },
      },
      {
        stage: "working",
        cat: "jinjianceng",
        turn: {
          kind: "artifact",
          text: "后端 v1 通了：任务表、异步生成、下载地址都有。能跑，但权限那块我知道有个坑，交 review。",
          artifact: {
            kind: "patch",
            title: "后台导出 CSV 实现 v1",
            body: [
              "diff 摘要",
              "+ POST /api/export { scope, format: \"csv\" } → 创建导出任务",
              "+ GET  /api/export/:id → 状态 / 下载地址",
              "+ worker：分页读数据 → 写 CSV → 落盘 exports/{id}.csv",
              "+ 权限：路由层 requireAdmin 中间件",
              "自测：管理员导出全量 OK；普通账号返回 403。",
            ].join("\n"),
          },
          delayMs: 520,
        },
      },
      {
        stage: "working",
        cat: "jinjianceng",
        turn: {
          kind: "handoff",
          to: "yanyan",
          text: "v1 交接，@砚砚 重点看权限判断和 CSV 生成这两段。",
          card: {
            what: "review 导出 CSV v1：权限校验位置、分页读库、CSV 字段转义、下载链接有效期。",
            why: "一次全量导出等于给数据开一扇门；字段转义错了还会被 CSV 注入。",
            tradeoff: "权限只放路由中间件最省事，但 service 被别处调用就绕过了；我倾向 service 层再兜一次，接受一点重复。",
            openQuestions: ["下载链接要不要一次性签名？", "超大导出要不要分片？"],
            nextAction: "按 blocker / minor 编号回我，我出 v2。",
          },
          delayMs: 460,
        },
      },

      // ── reviewing：砚砚打回 ──
      {
        stage: "reviewing",
        cat: "yanyan",
        turn: {
          kind: "review",
          verdict: "request_changes",
          title: "review · 导出 CSV v1：不通过",
          text: "不通过。第 1 条，权限只拦在路由上，worker 拿任务直接跑，校验形同虚设；第 2 条，CSV 字段没做转义，一个逗号就能把列错开。改完再交。",
          mentions: ["jinjianceng"],
          findings: [
            {
              severity: "blocker",
              title: "权限只在路由层校验，worker 侧可以绕过",
              detail:
                "requireAdmin 挂在路由上，worker 只认 taskId；一旦有内部调用或任务重放，非管理员也能触发全量导出。service 层必须再判一次 scope，worker 读到的也必须是已授权的任务快照。",
            },
            {
              severity: "minor",
              title: "CSV 字段没有转义，特殊字符会串列",
              detail:
                "现在直接 join(',')，字段里有逗号、引号、换行就会错列，还可能被 CSV 注入。按 RFC 4180 用双引号包裹并转义内部引号，下载时加 UTF-8 BOM 防 Excel 乱码。",
            },
          ],
          delayMs: 460,
        },
      },

      // ── revising：v2 ──
      {
        stage: "revising",
        cat: "jinjianceng",
        turn: {
          kind: "artifact",
          text: "v2 改完：权限在 service 层再判一次，CSV 每个字段都按 RFC 4180 转义。这次我拿普通账号真跑了一遍。",
          artifact: {
            kind: "patch",
            title: "后台导出 CSV 实现 v2",
            body: [
              "diff 摘要（基于 v1）",
              "+ service.exportCsv：再次校验 scope，越权抛 403",
              "+ worker 只接受已授权的任务快照",
              "+ CSV 写入：字段双引号包裹 + 内部引号转义 + 表头带 UTF-8 BOM",
              "自测：管理员全量 OK；普通账号 403；含逗号 / 换行 / 引号的字段导出后列数正确。",
            ].join("\n"),
          },
          delayMs: 520,
        },
      },
      {
        stage: "revising",
        cat: "jinjianceng",
        turn: {
          kind: "handoff",
          to: "yanyan",
          text: "v2 交接，@砚砚 只动权限校验和 CSV 转义，别的没碰。",
          card: {
            what: "review 导出 CSV v2：service 层权限二次校验、worker 任务快照、CSV 转义与 BOM。",
            why: "只复验被点名的两处，范围小；下载链路没改，不用重看。",
            tradeoff: "权限判两次带来少量重复代码，换来「任何入口都绕不过」；转义走标准实现，性能损失可忽略。",
            openQuestions: ["签名下载链接要不要这版做？", "分片导出要不要排期？"],
            nextAction: "确认 blocker 和 minor 都收掉，我就收尾。",
          },
          delayMs: 460,
        },
      },

      // ── reviewing：通过 ──
      {
        stage: "reviewing",
        cat: "yanyan",
        turn: {
          kind: "review",
          verdict: "approve",
          title: "review · 导出 CSV v2：通过",
          text: "v2 我通过。权限在 service 层兜住了，CSV 转义和 BOM 也验过。放行，宪宪记一条。",
          mentions: ["xianxian"],
          findings: [],
          delayMs: 460,
        },
      },

      // ── done：宪宪落决策 + 教训 ──
      {
        stage: "done",
        cat: "xianxian",
        turn: {
          kind: "decision",
          text: "收工。这次落两条记忆：导出走异步，权限必须在 service 层再判一次。下次再提导出，直接接着走。",
          artifact: {
            title: "决策 · 后台导出 CSV v1",
            body: [
              "做了什么：后台导出 CSV + 权限校验",
              "最终方案：异步导出任务（文件 24 小时过期）；权限在路由与 service 各判一次，worker 只接受已授权任务快照",
              "CSV：RFC 4180 转义 + UTF-8 BOM",
              "review：1 blocker（权限仅路由层）+ 1 minor（CSV 未转义），v2 通过",
              "未做：签名下载链接、分片导出、列自选",
            ].join("\n"),
          },
          memory: [
            {
              kind: "decision",
              title: "后台导出 CSV 走异步任务，权限在 service 层再判一次",
              body: "导出 CSV：创建异步任务，文件 24 小时过期；权限在路由和 service 各判一次，worker 只接受已授权任务快照；CSV 按 RFC 4180 转义并带 UTF-8 BOM。",
              tags: ["export", "csv", "security", "权限", "导出"],
            },
            {
              kind: "lesson",
              title: "权限不能只拦在路由上",
              body: "凡是会被内部调用 / worker 重放的入口，权限必须在 service 层再判一次；路由中间件只负责挡住外部请求。",
              tags: ["review", "security", "权限", "lesson"],
            },
          ],
          delayMs: 500,
        },
      },
    ],
  },
];
