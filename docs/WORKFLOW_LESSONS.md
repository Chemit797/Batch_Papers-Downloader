# 文献批量下载完整经验总结

> 基于 119/123 篇（96.7%）论文下载实战验证
> 场景：某代谢工程方向文献综述（94篇目标论文，实际获取119篇）

---

## 方法论：多层级降级策略

### 核心公式

```
总成功率 ≈ OA% + (1-OA%)×Sci-Hub% + (前两层剩余)×VPN% + 手动兜底
          ≈ 35%  + 65%×85%         + 10%×60%              + 最后几篇
          ≈ 35%  + 55%             + 6%                   + 手动
          ≈ 96%
```

### 为什么这个顺序不可变

| 如果先做... | 后果 |
|:---|:---|
| 先上 Sci-Hub | 浪费了 OA 可以直接拿的 30-40%（免费 vs 免费但域名不稳定） |
| 先上 VPN 浏览器 | 每篇 10-15 秒 → 100 篇 25 分钟；而 Sci-Hub 每篇 2 秒 |
| 不搞 DOI 清洗 | 畸形 DOI 浪费所有后续层级的时间 |

---

## 各层详细分析

### Tier 1: OpenAlex OA

**数据质量：** OpenAlex 对 2010 年后论文匹配率 >95%，2000 年前约 70%

**OA 状态分布（经验值）：**

| OA 状态 | 占比 | 下载成功率 |
|:---|:---|:---|
| gold | 25% | 99%（几乎全是直接PDF链接） |
| green | 10% | 80%（需要有时跳转PMC页面） |
| hybrid | 8% | 90%（作者付了APC的混合期刊） |
| bronze | 5% | 70%（出版商标注为免费但可能不稳定） |
| closed | 52% | 0%（进入 Tier 2） |

**常见坑：**
- OpenAlex 返回的 `pdf_url` 可能是 PMC 摘要页而非 PDF — 需要二次跳转
- `best_oa_location` 和 `first_oa_location` 有时不一样 — 优先用 `best_oa_location`

### Tier 2: Sci-Hub

**有效覆盖：**
- 2000-2022 主流出版商: ~90%
- 1990-1999: ~60%
- 2023+: ~40%（越来越难）
- 中文论文: <5%

**Sci-Hub 内部机制：**
- Sci-Hub 不是实时爬取 — 它有自己的缓存数据库
- 如果一篇论文 Sci-Hub 没有，大概率永远不会有（不存在重试意义）
- 2分钟内 3 次失败 = 放弃，不要死磕

**域名维护：**
Sci-Hub 域名约每 3-6 个月大规模轮换一次。每次使用前先验证：
```bash
curl -s -o /dev/null -w '%{http_code}' https://sci-hub.se/ --max-time 5
```

### Tier 3: VPN + Playwright 浏览器

**时间成本分析：**

| 步骤 | 耗时 |
|:---|:---|
| 页面加载 (article page) | 2-4s |
| 额外等待 (SPA渲染) | 2-3s |
| PDF 链接查找 | <0.1s |
| PDF 下载 (fetch in-page) | 3-10s (depending on size) |
| 验证 + 写文件 | 0.5s |
| 篇间延迟 | 5-8s (anti-bot) |
| **合计/篇** | **~15-25s** |

100 篇全用 VPN = 25-40 分钟不间断运行。这就是为什么必须先跑 Tier 1+2。

**VPN 会话管理：**
- Cookie 通常 30-60 分钟过期
- 过期表现为页面重定向到 VPN 登录页
- 检测方法：`page.url()` 不再包含 publisher 域名

**出版商 CSS 选择器差异（备忘）：**

| 出版商 | PDF 链接定位 | 常见问题 |
|:---|:---|:---|
| Springer | `a[href*='.pdf']` 或 `c-pdf-download__link` | 有时藏在 "Download book" 按钮后 |
| Elsevier | `a[href*='/science/article/pii/']` | PDF 在新 tab 打开 |
| Wiley | `a[href*='/doi/pdf/']` | 有时需要先点 "PDF" tab |
| Nature | `a[href*='.pdf']` | SharedIt 链接需要特殊处理 |
| ACS | `a[href*='/doi/pdf/']` | 有 CAPTCHA 风险 |
| ASM | `a[href*='.pdf']` | PMC 版本通常更稳定 |

### Tier 4: 手动

**常见场景：**
1. 中文学位论文 → 知网博硕（需要学校买了该库）
2. 极老论文（1970s-1980s）→ 可能没有数字化
3. 会议论文 → 有时只有摘要没有全文
4. 纯粹查不到的 → 通讯作者邮箱 / ResearchGate

---

## 失败模式完整清单

| # | 失败模式 | 频率 | 是否可预防 | 预防措施 |
|:---|:---|:---|:---|:---|
| 1 | DOI 格式畸形 | ~2% | ✅ 可以 | Phase 0 URL-encode 特殊字符 |
| 2 | Sci-Hub 无此论文 | ~3% | ❌ 不可控 | 直接进入 Tier 3 |
| 3 | OpenAlex 无法匹配 | ~5% | ❌ 不可控 | 用 Crossref API 做二次查询 |
| 4 | VPN 会话过期 | ~2% | ✅ 可以 | 每 20 篇检查一次登录状态 |
| 5 | 被识别为爬虫 | ~1% | ✅ 可以 | 加大 delay + 随机化间隔 |
| 6 | PDF 链接 JS 动态渲染 | ~2% | ✅ 可以 | 用 `networkidle` 而非 `domcontentloaded` |
| 7 | 文件名过长/非法字符 | ~1% | ✅ 可以 | 截断 + 去除非法字符 |
| 8 | 下载的是 HTML 错误页而非 PDF | ~1% | ✅ 可以 | 强制检查 `%PDF` header |

---

## 工具链设计原则

### 1. CSV 唯一真相源（Single Source of Truth）

```
优点：
- 任何脚本随时可读当前状态
- 任意顺序执行多个脚本不会重复或遗漏
- 人也可以直接打开 CSV 查看进度
- Git diff 友好
```

### 2. 断点续传

```json
// progress.json
{
  "last_processed_num": 67,
  "total_downloaded": 89,
  "total_failed": 4,
  "session_start": "2024-06-24T06:51:00Z",
  "last_update": "2024-06-24T14:23:00Z",
  "per_paper": {
    "num_1": { "status": "done", "method": "scihub", "time_s": 3.2, "size": 612544 },
    "num_2": { "status": "failed", "reason": "doi_malformed", "time_s": 0.1 }
  }
}
```

### 3. 幂等性

所有下载操作必须是幂等的 — 重复执行不会产生副作用：
- 下载前检查文件是否已存在
- CSV 更新用 replace 而非 append
- 同一 DOI 多次请求返回相同结果（Sci-Hub 缓存层保证）

---

## 对 Claude Code Skill 的适配要点

传统这个工作流是人在跑脚本。变成 Skill 后，**Claude 替代人做决策**：

| 人的操作 | Skill 中的等价物 |
|:---|:---|
| 看 CSV 决定下一批下载哪些 | Claude 读 CSV，筛选 `pending` 行 |
| 看到报错判断是不是DOI问题 | Claude 检查错误消息，匹配已知失败模式 |
| 决定要不要切 Sci-Hub 域名 | Claude 轮询域名列表 |
| 发现 VPN 过期，手动重登 | Claude 检测到 VPN 重定向，暂停并通知用户 |
| 手动打开一个PDF确认不是损坏的 | Claude 检查 `%PDF` header + 文件大小 |

---

## 可复用脚本模板

详见 `SKILL.md` Phase 1-3 中的代码片段。完整可运行脚本在项目源码中：
- `download_papers.js` — VPN + Playwright 全自动下载
- `batch_download.js` — CDP 模式批量下载
- `sd_download.js` — 通用 DOI → VPN → 下载
- `quick_download.js` — 特定出版商快速下载

---

*生成于 2024-06-25 · 实战验证于 119 篇论文批量下载*
