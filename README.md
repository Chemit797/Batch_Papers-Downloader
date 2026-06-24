# 📚 Batch Papers Downloader

> Claude Code Skill — 批量下载学术论文PDF的多层级自动化工作流

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-blue)](https://claude.ai/code)

## 是什么？

这是一个给 **Claude Code** 用的 Skill。告诉 Claude 你的论文列表（RIS/BibTeX/DOI清单），它自动用 **4层级降策略** 批量下载PDF：

```
公开OA直链 (30-40%) → Sci-Hub (50-60%) → 机构VPN浏览器 (5-10%) → 手动兜底 (1-5%)
```

## 真实战绩

| 项目 | 结果 |
|:---|---|
| 主题 | 大肠杆菌代谢工程产番茄红素 |
| 目标 | 94 篇 RIS 列表 |
| 实际下载 | **119 篇** PDF |
| 成功率 | **96.7%** |
| 缺失 | 仅 4 篇（均因 DOI 畸形） |

## 安装

### 方式一：Claude Code 一键安装

在 Claude Code 中运行：

```
/claude-skill install Chemit797/Batch_Papers-Downloader
```

### 方式二：手动安装

```bash
# 下载 SKILL.md 到 Claude Code skills 目录
mkdir -p ~/.claude/skills/literature-download
curl -o ~/.claude/skills/literature-download/SKILL.md \
  https://raw.githubusercontent.com/Chemit797/Batch_Papers-Downloader/main/SKILL.md
```

### 方式三：项目级安装

```bash
# 放到项目根目录（仅当前项目可用）
mkdir -p .claude/skills
cp SKILL.md .claude/skills/literature-download.md
```

## 使用

### 基本用法

在 Claude Code 对话中直接说：

> "帮我把这个 RIS 文件里的论文全部下载下来"

或者显式调用：

> `/literature-download 下载 papers.ris 中的所有论文`

### 输入格式支持

| 格式 | 来源 |
|:---|:---|
| `.ris` | PubMed, Web of Science, Scopus, EndNote |
| `.bib` | Zotero, Mendeley, Google Scholar |
| CSV | 自建列表 `num, doi, title` |
| 纯文本 | 每行一个 DOI |

### 工作流示例

```
用户: 帮我把 literature.ris 里的论文全部下载

Claude:
  📋 Phase 0: 扫描 RIS → 清理 DOI → 生成 progress.csv (94 篇)
  📊 Phase 1: OpenAlex 查询 → 28 篇 Gold OA 直接下载 ✅
  🏴‍☠️ Phase 2: Sci-Hub → 55 篇下载 ✅ (累计 83/94)
  🔐 Phase 3: VPN + 浏览器 → 7 篇下载 ✅ (累计 90/94)
  📄 Phase 4: 手动 → 2 篇中文期刊 ✅
  ❌ 最终失败: 2 篇 (DOI 畸形)

  ✅ 92/94 (97.9%) 下载成功
  📁 所有 PDF 保存在 ./papers/
  📋 详细状态见 progress.csv
```

## 前置依赖

### Tier 1 & 2 (无需额外配置)
- ✅ 开箱即用 — Claude 的网络访问能力

### Tier 3 (可选 — 需要时才会用到)
- 🔑 机构 VPN 连接（如 CARSI、校内VPN）
- 🌐 Chrome 浏览器开启远程调试: `chrome --remote-debugging-port=9222`
- 🔌 Node.js + Playwright (`npm install playwright`)

Claude 会在需要的时候提示你配置。

## 文件说明

```
Batch_Papers-Downloader/
├── SKILL.md                       # 🔧 给 Claude 看的执行指令
├── README.md                      # 📖 你正在读的这个文件
├── templates/
│   ├── progress.csv               # 📋 CSV 状态追踪模板
│   └── doi_list.txt               # 📝 纯 DOI 列表示例
├── examples/
│   └── sample-output.md           # 📊 下载完成后的输出示例
└── docs/
    └── WORKFLOW_LESSONS.md        # 🧠 完整经验总结（方法论）
```

## 为什么是 4 层？

| 层级 | 方法 | 速度 | 成本 | 覆盖 |
|:---|:---|:---|:---|:---|
| 1 | OpenAlex OA | ⚡ 秒级 | 免费 | 30-40% |
| 2 | Sci-Hub | 🏃 几秒 | 免费 | 再加 50-60% |
| 3 | VPN + Playwright | 🐢 分钟级 | 需VPN | 再加 5-10% |
| 4 | 手动 | 🧑 不定 | 看情况 | 最后 1-5% |

**顺序不能乱** — 先用免费快速的，把昂贵的留到最后。

## 出版商兼容性

| 出版商 | DOI 前缀 | OA 策略 | 最佳下载方式 |
|:---|:---|:---|:---|
| MDPI | `10.3390` | 全 Gold | OpenAlex 直链 |
| Frontiers | `10.3389` | 全 Gold | OpenAlex 直链 |
| PLOS | `10.1371` | 全 Gold | OpenAlex 直链 |
| BMC/SpringerOpen | `10.1186` | 全 Gold | OpenAlex 直链 |
| Nature | `10.1038` | 混合 | Sci-Hub |
| Springer | `10.1007` | 混合 | Sci-Hub |
| Elsevier | `10.1016` | 混合 | Sci-Hub |
| Wiley | `10.1002` | 混合 | Sci-Hub |
| ACS | `10.1021` | 闭源 | Sci-Hub |
| ASM | `10.1128` | 2年Green OA | OpenAlex PMC |
| Oxford | `10.1093` | 混合 | Sci-Hub |
| PNAS | `10.1073` | 混合 | Sci-Hub |
| 中文期刊 | `10.13345`等 | 闭源 | 手动（CNKI） |

## 常见问题

**Q: 会不会有版权问题？**

本工具针对个人学术研究用途。OpenAlex OA 来源完全合法。Sci-Hub 和 VPN 方式请遵守所在机构的政策。

**Q: VPN 必须吗？**

不。Tier 1 + Tier 2 通常能覆盖 80-90% 的论文。只有当你需要 100% 覆盖时才用 Tier 3。

**Q: 支持中文论文吗？**

OpenAlex 和 Sci-Hub 对中文论文覆盖较差。中文期刊建议手动从 CNKI/万方下载。

**Q: 如何恢复中断的下载？**

Claude 会自动检测已下载的 PDF 和 `progress.csv`，从中断处继续，不会重复下载。

## 贡献

欢迎提 Issue 和 PR！特别是：

- 🐛 新增出版商 CSS 选择器
- 🌐 Sci-Hub 可用域名更新
- 📊 新数据源的适配（Crossref, Semantic Scholar）

## 许可证

MIT © [Chemit797](https://github.com/Chemit797)

---

🤖 基于 Claude Code Skill 架构构建 · 实战验证于 119 篇论文批量下载
