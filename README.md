# dsh-webfetch

> 为 DeepSeek Harness 智能体装上「阅读器」：给定 URL，抓取网页并提取干净的 Markdown / 纯文本正文，附带链接清单。零运行时依赖，只读，不发送任何凭证。
> [English](#english) | 中文简介

A web page reader plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
`dsh` agents can search, but until now they could not *read the page behind a URL*.
`dsh-webfetch` closes that gap with two read-only tools and **zero runtime dependencies** (Node built-ins + global `fetch` only).

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

## Install

```sh
dsh plugin --profile web add github:TYEclipse/dsh-webfetch
# or a pinned release:
dsh plugin --profile web add github:TYEclipse/dsh-webfetch#v0.1.0
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
    userAgent: "dsh-webfetch/0.1 (DeepSeek Harness plugin)"
```

## Safety model

- **http/https only** — `file:`, `ftp:`, `javascript:` and friends are rejected.
- **No credentials ever** — URLs with embedded credentials are rejected; no
  cookies or authorization headers are attached; nothing is persisted.
- **Bounded everything** — hard timeout per request, redirect hop limit,
  response size cap, extracted-text cap. Oversized bodies are cut off and
  flagged (`truncated: true`), never buffered past the cap.
- **Content-type gated** — only `text/html` and `text/plain` responses are
  parsed; scripts, styles, comments and embedded content are stripped by the
  extractor.
- **Charset-aware** — honours the `Content-Type` charset, falls back to
  `<meta charset>` sniffing, then UTF-8.

## Development

```sh
pnpm install
pnpm build      # tsc
pnpm test       # vitest — 32 tests, fully offline (local fixture server)
pnpm lint       # oxlint src test
```

## License

[MIT](LICENSE)

---

## 中文简介

dsh-webfetch 是 DeepSeek Harness 的网页阅读插件：智能体拿到 URL 后可以直接抓取页面并提取干净的 Markdown 或纯文本（保留标题、链接、列表与代码块，剥离脚本/样式），另一个工具 `web_links` 可列出页面全部链接（解析为绝对地址、去重、限量）。零运行时依赖、只读、不发送凭证；http/https 协议限定、超时/重定向/体积/文本长度全部有上限，字符集自动识别（Content-Type → meta → UTF-8）。与内置搜索互补：搜索给线索，webfetch 读正文。
