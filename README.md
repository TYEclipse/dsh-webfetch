# dsh-webfetch

> 为 DeepSeek Harness 智能体装上「阅读器」：给定 URL，抓取网页并提取干净的 Markdown / 纯文本正文，附带链接清单、RSS/Atom 订阅源解析与网页表格结构化提取。零运行时依赖，只读，不发送任何凭证。
> [English](#english) | 中文简介

A web page reader plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
`dsh` agents can search, but until now they could not *read the page behind a URL*.
`dsh-webfetch` closes that gap with five read-only tools and **zero runtime dependencies** (Node built-ins + global `fetch` only).

## Tools

### `web_fetch`

Fetch a web page and extract its readable content.

| Parameter     | Type                 | Default    | Description                                                    |
| ------------- | -------------------- | ---------- | -------------------------------------------------------------- |
| `url`         | string (required)    | —          | Full http/https URL of the page to fetch.                      |
| `format`      | `'markdown' \| 'text'` | `markdown` | Markdown keeps headings, links, lists and code fences; `text` is plain prose. |
| `extractLinks`| boolean              | `false`    | Also return every link found on the page (resolved, absolute). |
| `maxChars`    | number               | `50000`    | Cap on extracted content length (1000–200000).                 |

Returns `{ url, finalUrl, status, title, content, length, truncated, links? }`.

```text
user: what does the dsh README say about the architecture?
agent: web_fetch("https://github.com/deepseek-ai/deepseek-harness")
  → HTTP 200 — title: deepseek-harness
    ## DeepSeek Harness
    ..."everything is a plugin"...
```

### `web_links`

Collect every link on a page with its visible label, resolved to absolute
URLs, deduplicated, capped at `limit` (1–200, default 50). Useful for mapping
what a page points to or crawling site structure.

### `web_feed`

Read an RSS 2.0 or Atom feed and return its entries as a clean,
LLM-friendly listing. Feed URLs are XML documents that `web_fetch` cannot
extract from — `web_feed` parses them into structured entries instead.

| Parameter        | Type              | Default | Description                                                       |
| ---------------- | ----------------- | ------- | ----------------------------------------------------------------- |
| `url`            | string (required) | —       | Full http/https URL of the RSS or Atom feed.                      |
| `maxItems`       | number            | `10`    | Max entries to return (1–50).                                     |
| `includeContent` | boolean           | `false` | Also return each entry's full content (else summaries only).      |

Returns `{ url, finalUrl, status, feedTitle, entryCount, truncated, entries }`,
where each entry is `{ title, url, published?, author?, summary?, content? }`
with CDATA unwrapped, HTML entities decoded, markup stripped and relative
links resolved against the feed URL.

```text
user: what did the example blog post this week?
agent: web_feed("https://blog.example.com/feed.xml", maxItems: 5)
  → feed: Example Blog
    5 entries from https://blog.example.com/feed.xml
    1. First & foremost post — https://blog.example.com/posts/first
       published: Mon, 01 Jan 2024 10:00:00 GMT
       author: Alice
       Hello world — café & tea.
```

### `web_headers`

Inspect the HTTP status, response headers and redirect chain of a URL
**without downloading the page body** — the diagnostic companion to
`web_fetch`: check status codes, content types, redirects, caching or
security headers before (or instead of) pulling the content. Uses `HEAD`
by default and falls back to `GET` automatically when the server answers
405/501; unlike `web_fetch`, *any* status is reported (404/500/… included)
rather than thrown.

| Parameter         | Type              | Default | Description                                                              |
| ----------------- | ----------------- | ------- | ------------------------------------------------------------------------ |
| `url`             | string (required) | —       | Full http/https URL to inspect.                                          |
| `method`          | `'HEAD' \| 'GET'` | `HEAD`  | `HEAD` downloads no body; `GET` always works but transfers the body.     |
| `followRedirects` | boolean           | `true`  | Follow redirects and report every hop of the chain.                      |

Returns `{ url, finalUrl, status, statusText, method, headers, redirects }`
where `headers` is the full response-header map (lower-cased keys) and
`redirects` lists each hop as `{ url, status, location }`.

```text
user: is that download link still alive, and does it redirect?
agent: web_headers("https://example.com/downloads/latest")
  → HTTP 200 OK — HEAD https://example.com/downloads/latest
    redirect chain:
      1. 301 https://example.com/downloads/latest → https://cdn.example.com/releases/latest.zip
    final URL: https://cdn.example.com/releases/latest.zip
    12 header(s):
      content-type: application/zip
      content-length: 4821337
      ...
```

### `web_table`

Extract the HTML tables of a page as **structured rows** — the tables
counterpart of `web_fetch`: spec sheets, pricing pages, comparison charts
and any data locked in `<table>` markup come back as arrays of cell
strings instead of mashed-together prose. The first row is reported as the
header when the page marks it (`<thead>` or an all-`<th>` first row);
`colspan` / `rowspan` are expanded into a rectangular grid with the
spanning text repeated in every covered slot (rows stay self-contained);
nested tables are flattened into the containing cell; cells are
entity-decoded, whitespace-normalized and capped at 200 characters.

| Parameter   | Type              | Default | Description                                                        |
| ----------- | ----------------- | ------- | ------------------------------------------------------------------ |
| `url`       | string (required) | —       | Full http/https URL of the page to scan for tables.                |
| `table`     | number            | —       | Return only the table at this 1-based position.                    |
| `maxTables` | number            | `5`     | Max tables to return (1–20).                                       |
| `maxRows`   | number            | `50`    | Max data rows per table (1–200).                                   |

Returns `{ url, finalUrl, status, tableCount, totalTables, truncated, tables }`
where each table is `{ index, caption, cols, header, rows }` — `rows` is an
array of rows, each an array of cell strings. Tables without any cell are
ignored; `totalTables` counts every non-empty table on the page.

```text
user: pull the tier comparison table off the pricing page
agent: web_table("https://example.com/pricing")
  → 1 table(s) on https://example.com/pricing
    table 1 (3 columns)
      [header] Plan | Monthly | Yearly
      Free | $0 | $0
      Pro | $12 | $115
      Team | $30 | $288
```

## Install

```sh
dsh plugin --profile web add github:TYEclipse/dsh-webfetch
# or a pinned release:
dsh plugin --profile web add github:TYEclipse/dsh-webfetch#v0.4.0
```

Restart your agent session and the tools are available to the model.

## Configuration

All settings are optional (defaults shown):

```yaml
plugins:
  dsh-webfetch:
    timeoutMs: 10000        # per-request timeout (1000–60000)
    maxBytes: 1500000       # response size cap in bytes (10000–5000000)
    maxChars: 50000         # extracted content cap in chars (1000–200000)
    maxRedirects: 3         # redirect hops to follow (0–10)
    userAgent: "dsh-webfetch/0.3 (DeepSeek Harness plugin)"
```

## Proxy support

Node's built-in `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, so on networks
that require a proxy every request would fail. dsh-webfetch ships a
zero-dependency http-proxy transport (CONNECT tunnelling for https,
absolute-URI form for http, `NO_PROXY` matching with wildcard and IPv4 CIDR
support) and uses it automatically:

- `httpProxy` / `httpsProxy` (default: `HTTP_PROXY` / `HTTPS_PROXY` env) —
  `http://host:port` URL; set to an empty string to disable.
- `noProxy` (default: `NO_PROXY` env) — comma-separated bypass list
  (exact hosts, `.suffix`, `*.wildcard`, IPv4 CIDRs, optional `:port`).

```yaml
plugins:
  dsh-webfetch:
    httpsProxy: "http://127.0.0.1:7897"   # override env
    noProxy: "localhost,.internal,10.0.0.0/8"
```

Proxy credentials embedded in the proxy URL are sent as
`Proxy-Authorization: Basic` (to the proxy only, never to the target).

## Safety model

- **http/https only** — `file:`, `ftp:`, `javascript:` and friends are rejected.
- **No credentials ever** — URLs with embedded credentials are rejected; no
  cookies or authorization headers are attached; nothing is persisted.
- **Bounded everything** — hard timeout per request, redirect hop limit,
  response size cap, extracted-text cap. Oversized bodies are cut off and
  flagged (`truncated: true`), never buffered past the cap.
- **Content-type gated** — `web_fetch`/`web_links` parse only `text/html` and
  `text/plain`; `web_feed` additionally accepts `application/rss+xml`,
  `application/atom+xml`, `application/xml` and `text/xml`. Scripts, styles,
  comments and embedded content are stripped by the extractor/parser.
- **Charset-aware** — honours the `Content-Type` charset, falls back to XML
  declaration / `<meta charset>` sniffing, then UTF-8.

## Development

```sh
pnpm install
pnpm build      # tsc
pnpm test       # vitest — 125 tests, fully offline (local fixture servers)
pnpm lint       # oxlint src test
```

## License

[MIT](LICENSE)

---

## 中文简介

dsh-webfetch 是 DeepSeek Harness 的网页阅读插件：智能体拿到 URL 后可以直接抓取页面并提取干净的 Markdown 或纯文本（保留标题、链接、列表与代码块，剥离脚本/样式），`web_links` 可列出页面全部链接（解析为绝对地址、去重、限量），`web_feed` 可解析 RSS 2.0 / Atom 订阅源为条目清单（标题/链接/发布时间/作者/摘要/正文，处理 CDATA、HTML 实体与相对链接），`web_headers` 可用 HEAD 请求探测任意 URL 的 HTTP 状态码、响应头与重定向链而不下载正文（服务器不支持 HEAD 时自动回退 GET，非 2xx 状态照常报告），`web_table` 可把页面上的 HTML 表格提取为结构化行（表头识别、colspan/rowspan 网格展开、行列上限，定价页/参数表/对比表直接可用）。零运行时依赖、只读、不发送凭证；http/https 协议限定、超时/重定向/体积/文本长度全部有上限，字符集自动识别（Content-Type → XML 声明/meta → UTF-8）；内置零依赖 http 代理支持（CONNECT 隧道 + NO_PROXY 白名单，自动读环境变量），在必须走代理的网络也能正常工作。与内置搜索互补：搜索给线索，webfetch 读正文，web_headers 读前诊断，web_table 提数据。
