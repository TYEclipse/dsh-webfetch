# dsh-webfetch

DeepSeek Harness（dsh）的网页阅读插件：给定 URL，抓取网页并提取干净的 Markdown / 纯文本正文，附链接清单与 RSS/Atom 订阅源解析。零运行时依赖，只读，不发送任何凭证。

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

## 安装

```sh
dsh plugin --profile web add github:TYEclipse/dsh-webfetch
# 或指定已发布版本：
dsh plugin --profile web add github:TYEclipse/dsh-webfetch#v0.2.0
```

重启会话后模型即可使用这三个工具。

## 配置（均可选，以下为默认值）

```yaml
plugins:
  dsh-webfetch:
    timeoutMs: 10000        # 单次请求超时（1000–60000）
    maxBytes: 1500000       # 响应体积上限，字节（10000–5000000）
    maxChars: 50000         # 提取正文长度上限（1000–200000）
    maxRedirects: 3         # 重定向跳数上限（0–10）
    userAgent: "dsh-webfetch/0.2 (DeepSeek Harness plugin)"
```

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
pnpm test       # vitest — 62 个测试，全程离线（本地 fixture 服务器）
pnpm lint       # oxlint src test
```

## 许可证

[MIT](LICENSE)
