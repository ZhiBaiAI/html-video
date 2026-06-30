---
name: frame-wechat-ai-dispatch
zh_name: "微信 AI 调度帧"
en_name: "WeChat AI Dispatch Frame"
description: "Warm-white WeChat ecosystem distribution slide: lede, insight rows, paper grid, mono labels, route legend, service-node map, blue AI hub, green matched dispatch line, metrics, source note, and export-safe CSS motion."
zh_description: "微信生态分发/AI 调度说明页：说明正文、关键点、暖白纸面网格、mono 标签、状态图例、服务节点图、蓝色 AI hub、微信绿匹配线路、指标条、来源脚注和可导出 CSS 动效。"
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 0
recommended: 7
tags: ["wechat", "ai", "dispatch", "distribution", "system", "diagram", "grid", "chinese"]
example_id: sample-frame-wechat-ai-dispatch
example_name: "微信 AI 调度 · 服务匹配"
example_format: markdown
example_tagline: "暖白工程网格 + 微信绿调度高亮 + 蓝色 AI hub"
example_desc: "解释从搜索分发到 AI 主动调度服务的完整产品机制页"
od:
  mode: video
  surface: video
  scenario: video
  featured: 0
  preview:
    type: html
    entry: source/index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the WeChat AI Dispatch Frame to explain an AI service-routing model. Fill the full content system: header, section marker, two-line headline, explanatory lede, user intent pill, three insight rows, route legend, AI hub, four service candidates, one matched service, three metrics, source/status note, and bottom transformation line. Keep the warm paper grid, black technical hairlines, blue AI hub, and a single WeChat-green matched route. Animate the rule draw, node reveal, hub pulse, metric reveal, and matched dispatch highlight."
  example_prompt_i18n:
    zh-CN: "用「微信 AI 调度帧」解释 AI 服务路由模型。补齐完整内容系统：顶部标题、章节标签、两行主标题、说明正文、用户意图框、三条关键点、状态图例、AI 中心节点、四个候选服务、一个命中服务、三项指标、来源/状态脚注和底部转译线。保留暖白纸面网格、黑色工程细线、蓝色 AI 中心节点和一条微信绿匹配线路。动效保留线条绘制、节点显现、hub 呼吸、指标显现和匹配线路高亮。"
---

【模板：微信 AI 调度帧 (WeChat AI Dispatch)】

【意图】解释“用户意图 → AI hub → 多服务候选 → 命中服务 → 结果履约”的调度/分发机制。适合微信生态、小程序、agent 调度、服务路由、AI 搜索分发改造、产品策略页和架构机制拆解页。

【画布】1920×1080, 16:9。暖白纸底 `#F5F7F1`，全画布浅工程网格。主内容是一个内框面板，左侧承载叙事和关键点，右侧承载服务路由图，底部保留“过去模式 → 新模式”的大字转译线。

【视觉语言】
- 底色：暖白/浅灰纸感，不使用大面积渐变。
- 线条：黑色 1-4px hairline，所有结构靠线框、分割线、连接线组织。
- 强调色：微信绿 `#159C63` 只用于 section marker、标题第二行、matched 节点、命中线路、底部关键词。
- 次强调：蓝色 `#315F9F` 只用于中心 AI hub。
- 字体：系统 sans + mono；中文不做 uppercase、不拉负字距。

【基础内容元素】
- **Header**：左侧项目/主题名，右侧 `DISTRIBUTION SYSTEM · 2026` 一类 mono 系统标签。
- **Section marker**：`02 / AI DISPATCH` 这种序号 + 英文功能名，使用微信绿和短横线。
- **Headline + lede**：最多两行大标题，第二行绿色；下方一条 1 句说明正文，补足参考图里缺失的解释层。
- **Intent pill**：用户意图短句，黑色圆角线框。
- **Insight rows**：三条紧凑说明行，推荐 `INTENT / CONTEXT / ACTION` 或 `INPUT / ROUTE / OUTPUT`。
- **Route legend**：`IDLE / MATCHED / AI HUB`，用于解释线条和节点状态。
- **Network map**：中心 AI hub + 四个普通服务节点 + 一个绿色命中节点 + badge。
- **Metric strip**：三项小指标，放在右侧图底部，补足“为什么命中”的证据层。
- **Panel note**：来源、页码、状态，例如 `SOURCE: PRODUCT STRATEGY DRAFT / PAGE 02 / 06 / STATUS: CONCEPT MODEL`。
- **Bottom transformation line**：`搜索分发 → AI 调度` 这种模式转换总结。

【动效时间轴，默认 6s】
- 0.25s：顶部黑线 scaleX 绘制。
- 0.5s：header 淡入上移。
- 0.75s：主面板淡入，左/右分栏线绘制。
- 1.18s：section marker、标题逐行进入。
- 1.3s：AI hub 放大进入并开始轻微呼吸。
- 1.65s 起：四个服务节点依次显现，灰色连接线绘制。
- 2.22s：matched 节点进入，绿色命中线路绘制。
- 2.58s：AI SELECTED badge 弹入。
- 2.72s：指标条和来源/状态脚注显现。
- 2.35s 起：底部“搜索分发 → AI 调度”淡入，箭头滑入。

【内容纪律】
- headline 最多 2 行，第二行自动绿色；建议一行现状/主体，一行变化/机制。
- services 固定四个普通候选节点，matched_service 单独高亮。
- prompt 是用户意图短句，保留引号或短语感，不要写成长句。
- lede 和 insights 负责补解释，避免把所有信息挤进主标题。
- metrics 放证据或路由状态，不要写长句。
- 不放真实 WeChat logo；只用文字和抽象 hub，避免官方背书感。
- 动效全部是 CSS keyframes，导出 MP4/WebM 时应保留。
