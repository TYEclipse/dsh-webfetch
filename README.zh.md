# dsh-webfetch

DeepSeek Harness（dsh）的网页阅读插件：给定 URL，抓取网页并提取干净的 Markdown / 纯文本正文，附链接清单、RSS/Atom 订阅源解析、HTTP 头部探测、网页表格结构化提取、页面元数据读取、站点地图 URL 枚举与 robots.txt 规则判定。零运行时依赖，只读，不发送任何凭证。

[English](README.md) | 中文

## 为什么需要它

dsh 内置搜索只返回摘要，生态里没有「按 URL 读正文」的工具。拿到一个链接后，智能体要么拒绝、要么靠 Bash 拼 curl 再手剥 HTML。dsh-webfetch 补上这一环：**搜索给线索，webfetch 读正文**。

## 工具

### `web_fetch`

抓取网页并提取可读内容。

| 参数           | 类型                     | 默认值     | 说明                                   |
| -------------- | ------------------------ | ---------- | -------------------------------------- |
| `url`          | string（必填）           | —          | 目标网页的完整 http/https 地址。       |
| `format`       | `'markdown' \| 'text'`   | `markdown` | markdown 保留标题/链接/列表/代码块；text 为纯文本。 |
| `extractLinks` | boolean                  | `false`    | 同时返回页面全部链接（已解析为绝对地址）。 |
| `maxChars`     | number                   | `50000`    | 提取正文长度上限（1000–200000）。      |

返回 `{ url, finalUrl, status, title, content, length, truncated, links? }`。

### `web_links`

列出页面全部链接及可见文字，解析为绝对地址、去重，`limit`（1–200，默认 50）限量。适合梳理页面指向或爬站点结构。

### `web_feed`

解析 RSS 2.0 / Atom 订阅源为条目清单。订阅源是 XML 文档，`web_fetch` 无法提取正文，`web_feed` 将其解析为结构化条目。

| 参数             | 类型             | 默认值  | 说明                                  |
| ---------------- | ---------------- | ------- | ------------------------------------- |
| `url`            | string（必填）   | —       | RSS 或 Atom 订阅源的完整 http/https 地址。 |
| `maxItems`       | number           | `10`    | 返回条目上限（1–50）。                |
| `includeContent` | boolean          | `false` | 同时返回条目全文（否则仅摘要）。      |

返回 `{ url, finalUrl, status, feedTitle, entryCount, truncated, entries }`，
每个条目为 `{ title, url, published?, author?, summary?, content? }`；CDATA 已解开、HTML 实体已解码、标签已剥离、相对链接已按订阅源地址解析为绝对地址。

```text
user: 这个博客这周发了什么？
agent: web_feed("https://blog.example.com/feed.xml", maxItems: 5)
  → feed: Example Blog
    5 entries from https://blog.example.com/feed.xml
    1. First & foremost post — https://blog.example.com/posts/first
       published: Mon, 01 Jan 2024 10:00:00 GMT
       author: Alice
       Hello world — café & tea.
```

### `web_headers`

探测任意 URL 的 HTTP 状态码、响应头与重定向链，**不下载正文**——`web_fetch` 的读前诊断搭档：先查状态码/内容类型/重定向/缓存或安全头，再决定是否抓正文。默认用 `HEAD`（服务器返回 405/501 时自动回退 `GET`）；与 `web_fetch` 不同，任何状态码（含 404/500）都会照常报告而不是报错。

| 参数              | 类型               | 默认值 | 说明                                       |
| ----------------- | ------------------ | ------ | ------------------------------------------ |
| `url`             | string（必填）     | —      | 待探测的完整 http/https 地址。             |
| `method`          | `'HEAD' \| 'GET'` | `HEAD` | HEAD 不下载正文；GET 必达但会传输正文。    |
| `followRedirects` | boolean            | `true` | 跟随重定向并逐跳报告整条链。               |

返回 `{ url, finalUrl, status, statusText, method, headers, redirects }`，其中 `headers` 为完整响应头表（键名小写），`redirects` 逐跳记录 `{ url, status, location }`。

### `web_table`

把页面上的 HTML 表格提取为**结构化行**——`web_fetch` 的表格版：定价页、参数表、对比表里锁在 `<table>` 标记中的数据，直接以「行的数组（每行是单元格字符串数组）」返回，而不是揉成一段散文。首行为表头时（`<thead>` 或全 `<th>`）单独报告；`colspan` / `rowspan` 展开为矩形网格、跨格文本填充到每个覆盖格（每行自洽）；嵌套表格拍平进所在单元格文本；单元格实体解码、空白归一、超 200 字符截断。

| 参数        | 类型              | 默认值 | 说明                                       |
| ----------- | ----------------- | ------ | ------------------------------------------ |
| `url`       | string（必填）    | —      | 待扫描表格的完整 http/https 地址。         |
| `table`     | number            | —      | 只返回第 N 个表格（1 起）。                |
| `maxTables` | number            | `5`    | 最多返回几个表格（1–20）。                 |
| `maxRows`   | number            | `50`   | 每个表格最多返回多少行数据（1–200）。      |

返回 `{ url, finalUrl, status, tableCount, totalTables, truncated, tables }`，每个表格为 `{ index, caption, cols, header, rows }`——`rows` 为行的数组，每行是单元格字符串数组。无单元格的空表格忽略；`totalTables` 统计页面上所有非空表格。

```text
user: 把定价页的档位对比表拉出来
agent: web_table("https://example.com/pricing")
  → 1 table(s) on https://example.com/pricing
    table 1 (3 columns)
      [header] Plan | Monthly | Yearly
      Free | $0 | $0
      Pro | $12 | $115
      Team | $30 | $288
```

### `web_meta`

读取页面**对自己的描述**：标题、描述、canonical 地址、语言、字符集、robots 策略、作者、Open Graph 与 `article:*` 属性、Twitter 卡片、hreflang 多语言版本、订阅源自动发现链接、图标与 JSON-LD 块。它是 `web_fetch` 的「元数据版」——用于识别、归类、去重页面，或在不必读正文的前提下发现页面的订阅源与语言版本。

| 参数        | 类型              | 默认值 | 说明                              |
| ----------- | ----------------- | ------ | --------------------------------- |
| `url`       | string（必填）    | —      | 待读取的完整 http/https 地址。    |
| `maxJsonLd` | number            | `10`   | 最多返回几个 JSON-LD 块（1–20）。 |

返回 `{ url, finalUrl, status, title, description, canonical, lang, charset, robots, author, openGraph, twitter, alternates, feeds, icons, jsonLd, jsonLdCount, jsonLdInvalid, truncated }`。取值按原文汇报（实体解码、空白归一、单个值 1000 字符截断）；`canonical`、多语言、订阅源与图标地址已解析为绝对地址。Open Graph 与 Twitter 以有序的 `{ name, content }` 对返回——重复属性（多个 `og:image`）不会丢，完全相同的条目去重。解析失败的 JSON-LD 块如实报 `valid: false` 并附解析器信息、计入 `jsonLdInvalid`，绝不静默丢弃。

```text
user: 这个页面是英文原版吗？它有订阅源吗？
agent: web_meta("https://example.com/products/widget")
  → HTTP 200 — metadata of https://example.com/products/widget
    title: Widget — Example
    canonical: https://example.com/products/widget
    lang: en-GB — charset: utf-8
    hreflang alternates (2):
      en — https://example.com/en/widget
      zh-Hans — https://example.com/zh/widget
    feeds (1):
      application/rss+xml — Blog feed — https://example.com/feed.xml
    json-ld: 2 block(s)
      1. Product
      2. WebPage, Organization
```

### `web_sitemap`

列出站点**自己的 URL**——`web_links` 只看单页，`web_sitemap` 看整站。给它任意页面、`robots.txt` 或 sitemap 地址：先读 `robots.txt` 的 `Sitemap:` 指令（没有就回退 `/sitemap.xml`），**跟随 sitemap 索引**（深度有界），每个 `<url>` 带可选的 `lastmod` / `changefreq` / `priority` 一并返回；相对 `<loc>` 按 sitemap 地址解析为绝对地址，重复地址折叠。

| 参数          | 类型              | 默认值 | 说明                                                        |
| ------------- | ----------------- | ------ | ----------------------------------------------------------- |
| `url`         | string（必填）    | —      | 完整 http/https 地址：站点页面、`robots.txt` 或 sitemap。   |
| `maxUrls`     | number            | `100`  | 最多返回多少个 URL（1–1000）。                              |
| `maxSitemaps` | number            | `5`    | 最多抓取几个 sitemap 文档（1–20）。                         |

返回 `{ url, robotsUrl, robotsStatus, sitemapCount, discovered, urlCount, truncated, sitemaps, urls }`。输入本身就是 sitemap 时 `robotsUrl` 为 `""`；`robotsStatus` 是 `robots.txt` 的 HTTP 状态（缺失时 `0`）。`sitemaps` 每项为 `{ url, kind, status, entryCount, error }`，`kind` 取 `index` / `urlset` / `gzip` / `error`——**某个 sitemap 抓取失败或是 gzip 压缩，会带原因列出来而不是让整次查询失败**，部分清单仍然可用；`discovered` 统计「看到了多少个不同地址」（即使超过 `maxUrls`），所以被裁剪的答案也是诚实的。

```text
user: example.com 都发布了哪些页面？
agent: web_sitemap("https://example.com/blog")
  → sitemap inventory of https://example.com/blog — robots HTTP 200 (https://example.com/robots.txt)
    sitemap https://example.com/sitemap-index.xml — index HTTP 200, 2 entries
    sitemap https://example.com/sitemap-posts.xml — urlset HTTP 200, 3 entries
    3 of 3 discovered URL(s):
      1. https://example.com/docs/getting-started — lastmod 2026-10-01, weekly, priority 1
      2. https://example.com/pricing — lastmod 2026-09-20, priority 0.8
      3. https://example.com/blog/
```

### `web_robots`

回答爬虫最先要问的那个问题：**我这个 agent 能不能读这个路径？** `web_sitemap` 只读 `robots.txt` 里的 `Sitemap:` 行；这个工具读的是**访问规则本身**，并按 RFC 9309 的口径判定：

- 组 = `User-agent:` 行 + 紧跟的 `Allow:` / `Disallow:` 行（规则之后再出现 `User-agent:` 就开新组；`Sitemap:` 与 `Crawl-delay:` 是全局的）；
- 组的 agent 值是我们产品标识（`dsh-webfetch`）的**大小写不敏感前缀**即匹配，**最具体的匹配胜出**，只有在没有任何具体匹配时才用 `*`；
- 规则从路径第一个字符开始匹配（路径含 query），`*` 匹配任意串，结尾 `$` 表示锚定到末尾；
- **最长**的匹配规则胜出，长度相同则 `Allow` 胜（RFC 9309 §2.2.2）。

| 参数        | 类型              | 默认值       | 说明                                                   |
| ----------- | ----------------- | ------------ | ------------------------------------------------------ |
| `url`       | string（必填）    | —            | 完整 http/https 地址：要读的页面，或 `robots.txt`。    |
| `path`      | string            | URL 自身的路径 | 要测的路径（可带 `?query`），如 `/blog/post-1`。       |
| `userAgent` | string            | 插件 UA      | 用哪个 agent 去匹配组（实际比的是斜杠前的产品标识）。  |
| `maxRules`  | number            | `50`         | 列出该组多少条规则（1–200）。                          |

返回 `{ url, robotsUrl, robotsStatus, bytes, userAgent, productToken, target, allowed, decision, matchedKind, matchedAgents, groupCount, ruleCount, ignoredRules, orphanRules, crawlDelay?, sitemaps, rules, rule?, notes, truncated }`。诚实的地方才是重点：

- `decision` 说明**这个答案是怎么来的**：`rule`（真有一条规则决定了它）、`no-matching-rule`（该组有规则、但没有一条匹配 → 默认允许）、`no-group`（既没有给我们建的组、也没有 `*` 组）、`no-robots`（4xx：文件不存在，所以没有规则）、`unavailable`（5xx 或读不到：RFC 9309 要求按「完全禁止」处理，此时 `allowed` 为 `false`）。
- 没有规则命中时 `rule` **字段缺席**，而不是编一个 pattern 出来；文件没写 `Crawl-delay` 时 `crawlDelay` 也缺席。
- `notes` 解释那些「看着对其实没用」的东西：`Disallow: admin` 这种不以 `/` 开头的规则永远匹配不到路径、空的 `Allow`/`Disallow` 行匹配不了任何东西、任何 `User-agent` 之前的规则被忽略、`Crawl-delay` 只是自觉约定（RFC 9309 没有延迟指令）、文件超过 512 KiB 时解析器可以截断。

```text
user: example.com/no-webfetch/x 能读吗？
agent: web_robots("https://example.com/no-webfetch/x")
  → robots.txt of https://example.com/robots.txt — HTTP 200, 326 bytes
    agent dsh-webfetch/0.7 (DeepSeek Harness plugin) (token "dsh-webfetch") → /no-webfetch/x
    disallowed by disallow "/no-webfetch" — 12 octets, line 8
    group: specific match on dsh-webfetch
```

## 安装

```sh
dsh plugin --profile web add github:TYEclipse/dsh-webfetch
# 或指定已发布版本：
dsh plugin --profile web add github:TYEclipse/dsh-webfetch#v0.7.0
```

重启会话后模型即可使用这八个工具。

## 配置（均可选，以下为默认值）

```yaml
plugins:
  dsh-webfetch:
    timeoutMs: 10000        # 单次请求超时（1000–60000）
    maxBytes: 1500000       # 响应体积上限，字节（10000–5000000）
    maxChars: 50000         # 提取正文长度上限（1000–200000）
    maxRedirects: 3         # 重定向跳数上限（0–10）
    userAgent: "dsh-webfetch/0.7 (DeepSeek Harness plugin)"
    httpsProxy: ""          # http://host:port；留空默认读 HTTPS_PROXY 环境变量，'' 显式禁用
    httpProxy: ""           # 同上，对应 HTTP_PROXY
    noProxy: ""             # 直连白名单，留空默认读 NO_PROXY 环境变量
```

## 代理支持

Node 内置 `fetch` 不读取 `HTTP_PROXY`/`HTTPS_PROXY`，在必须走代理的网络里所有请求都会失败。dsh-webfetch 内置零依赖 http 代理传输（https 走 CONNECT 隧道、http 走绝对 URI 形式，`NO_PROXY` 支持精确域名/后缀/通配符/IPv4 CIDR），并自动启用：

- `httpProxy` / `httpsProxy`（默认读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量）——`http://host:port` 形式；设为空字符串即禁用。
- `noProxy`（默认读 `NO_PROXY`）——逗号分隔的直连白名单（精确主机名、`.后缀`、`*.通配`、IPv4 CIDR、可带 `:端口`）。

```yaml
plugins:
  dsh-webfetch:
    httpsProxy: "http://127.0.0.1:7897"   # 覆盖环境变量
    noProxy: "localhost,.internal,10.0.0.0/8"
```

代理 URL 内嵌的凭证只会以 `Proxy-Authorization: Basic` 发给代理本身，绝不发给目标站点。

## 安全模型

- **仅限 http/https**：`file:`、`ftp:`、`javascript:` 等一律拒绝。
- **零凭证**：拒绝内嵌凭证的 URL；不附加 cookie/Authorization；不做任何持久化。
- **处处有上限**：请求超时、重定向跳数、响应体积、正文长度全部封顶；超限截断并标记 `truncated: true`，绝不越界缓冲。
- **类型门禁**：`web_fetch`/`web_links` 只解析 `text/html` 与 `text/plain`；`web_feed` 与 `web_sitemap` 额外接受 `application/rss+xml`、`application/atom+xml`、`application/xml` 与 `text/xml`（`robots.txt` 是 `text/plain`）。脚本/样式/注释/嵌入内容由提取器/解析器剥离。
- **字符集自动识别**：Content-Type → XML 声明 / `<meta charset>` 嗅探 → UTF-8 兜底。

## 开发

```sh
pnpm install
pnpm build      # tsc
pnpm test       # vitest — 163 个测试，全程离线（本地 fixture 服务器）
pnpm lint       # oxlint src test
```

## 许可证

[MIT](LICENSE)
