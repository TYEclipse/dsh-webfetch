# dsh-webfetch

DeepSeek Harness（dsh）的网页阅读插件：给定 URL，抓取网页并提取干净的 Markdown / 纯文本正文，附链接清单、RSS/Atom 订阅源解析、HTTP 头部探测与网页表格结构化提取。零运行时依赖，只读，不发送任何凭证。

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

## 安装

```sh
dsh plugin --profile web add github:TYEclipse/dsh-webfetch
# 或指定已发布版本：
dsh plugin --profile web add github:TYEclipse/dsh-webfetch#v0.4.0
```

重启会话后模型即可使用这五个工具。

## 配置（均可选，以下为默认值）

```yaml
plugins:
  dsh-webfetch:
    timeoutMs: 10000        # 单次请求超时（1000–60000）
    maxBytes: 1500000       # 响应体积上限，字节（10000–5000000）
    maxChars: 50000         # 提取正文长度上限（1000–200000）
    maxRedirects: 3         # 重定向跳数上限（0–10）
    userAgent: "dsh-webfetch/0.3 (DeepSeek Harness plugin)"
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
- **类型门禁**：`web_fetch`/`web_links` 只解析 `text/html` 与 `text/plain`；`web_feed` 额外接受 `application/rss+xml`、`application/atom+xml`、`application/xml` 与 `text/xml`。脚本/样式/注释/嵌入内容由提取器/解析器剥离。
- **字符集自动识别**：Content-Type → XML 声明 / `<meta charset>` 嗅探 → UTF-8 兜底。

## 开发

```sh
pnpm install
pnpm build      # tsc
pnpm test       # vitest — 125 个测试，全程离线（本地 fixture 服务器）
pnpm lint       # oxlint src test
```

## 许可证

[MIT](LICENSE)
