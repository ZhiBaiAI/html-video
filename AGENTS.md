# html-video 项目工作区

> Open-source HTML→Video meta-layer。让本地 coding agent 跨多个渲染 engine（Hyperframes / Remotion / Motion Canvas / Revideo）一站式做 HTML 视频。
> 启动时间：2026-05-26（继 OD / HA / OD-pitch / OD-landing 之后的下一代 nexu-io 开源产品）

## 角色与边界

- **角色**：T9（端口段 **3071-3079**）—— 现有 T1-T8 已分配
- **职责**：html-video 项目的产品定位 / 架构 / engine 适配器 spec / 模板生态 / agent skill 设计 / 文档 / 公开 launch 物料
- **不做**：
  - 跨项目协调（T1 主控的活）
  - OD 主线开发（T5 `open-design` 工作树）
  - 增长策略 / OKR（T2 `opendesign-growth`）

## 产品定位（决策时间线）

- **2026-05-26 启动思路**：Joey 最初以为 Hyperframes 是闭源 SaaS，想做 "HTML 视频开源整合工具"。调研发现 Hyperframes 已经是 Apache-2.0 开源 + 21K★ + agent-native，跟 Joey 设想的产品 1:1 重合。
- **2026-05-26 定位拍板**：放弃"做 HF 杀手"的正面竞争路线，改走 **Meta-aggregator** —— 把 HF / Remotion / Motion Canvas / Revideo 都包成可选 backend，agent 选 engine + 模板 + 一键出片。差异化明确，跟 HF 不正面撞。

### 关键差异化 vs Hyperframes

| 维度 | Hyperframes | html-video |
|---|---|---|
| 渲染引擎 | 单一（GSAP+Puppeteer） | 多引擎 pluggable |
| Authoring 范式 | 单一（HTML+CSS+GSAP） | 跟随 backend（HTML/React/TS-generator 都行） |
| Agent 能力 | 自家 skill | 跨引擎 agent 决策 + skill 注入 |
| 模板生态 | 自家曲库 | 跨生态 curated + 社区贡献 |

## 目录结构

```
html-video/
├── README.md                  公开门面（对外，已立）
├── AGENTS.md                  本文件，内部 working notes
├── LICENSE                    Apache-2.0
├── .gitignore                 通用
├── notes/                     迭代笔记 / RFC 草稿 / 决策记录
├── research/                  竞品调研 / engine spec 草案 / API 探索
└── assets/                    素材（截图 / 草图 / launch 物料）
```

代码骨架（adapter spec、CLI、studio 等）等架构定型后另起 `core/` `adapters/` `cli/` `studio/` 等目录。

## 当前状态（2026-06-17 稳定化：真实渲染 + 模板闭环）

v0.8 之后，项目已经从"协议骨架"推进到可跑的本地闭环：

- ✅ Hyperframes adapter 已接真实渲染链路：Playwright 抓帧 + ffmpeg 编码，单帧/多帧 `exportMp4` 都会产出非空 MP4，不再是占位实现。
- ✅ Remotion adapter 已接入可选增强路径：`frame-data-rollup` 这类数据滚动帧可走 Remotion 原生渲染，其余仍由 Hyperframes 兜底。
- ✅ 模板库当前为 37 个模板；`TemplateRegistry.scan()` 自动扫描 `templates/<id>/template.html-video.yaml`。
- ✅ 已补模板注册质量门槛：scan 时校验必要 metadata、目录 id 一致性、入口文件存在、重复 id；不再静默吞掉坏模板。
- ✅ 已补模板搜索权重：`github stars` / metrics / data / chart 等意图能优先召回数据类模板。
- ✅ smoke 已覆盖单帧真实导出、多帧 content graph + 3 frames + concat 导出，并检查 MP4 非空。
- ⏳ Motion Canvas / Revideo / Manim 仍是 roadmap adapter，不能对外声明已可渲染。
- ⏳ studio 的 graph viewer 现在只读，未来可加可视化编辑（拖节点 / 加边）。

## 历史状态（2026-05-28 v0.8 content-graph + multi-frame）

v0.7 之前的进展见 git log。本节记 v0.8 落地的事 + 还没接的事。

- ✅ `@html-video/content-graph` 新 package：ContentGraph schema（entity/data/text 节点 + sequence/dependency/contrast 边）+ `validate` + `topoSort`（dependency 硬约束 / sequence 软排 / contrast 不参与排序）+ `totalDurationSec`
- ✅ core：`Project` 加 `contentGraphPath` + `frames[]`；`orchestrator` 加 `writeContentGraph` / `readContentGraph` / `writeFrameHtml`；`exportMp4` 多帧路径走 ffmpeg concat（缺 ffmpeg 时报友好错）
- ✅ studio agent：prompt 同时教单帧 fast path + 多帧（\`\`\`json#content-graph + \`\`\`html#&lt;nodeId&gt; 双块协议）；server 解析后自动调 writeContentGraph + writeFrameHtml；无 graph 时回落 v0.7
- ✅ studio UI：frames-strip 切帧 + graph viewer modal（JSON 只读 + 下载）；单帧 fast path 时整条隐藏
- ✅ 已 push `nexu-io/html-video` main（commit `149ace9`）
- ✅ HF upstream 真实 render 已接入：adapter-hyperframes 不再是占位实现，ffmpeg concat 已能在 smoke 中跑通。
- ⏳ RFC-06 正式文档稿（落 `research/2026-05-28-spec-06-content-graph.md`）；目前规范散在 content-graph package README + smoke + agent prompt 三处

## 会话进度（2026-06-04）— 模板来源/署名整改，**已完成（待 commit）**

> 起因：Joey 发现新加的模板与已有模板视觉撞车，且"原创"声明未经核实。
> 做了一次全量来源审计 + 定转换规范 + 按规范整改了 6 个模板的署名。

**审计与规范（前半段）：**
- ✅ 回退了今天误加的 3 个重复模板 commit（`abd8168`，曾是 build-metrics / pentagram-benchmark /
  takram-radar）。`git reset --hard origin/main` 回到 26 个模板的干净状态，HEAD = `166fdc1`。
  → **结论：这 3 个是已有 huashu 系模板的"+3指标数据"换皮变体，不要再加回来。**
- ✅ 真实 clone 两个上游核实 license（都真是 MIT）+ 记下**真实版权人**：
  - huashu-design → `alchaincyf（花叔 · 花生）` © 2026
  - frontend-slides → `Zara Zhang` © 2025
- ✅ 关键发现：Pentagram / Build / Takram **不是 huashu 原创**，是 huashu 在致敬真实设计工作室
  （Pentagram=Michael Bierut / Build=伦敦工作室 / Takram=日本公司）。署名是**三层**不是两层。
  且我们模板示例数据（95.7/73.8/AIME/SWE）是从上游 ppt 页照搬的。
- ✅ 写了审计报告 `notes/2026-06-04-provenance-audit.md`（未提交）
- ✅ 写了转换规范 **`research/2026-06-04-spec-07-ppt-to-template.md`（RFC-07，未提交）** —— 含三层
  署名 schema（origin/via_skill/transformation）+ 命名规范 + 转换质量门槛 + 查重 + 交付清单。
  Joey 已认可此规范，后续按它走。
- ✅ 决定：**"默认渲染效果"不另做 loop.mp4**。studio 预览弹窗已用 `mode:'iframe'` 实时跑动画，
  用户在 studio 能直接看动效；preview.png 只做 studio 之外（README/官网）的静态兜底。

**整改（后半段，本轮做完）—— 6 个模板按 RFC-07 补三层署名，只补署名不改名：**
- ✅ 6 个模板的扁平 `provenance.inspired_by` 全部换成三层结构
  `origin`（L1 真实工作室）/ `via_skill`（L2 skill+真实作者全名+license+具体 source_file）/ `transformation`：
  - huashu 系 source_file = `assets/showcases/ppt/ppt-{pentagram,build,takram}.html`，
    origin 分别 = Pentagram(Michael Bierut) / Build(伦敦工作室) / Takram(日本公司)。
  - frontend-slides 系 source_file = `STYLE_PRESETS.md`（preset "Bold Signal"/"Creative Voltage"/
    "Electric Studio"），**origin 诚实标 `none`** —— 这三个是 skill 作者自组的原创 preset，没特定 L1 工作室。
  - via_skill.author 填真实全名：`alchaincyf (花叔 · 花生)` / `Zara Zhang`（上游 LICENSE 核实过）。
- ✅ 遵守 Joey 决定（6/4）：本轮**只补 provenance 三层 + 真实作者名，未改 id/显示名/示例数据**
  （命名挪用工作室名的问题留下一轮）。
- ✅ 新建根 `ATTRIBUTIONS.md` 汇总两个上游 + license + 每个模板的 L1/L2 映射 + "not affiliated" 声明。
- ✅ 验证：① 用项目 `yaml@2.9.0` 直接解析 6 文件 → 三层字段齐全、无 `inspired_by` 残留、语法 OK；
  ② 全新 CLI 进程 `search-templates` 重读磁盘 → 6 个模板全部正常加载（license/best_for/duration 都对）；
  ③ studio(localhost:3074) `/api/templates` 24 模板齐全。注：provenance **不进** API / UI 渲染路径
  （studio 只用 source HTML + inputs schema + poster），本轮没碰这些，渲染逻辑上不受影响。

**待办（下次接）：**
- ⏳ **commit + push 需 Joey 明确点头**。待提交清单：6 个 yaml + 新 `ATTRIBUTIONS.md` +
  `notes/2026-06-04-provenance-audit.md` + `research/2026-06-04-spec-07-ppt-to-template.md` + 本 AGENTS.md。
- ⏳ 下一轮（独立）：按 RFC-07 ③ 给 6 个模板**重命名**（去掉挪用的工作室名，改设计特征中性名，
  如 `frame-editorial-anchor` / `frame-luxe-minimal` / `frame-soft-radar`），涉及改 id 要同步 source 目录名 + 引用。

> 笔误备忘：本项目正确写法是 **hyperframes**（不是 hiframes/HiFrames），文档里如再见到要改。
> 上游 clone 仍在 `~/Desktop/Codex/scratch/upstream-check/`（huashu-design + frontend-slides，可能被定期清理）。

## 跑起来

```bash
cd ~/Desktop/Codex/projects/html-video
pnpm install
pnpm -r build
pnpm --filter @html-video/cli smoke

# CLI 直接跑
./packages/cli/dist/bin.js doctor
./packages/cli/dist/bin.js search-templates --intent "github stars" --top 3
```

## 与姊妹项目的关系

| 项目 | 角色 | 关系 |
|---|---|---|
| `open-design` (T5) | OD 主线 maintainer 工作树 | 设计资产侧；本项目是视频侧；同 nexu-io org，可以共享部分 skill 基建 |
| `html-anything` | OD 的 sister 开源（HTML 模板/页面） | 命名同 family（"HTML X"），定位互补：HA 做 HTML 静态页、本项目做 HTML 视频 |
| `od-pitch` (T6) | 路演 deck | 启动时如果做 launch deck，可以复用 od-pitch 的 magazine/recruiting 同款风格 |
| `growth-dashboard` (T7) | 数据罗盘 | 上线后增加 html-video 的 stars/forks/issues 监控 |

## 写操作守则

- 任何对外 publish 动作（CF Pages / GitHub repo create / 推 main / launch tweet / 公众号）**每次都先告诉 Joey**
- 改动 README.md 这种"公开门面"前先 review，避免误更新对外定位
- 第一次 push 到 nexu-io/html-video 是高敏感动作，要 Joey 明确点头 + 选好 launch 时机

## 命名 & 标语备忘

- 项目名：`html-video`
- 公司名 / org: `nexu-io`
- 推荐 tagline 候选：
  - "HTML→Video meta-layer for coding agents"（直白）
  - "Bring your agent. Pick any engine. Render any video."（口号化）
  - "One agent, every HTML video engine."（最短）
- 选哪个等公开发布前定
