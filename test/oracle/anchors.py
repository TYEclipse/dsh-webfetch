#!/usr/bin/env python3
"""anchors.py — independent oracle for dsh-webfetch expected values.

Every numeric and textual expectation used by the repository's test files is
printed by this script; the tests are not allowed to invent them (routing rule:
`ORACLE: test/oracle/anchors.py` in each test file header).

Two independent derivations are cross-checked by `--check`:

* `MetaOracle`  — metadata extraction implemented on top of `html.parser`
  (a different parsing engine than the TypeScript tag walker).
* `derive_*`    — expectations derived straight from the fixture source with
  regular expressions and string operations.

Agreement between the two means the documented semantics hold under two
independent readers. `--check` additionally pins the HTTP status texts to the
stdlib `http.HTTPStatus` registry (public values, not our own implementation)
and validates the table oracle in `anchors_table.py`.

Run:
    python3 test/oracle/anchors.py            # print every anchor (human readable)
    python3 test/oracle/anchors.py --check    # self-check; non-zero exit on failure
"""

import http
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchors_table  # noqa: E402  (sibling oracle: HTML table extraction)

# --------------------------------------------------------------------------
# §0 documented constants (mirrored in src/ and asserted by the tests)
# --------------------------------------------------------------------------

MAX_CELL_CHARS = 200          # src/table.ts — cell text cap
MAX_TABLE_COLS = 100          # src/table.ts — grid column cap (colspan=9999 -> 100)
MAX_META_TEXT = 1000          # src/meta.ts  — per-value cap
MAX_HEAD_SCAN = 200_000       # src/meta.ts  — head scan cap for unclosed <head>
MAX_META_REFS = 32            # src/meta.ts  — alternates/feeds/icons cap
MAX_JSON_LD_BLOCKS = 10       # src/meta.ts  — JSON-LD blocks returned by default
MAX_JSON_LD_CHARS = 100_000   # src/meta.ts  — per-block parse cap
MAX_JSON_LD_TYPES = 8         # src/meta.ts  — @type names kept per block
MAX_CHARS_FIXTURE = 100       # test/html.test.ts — maxChars fixture
FEED_MAX_ITEMS_FIXTURE = 2    # test/tools.test.ts — maxItems fixture
DEFAULT_ROBOTS_MAX_RULES = 50       # src/robots.ts — DEFAULT_MAX_RULES
ROBOTS_MAX_RULES_LIMIT = 200        # src/robots.ts — MAX_RULES_LIMIT
ROBOTS_FILE_SIZE_LIMIT = 512_000    # src/robots.ts — ROBOTS_SIZE_LIMIT (RFC 9309 §2.5)
WEB_FETCH_MAX_CHARS_DEFAULT = 50_000   # src/index.ts — Config default
WEB_FETCH_TIMEOUT_DEFAULT = 10_000     # src/index.ts
WEB_FETCH_MAX_BYTES_DEFAULT = 1_500_000
WEB_FETCH_MAX_REDIRECTS_DEFAULT = 3
WEB_FETCH_TIMEOUT_OVERRIDE = 2_000
WEB_FETCH_MAX_REDIRECTS_OVERRIDE = 5
WEB_FETCH_MAX_CHARS_OVERRIDE = 10_000

# Fixture server contract used by the TypeScript test files (status -> text).
FIXTURE_STATUSES = {200: "OK", 301: "Moved Permanently", 302: "Found",
                    404: "Not Found", 405: "Method Not Allowed"}

# --------------------------------------------------------------------------
# §1 metadata oracle (html.parser based, mirrors the documented semantics)
# --------------------------------------------------------------------------

WS_RE = re.compile(r"\s+")
CHARSET_RE = re.compile(r"charset\s*=\s*([^;\s]+)", re.IGNORECASE)
FEED_TYPES = {"application/rss+xml", "application/atom+xml", "application/feed+json"}
ICON_RELS = {"icon", "shortcut", "apple-touch-icon",
             "apple-touch-icon-precomposed", "mask-icon"}
LD_JSON = "application/ld+json"


def norm(text: str) -> str:
    clean = WS_RE.sub(" ", text).strip()
    return clean[:MAX_META_TEXT] + "\u2026" if len(clean) > MAX_META_TEXT else clean


def head_region(html: str):
    end = re.search(r"</head\s*>", html, re.IGNORECASE)
    if end is not None:
        return html[: end.end()], False
    if len(html) <= MAX_HEAD_SCAN:
        return html, False
    return html[:MAX_HEAD_SCAN], True


def collect_types(value, out):
    """Collect @type names at the top level and inside @graph, in discovery order."""
    if isinstance(value, list):
        for item in value:
            collect_types(item, out)
        return
    if not isinstance(value, dict):
        return
    kind = value.get("@type")
    if isinstance(kind, str):
        names = [kind]
    elif isinstance(kind, list):
        names = [entry for entry in kind if isinstance(entry, str)]
    else:
        names = []
    for name in names:
        if name not in out:
            out.append(name)
    if "@graph" in value:
        collect_types(value["@graph"], out)


class MetaOracle(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.result = {
            "title": "", "description": "", "canonical": "", "lang": "",
            "charset": "", "robots": "", "author": "",
            "openGraph": [], "twitter": [], "alternates": [], "feeds": [],
            "icons": [], "jsonLd": [], "jsonLdCount": 0, "jsonLdInvalid": 0,
        }
        self._ld_blocks = []      # (attrs-type, raw text) captured by handle_data
        self._ld_open = False
        self._ld_buf = ""
        self._ld_want = False
        self._in_title = False
        self._title_buf = ""
        self._max_ld = MAX_JSON_LD_BLOCKS
        self._og_seen = set()
        self._tw_seen = set()
        self._alt_seen = set()
        self._feed_seen = set()
        self._icon_seen = set()

    # -- helpers ---------------------------------------------------------
    def _push(self, bucket, seen, key, value, cap=MAX_META_REFS):
        if key in seen or len(self.result[bucket]) >= cap:
            return
        seen.add(key)
        self.result[bucket].append(value)

    @staticmethod
    def _attrs(attrs):
        return {k.lower(): (v or "") for k, v in attrs}

    # -- callbacks -------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        amap = self._attrs(attrs)
        if tag == "script":
            self._ld_want = LD_JSON in amap.get("type", "").lower()
            self._ld_open = self._ld_want
            self._ld_buf = ""
            return
        if tag == "title":
            self._in_title = True
            self._title_buf = ""
            return
        if tag == "html":
            if self.result["lang"] == "":
                self.result["lang"] = norm(amap.get("lang", ""))
            return
        if tag == "meta":
            inline = amap.get("charset")
            if inline is not None and self.result["charset"] == "":
                self.result["charset"] = norm(inline)
            content = amap.get("content", "")
            if amap.get("http-equiv", "").lower() == "content-type" and self.result["charset"] == "":
                found = CHARSET_RE.search(content)
                if found is not None:
                    self.result["charset"] = norm(found.group(1))
            name = (amap.get("name") or amap.get("property") or amap.get("itemprop") or "").lower()
            if name == "":
                return
            if name == "description":
                if self.result["description"] == "":
                    self.result["description"] = norm(content)
                return
            if name == "robots":
                if self.result["robots"] == "":
                    self.result["robots"] = norm(content)
                return
            if name == "author":
                if self.result["author"] == "":
                    self.result["author"] = norm(content)
                return
            value = norm(content)
            if name.startswith("og:") or name.startswith("article:"):
                self._push("openGraph", self._og_seen, f"{name}\0{value}", {"name": name, "content": value})
            elif name.startswith("twitter:"):
                self._push("twitter", self._tw_seen, f"{name}\0{value}", {"name": name, "content": value})
            return
        if tag == "link":
            rel = [part for part in re.split(r"[\s,]+", amap.get("rel", "").lower()) if part]
            href = norm(amap.get("href", ""))
            if href == "" or not rel:
                return
            if "canonical" in rel:
                if self.result["canonical"] == "":
                    self.result["canonical"] = href
                return
            mime = amap.get("type", "").lower()
            if "alternate" in rel and mime in FEED_TYPES:
                self._push("feeds", self._feed_seen, href,
                           {"type": mime, "title": norm(amap.get("title", "")), "href": href})
                return
            if "alternate" in rel:
                hreflang = norm(amap.get("hreflang", ""))
                if hreflang != "":
                    self._push("alternates", self._alt_seen, f"{hreflang}\0{href}",
                               {"hreflang": hreflang, "href": href})
                return
            if any(part in ICON_RELS for part in rel):
                self._push("icons", self._icon_seen, href, href)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "title" and self._in_title:
            self.result["title"] = norm(self._title_buf)
            self._in_title = False
        elif tag == "script" and self._ld_open:
            self._ld_open = False
            self._finish_ld(self._ld_buf)

    def handle_data(self, data):
        if self._ld_open:
            self._ld_buf += data
            return
        if self._in_title:
            self._title_buf += data

    # -- JSON-LD ---------------------------------------------------------
    def _finish_ld(self, raw):
        raw = raw.strip()
        if raw == "":
            return
        index = self.result["jsonLdCount"] + 1
        self.result["jsonLdCount"] = index
        valid = True
        error = ""
        types = []
        if len(raw) > MAX_JSON_LD_CHARS:
            valid, error = False, f"block too large ({len(raw)} chars > {MAX_JSON_LD_CHARS})"
        else:
            try:
                parsed = json.loads(raw)
            except ValueError as cause:            # json.JSONDecodeError subclasses ValueError
                valid, error = False, str(cause)
            else:
                collect_types(parsed, types)
        if not valid:
            self.result["jsonLdInvalid"] += 1
        if len(self.result["jsonLd"]) >= self._max_ld:
            return
        block = {"index": index, "valid": valid,
                 "types": types[:MAX_JSON_LD_TYPES] if valid else []}
        if not valid:
            block["error"] = norm(error)
        self.result["jsonLd"].append(block)


def extract_meta(html: str, max_json_ld: int = MAX_JSON_LD_BLOCKS):
    parser = MetaOracle()
    parser._max_ld = max_json_ld
    region, truncated = head_region(html)
    parser.feed(region)
    parser.close()
    out = parser.result
    out["truncated"] = truncated
    return out


# --------------------------------------------------------------------------
# §2 fixtures (the same documents the TypeScript tests use)
# --------------------------------------------------------------------------

#: Full metadata fixture shared with test/meta.test.ts.
META_FIXTURE = (
    '<!doctype html>'
    '<html lang="en-GB">'
    '<head>'
    '<meta charset="utf-8">'
    '<title>Widget &amp; Co \u2014 Home</title>'
    '<meta name="description" content="  Widgets for   everyone ">'
    '<meta name="robots" content="index,follow">'
    '<meta name="author" content="A. Author">'
    '<meta property="og:title" content="Widget &amp; Co">'
    '<meta property="og:image" content="/img/hero.png">'
    '<meta property="og:image" content="/img/hero.png">'
    '<meta property="og:image" content="/img/second.png">'
    '<meta property="article:published_time" content="2026-01-02T03:04:05Z">'
    '<meta name="twitter:card" content="summary_large_image">'
    '<meta property="twitter:site" content="@widget">'
    '<link rel="canonical" href="/products/widget">'
    '<link rel="alternate" hreflang="en" href="/en/widget">'
    '<link rel="alternate" hreflang="zh-Hans" href="/zh/widget">'
    '<link rel="alternate" type="application/rss+xml" title="Blog feed" href="/feed.xml">'
    '<link rel="alternate" type="application/atom+xml" href="/atom.xml">'
    '<link rel="icon" href="/favicon.ico">'
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
    '<link rel="icon" href="/favicon.ico">'
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>'
    '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Organization","Brand"]}]}</script>'
    '<script type="application/ld+json">{ this is not json }</script>'
    '<script type="application/ld+json">   </script>'
    '<script>var ignored = 1;</script>'
    '</head>'
    '<body><meta name="description" content="body copy must be ignored">'
    '<link rel="canonical" href="/wrong"></body></html>'
)

#: HTTP-equiv charset fixture (legacy declaration form).
CHARSET_HTTP_EQUIV_FIXTURE = (
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'
    '<title>Legacy</title></head><body></body></html>'
)

#: Unclosed head: the whole document is scanned.
UNCLOSED_FIXTURE = '<html><head><title>No closing head</title><meta name="robots" content="noindex">'


def meta_summary(html: str):
    out = extract_meta(html)
    return {
        "title": out["title"],
        "description": out["description"],
        "canonical": out["canonical"],
        "lang": out["lang"],
        "charset": out["charset"],
        "robots": out["robots"],
        "author": out["author"],
        "openGraphNames": [entry["name"] for entry in out["openGraph"]],
        "openGraphCount": len(out["openGraph"]),
        "twitterNames": [entry["name"] for entry in out["twitter"]],
        "twitterCount": len(out["twitter"]),
        "alternates": [[entry["hreflang"], entry["href"]] for entry in out["alternates"]],
        "alternateCount": len(out["alternates"]),
        "feeds": [[entry["type"], entry["title"], entry["href"]] for entry in out["feeds"]],
        "feedCount": len(out["feeds"]),
        "icons": out["icons"],
        "iconCount": len(out["icons"]),
        "jsonLd": out["jsonLd"],
        "jsonLdCount": out["jsonLdCount"],
        "jsonLdInvalid": out["jsonLdInvalid"],
        "truncated": out["truncated"],
    }


# --------------------------------------------------------------------------
# §3b sitemap / robots oracle (test/sitemap.test.ts)
# --------------------------------------------------------------------------
# A second reader (xml.etree, namespace-agnostic) for the same documents the
# TypeScript regex parser reads, plus an independent regex derivation that
# `--check` compares against it. Fixtures are copied from the test file.

DEFAULT_MAX_URLS = 100          # src/sitemap.ts — web_sitemap default
MAX_URLS_LIMIT = 1_000          # src/sitemap.ts — hard cap
DEFAULT_MAX_SITEMAPS = 5        # src/sitemap.ts
MAX_SITEMAPS_LIMIT = 20         # src/sitemap.ts
MAX_SITEMAP_DEPTH = 2           # src/sitemap.ts — nested index depth
MAX_LOC_CHARS = 2_000           # src/sitemap.ts — per-<loc> cap
MAX_LASTMOD_CHARS = 40          # src/sitemap.ts
MAX_CHANGEFREQ_CHARS = 20       # src/sitemap.ts

ROBOTS_FIXTURE = """# fixture robots
User-agent: *
Disallow: /admin  # keep crawlers out
Crawl-delay: 5

Sitemap: /sitemap-index.xml
Sitemap: /sitemap-a.xml
Sitemap: /sitemap-index.xml
"""

SITEMAP_INDEX_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>/sitemap-a.xml</loc><lastmod>2026-10-20</lastmod></sitemap>
  <sitemap><loc>/sitemap-c.xml</loc></sitemap>
  <sitemap><loc>/sitemap-c.xml</loc></sitemap>
</sitemapindex>"""

SITEMAP_A_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/docs/getting-started</loc><lastmod>2026-10-01</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://example.test/pricing?plan=a&amp;b=1</loc><lastmod>2026-09-20</lastmod><priority>0.8</priority></url>
  <url><loc>/blog/</loc></url>
</urlset>"""

SITEMAP_C_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/about</loc><changefreq>monthly</changefreq><priority>0</priority></url>
  <url><loc>/contact</loc><lastmod>2026-08-15</lastmod></url>
</urlset>"""


def _local(tag: str) -> str:
    """Element name without its XML namespace (`{ns}url` -> `url`)."""
    return tag.rsplit("}", 1)[-1]


def robots_oracle(text: str):
    """Independent robots.txt reader: `Sitemap:` values (deduped) + crawl delay."""
    sitemaps, seen, crawl_delay = [], set(), ""
    for raw in re.split(r"\r\n|\r|\n", text):
        line = raw.split("#")[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if key == "sitemap" and value != "":
            if value not in seen:
                seen.add(value)
                sitemaps.append(value)
        elif key == "crawl-delay" and crawl_delay == "":
            crawl_delay = value
    return {"sitemaps": sitemaps, "crawlDelay": crawl_delay}


def sitemap_oracle(text: str):
    """Independent sitemap reader built on xml.etree (a different engine)."""
    root = ET.fromstring(text)
    kind = _local(root.tag)
    urls, sitemaps = [], []
    if kind == "urlset":
        for node in root:
            if _local(node.tag) != "url":
                continue
            fields = {}
            for child in node:
                fields[_local(child.tag)] = (child.text or "").strip()
            loc = fields.get("loc", "")
            if loc == "":
                continue
            raw_priority = fields.get("priority", "")
            priority = None
            if raw_priority != "":
                try:
                    priority = round(float(raw_priority), 2)
                except ValueError:
                    priority = None
                if priority == 0:
                    priority = 0          # fold -0 into 0
            urls.append({
                "loc": loc,
                "lastmod": fields.get("lastmod", ""),
                "changefreq": fields.get("changefreq", ""),
                "priority": priority,
            })
    elif kind == "sitemapindex":
        for node in root:
            if _local(node.tag) != "sitemap":
                continue
            loc = ""
            for child in node:
                if _local(child.tag) == "loc":
                    loc = (child.text or "").strip()
                    break
            if loc != "" and loc not in sitemaps:
                sitemaps.append(loc)
    else:
        raise ValueError(f"unexpected sitemap root element {kind!r}")
    return {"kind": kind, "urls": urls, "sitemaps": sitemaps}


def regex_sitemap(text: str):
    """Second, regex-only derivation (cross-check for sitemap_oracle)."""
    if re.search(r"<sitemapindex[\s>]", text, re.IGNORECASE):
        children, seen = [], set()
        for match in re.finditer(r"<sitemap(?:\s[^>]*)?>([\s\S]*?)</sitemap>", text, re.IGNORECASE):
            loc = re.search(r"<loc\b[^>]*>([\s\S]*?)</loc>", match.group(1), re.IGNORECASE)
            value = html_unescape(loc.group(1).strip()) if loc is not None else ""
            if value and value not in seen:
                seen.add(value)
                children.append(value)
        return {"kind": "sitemapindex", "urls": [], "sitemaps": children}
    if re.search(r"<urlset[\s>]", text, re.IGNORECASE):
        urls = []
        for match in re.finditer(r"<url(?:\s[^>]*)?>([\s\S]*?)</url>", text, re.IGNORECASE):
            block = match.group(1)

            def field(tag):
                hit = re.search(rf"<{tag}\b[^>]*>([\s\S]*?)</{tag}>", block, re.IGNORECASE)
                return html_unescape(hit.group(1).strip()) if hit is not None else ""

            loc = field("loc")
            if loc == "":
                continue
            raw = field("priority")
            priority = None
            if raw != "":
                try:
                    priority = round(float(raw), 2)
                except ValueError:
                    priority = None
                if priority == 0:
                    priority = 0
            urls.append({"loc": loc, "lastmod": field("lastmod"),
                         "changefreq": field("changefreq"), "priority": priority})
        return {"kind": "urlset", "urls": urls, "sitemaps": []}
    raise ValueError("not a recognized sitemap document")


def html_unescape(value: str) -> str:
    return (value.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&apos;", "'"))


# --------------------------------------------------------------------------
# §3 independent derivations of the same expectations (regex / string ops)
# --------------------------------------------------------------------------

def derive_expectations(html: str):
    region, _ = head_region(html)
    title = re.search(r"<title>(.*?)</title>", region, re.IGNORECASE | re.DOTALL)
    description = re.findall(r'<meta[^>]*name="description"[^>]*content="([^"]*)"', region, re.IGNORECASE)
    lang = re.search(r"<html[^>]*lang=\"([^\"]*)\"", region, re.IGNORECASE)
    og_image = re.findall(r'<meta[^>]*property="og:image"[^>]*content="([^"]*)"', region, re.IGNORECASE)
    og_title = re.findall(r'<meta[^>]*property="og:title"[^>]*content="([^"]*)"', region, re.IGNORECASE)
    article = re.findall(r'<meta[^>]*property="(article:[^"]*)"', region, re.IGNORECASE)
    return {
        "title": (title.group(1).replace("&amp;", "&") if title else "").strip(),
        "description": norm(description[0]) if description else "",
        "lang": lang.group(1) if lang else "",
        # exact duplicates collapse, so the property count is: distinct og:image
        # + every og:title + every article:* property
        "openGraphCount": len(set(og_image)) + len(og_title) + len(article),
        "bodyDescriptionIgnored": "body copy" not in region,
    }


# --------------------------------------------------------------------------
# §3c robots.txt rule engine oracle (RFC 9309) — independent implementation
# --------------------------------------------------------------------------
# The TypeScript side matches patterns by splitting on "*" and walking the
# parts; this oracle compiles the same pattern into a regular expression
# (escape everything, then "*" -> ".*"). Two different algorithms agreeing is
# what makes the expectation trustworthy — the same reasoning as the metadata
# parser-vs-regex cross-check above.

ROBOTS_RULES_FIXTURE = """# rule fixture
User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 10

User-agent: dsh-webfetch
Disallow: /no-webfetch
Allow: /no-webfetch/allowed

User-agent: dsh-webfetch
Disallow: /*.pdf$

User-agent: googlebot
Disallow:

Sitemap: https://example.test/sitemap.xml
Sitemap: https://example.test/sitemap.xml
"""

ROBOTS_TIE_FIXTURE = """User-agent: *
Disallow: /tie
Allow: /tie
Disallow: /deeper
Allow: /deeper/ok
"""

ROBOTS_NO_GROUP_FIXTURE = """User-agent: googlebot
Disallow: /
"""

ROBOTS_ODD_FIXTURE = """Disallow: /orphan
User-agent: *
Disallow: admin
Disallow: /заметки
"""

ROBOTS_UA = "dsh-webfetch/0.7 (DeepSeek Harness plugin)"
ROBOTS_OTHER_UA = "otherbot/1.0"


def robots_octets(value):
    return len(value.encode("utf-8"))


def robots_token(user_agent):
    first = re.split(r"[\s()]", user_agent.strip())[0]
    return first.split("/")[0].lower()


def robots_parse(text):
    groups, sitemaps = [], []
    crawl_delay, current = "", None
    orphan, ignored, line_no = 0, 0, 0
    for raw in text.replace("\ufeff", "").splitlines():
        line_no += 1
        line = raw.split("#")[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip().lower(), " ".join(value.split()).strip()
        if key == "user-agent":
            if not value:
                continue
            if current is None or current["rules"]:
                current = {"agents": [], "rules": []}
                groups.append(current)
            current["agents"].append(value)
        elif key in ("allow", "disallow"):
            if current is None:
                orphan += 1
            elif not value:
                ignored += 1
            else:
                current["rules"].append({"type": key, "pattern": value,
                                         "length": robots_octets(value), "line": line_no})
        elif key == "sitemap" and value and value not in sitemaps:
            sitemaps.append(value)
        elif key == "crawl-delay" and not crawl_delay:
            crawl_delay = value[:20]
    return {"groups": groups, "sitemaps": sitemaps, "crawlDelay": crawl_delay,
            "orphanRules": orphan, "ignoredRules": ignored}


def robots_match(pattern, target):
    """Independent matcher: compile the pattern to a regex (re.match is
    anchored at the start; a trailing "$" anchors the end)."""
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    rx = ".*".join(re.escape(part) for part in body.split("*"))
    return re.match(rx + ("$" if anchored else ""), target) is not None


def robots_select(parsed, token):
    def score(group):
        best = -1
        for agent in group["agents"]:
            if agent == "*":
                continue
            lowered = agent.lower()
            if token.startswith(lowered):
                best = max(best, robots_octets(lowered))
        return best

    scored = [(group, score(group)) for group in parsed["groups"]]
    specific = [(group, value) for group, value in scored if value >= 0]
    if specific:
        best = max(value for _, value in specific)
        winners = [group for group, value in specific if value == best]
        agents, rules = [], []
        for group in winners:
            for agent in group["agents"]:
                if agent != "*" and agent not in agents:
                    agents.append(agent)
            rules.extend(group["rules"])
        return {"kind": "specific", "matchedAgents": agents, "rules": rules}
    wildcard = [group for group, _ in scored if "*" in group["agents"]]
    if wildcard:
        agents, rules = ["*"], []
        for group in wildcard:
            for agent in group["agents"]:
                if agent != "*" and agent not in agents:
                    agents.append(agent)
            rules.extend(group["rules"])
        return {"kind": "wildcard", "matchedAgents": agents, "rules": rules}
    return {"kind": "none", "matchedAgents": [], "rules": []}


def robots_evaluate(text, user_agent, target):
    parsed = robots_parse(text)
    selection = robots_select(parsed, robots_token(user_agent))
    matching = [rule for rule in selection["rules"] if robots_match(rule["pattern"], target)]
    # Longest pattern wins; ties go to Allow (RFC 9309 §2.2.2).
    matching.sort(key=lambda rule: (-rule["length"], 0 if rule["type"] == "allow" else 1, rule["line"]))
    winner = matching[0] if matching else None
    if winner is not None:
        decision = "rule"
    elif selection["kind"] == "none":
        decision = "no-group"
    else:
        decision = "no-matching-rule"
    return {"allowed": True if winner is None else winner["type"] == "allow",
            "decision": decision, "rule": winner,
            "matchedKind": selection["kind"], "matchedAgents": selection["matchedAgents"],
            "ruleCount": len(selection["rules"]), "groupCount": len(parsed["groups"]),
            "ignoredRules": parsed["ignoredRules"], "orphanRules": parsed["orphanRules"],
            "crawlDelay": parsed["crawlDelay"], "sitemaps": parsed["sitemaps"],
            "bytes": robots_octets(text)}


# --------------------------------------------------------------------------
# §4 printable anchors
# --------------------------------------------------------------------------

def print_anchors():
    print("=== dsh-webfetch oracle anchors ===")

    print("\n[1] fixture server contract (test/head.test.ts, fetch, proxy, tools)")
    for status in sorted(FIXTURE_STATUSES):
        print(f"    HTTP {status} {FIXTURE_STATUSES[status]}")

    print("\n[2] documented constants")
    print(f"    MAX_CELL_CHARS = {MAX_CELL_CHARS}")
    print(f"    MAX_TABLE_COLS = {MAX_TABLE_COLS}  (colspan 9999 -> {MAX_TABLE_COLS} columns)")
    print(f"    MAX_META_TEXT = {MAX_META_TEXT}")
    print(f"    MAX_HEAD_SCAN = {MAX_HEAD_SCAN}")
    print(f"    MAX_META_REFS = {MAX_META_REFS}")
    print(f"    MAX_JSON_LD_BLOCKS = {MAX_JSON_LD_BLOCKS}")
    print(f"    MAX_JSON_LD_CHARS = {MAX_JSON_LD_CHARS}")
    print(f"    MAX_JSON_LD_TYPES = {MAX_JSON_LD_TYPES}")

    print("\n[3] config resolution (test/tools.test.ts)")
    print(f"    defaults: timeoutMs=10_000 maxBytes=1_500_000 maxChars=50_000 maxRedirects=3")
    print(f"              (normalized {WEB_FETCH_TIMEOUT_DEFAULT} / {WEB_FETCH_MAX_BYTES_DEFAULT} / "
          f"{WEB_FETCH_MAX_CHARS_DEFAULT} / {WEB_FETCH_MAX_REDIRECTS_DEFAULT})")
    print(f"    overrides: timeoutMs=2_000 maxRedirects=5 maxChars=10_000 maxBytes stays 1_500_000")
    print(f"               (normalized {WEB_FETCH_TIMEOUT_OVERRIDE} / {WEB_FETCH_MAX_REDIRECTS_OVERRIDE} / "
          f"{WEB_FETCH_MAX_CHARS_OVERRIDE})")

    print("\n[4] extraction and tool counts")
    print(f"    html.test.ts: maxChars={MAX_CHARS_FIXTURE} -> content length {MAX_CHARS_FIXTURE}, truncated=true")
    print(f"    tools.test.ts: feed maxItems={FEED_MAX_ITEMS_FIXTURE} -> entryCount {FEED_MAX_ITEMS_FIXTURE}")
    print("    tools.test.ts: /tables fixture -> tableCount 2, totalTables 2; table #2 -> tableCount 1, totalTables 2")
    print("    tools.test.ts: table #9 -> error, table #0 -> error")
    print("    proxy.test.ts: parseHead status line HTTP/1.1 200 OK -> status 200, duplicate x-a headers '1, 2'")

    print("\n[5] table oracle (test/oracle/anchors_table.py)")
    many_rows = "<table>" + "".join(f"<tr><td>r{i}</td></tr>" for i in range(1, 61)) + "</table>"
    many_tables = "".join(f"<table><tr><td>t{i}</td></tr></table>" for i in range(1, 8))
    truncated_cell = "<table><tr><td>" + "a" * 250 + "</td></tr></table>"
    c1 = anchors_table.extract(many_rows, max_rows=50)
    c2 = anchors_table.extract(many_tables, max_tables=5)
    c3 = anchors_table.extract(truncated_cell)
    print(f"    C1 row cap: totalTables={c1['totalTables']} rows kept={len(c1['tables'][0]['rows'])} "
          f"first={c1['tables'][0]['rows'][0]} last={c1['tables'][0]['rows'][-1]}")
    print(f"    C2 table cap: totalTables={c2['totalTables']} emitted={len(c2['tables'])} "
          f"last emitted={c2['tables'][-1]}")
    print(f"    C3 cell truncation: MAX_CELL_CHARS={MAX_CELL_CHARS} -> cell length "
          f"{len(c3['tables'][0]['rows'][0][0])} (200 chars + ellipsis)")
    print(f"    C4 colspan cap: colspan=9999 -> cols={anchors_table.extract(chr(60) + 'table><tr><td colspan=\"9999\">wide</td></tr></table>')['tables'][0]['cols']}")

    print("\n[6] metadata oracle (test/meta.test.ts fixture)")
    summary = meta_summary(META_FIXTURE)
    for key, value in summary.items():
        print(f"    {key}: {json.dumps(value, ensure_ascii=False)}")
    print("\n    legacy charset declaration:")
    print(f"      http-equiv content-type -> charset = {extract_meta(CHARSET_HTTP_EQUIV_FIXTURE)['charset']}")
    print(f"    unclosed head:")
    unclosed = extract_meta(UNCLOSED_FIXTURE)
    print(f"      title = {unclosed['title']!r} robots = {unclosed['robots']!r} truncated = {unclosed['truncated']}")
    print(f"    head scan cap: {MAX_HEAD_SCAN} chars -> truncated = True, metadata beyond the cap dropped")
    many_blocks = "".join(f'<script type="application/ld+json">{{"@type":"T{index}"}}</script>' for index in range(12))
    capped = extract_meta(many_blocks, max_json_ld=3)
    print(f"    json-ld cap: 12 blocks with maxJsonLd=3 -> jsonLdCount {capped['jsonLdCount']}, "
          f"emitted {len(capped['jsonLd'])}")

    print("\n[7] sitemap / robots oracle (test/sitemap.test.ts fixtures)")
    robots = robots_oracle(ROBOTS_FIXTURE)
    print(f"    robots.txt: sitemaps = {robots['sitemaps']} ({len(robots['sitemaps'])}), "
          f"crawlDelay = {robots['crawlDelay']!r}")
    sitemap_a = sitemap_oracle(SITEMAP_A_FIXTURE)
    sitemap_c = sitemap_oracle(SITEMAP_C_FIXTURE)
    sitemap_index = sitemap_oracle(SITEMAP_INDEX_FIXTURE)
    for label, parsed in (("sitemap-a.xml", sitemap_a), ("sitemap-c.xml", sitemap_c)):
        print(f"    {label}: kind={parsed['kind']} urls={len(parsed['urls'])}")
        for entry in parsed["urls"]:
            print(f"      {entry['loc']} lastmod={entry['lastmod']!r} "
                  f"changefreq={entry['changefreq']!r} priority={entry['priority']}")
    print(f"    sitemap-index.xml: kind={sitemap_index['kind']} "
          f"children={sitemap_index['sitemaps']} ({len(sitemap_index['sitemaps'])})")
    distinct = {entry["loc"] for entry in sitemap_a["urls"]} | {entry["loc"] for entry in sitemap_c["urls"]}
    print(f"    combined distinct URLs = {len(distinct)}")
    print("    caps: maxUrls=2 -> urlCount 2, discovered 3, truncated=true")
    print("    caps: maxSitemaps=1 -> sitemapCount 1 (the index only), urlCount 0, truncated=true")
    print("    failure reporting: non-sitemap document -> kind=error; .gz -> kind=gzip; urlCount 0 for both")
    print(f"    documented bounds: maxUrls default {DEFAULT_MAX_URLS} / limit {MAX_URLS_LIMIT}; "
          f"maxSitemaps default {DEFAULT_MAX_SITEMAPS} / limit {MAX_SITEMAPS_LIMIT}; "
          f"nested index depth {MAX_SITEMAP_DEPTH}")
    print(f"    per-value caps: loc {MAX_LOC_CHARS}, lastmod {MAX_LASTMOD_CHARS}, "
          f"changefreq {MAX_CHANGEFREQ_CHARS}")

    print("\n[8] robots.txt rule engine (test/robots.test.ts fixtures)")
    print(f"    user agent {ROBOTS_UA!r} -> token {robots_token(ROBOTS_UA)!r}")
    print(f"    other agent {ROBOTS_OTHER_UA!r} -> token {robots_token(ROBOTS_OTHER_UA)!r}")
    rules_parsed = robots_parse(ROBOTS_RULES_FIXTURE)
    print(f"    rules fixture: groups={len(rules_parsed['groups'])} ignoredRules={rules_parsed['ignoredRules']} "
          f"orphanRules={rules_parsed['orphanRules']} crawlDelay={rules_parsed['crawlDelay']!r} "
          f"sitemaps={len(rules_parsed['sitemaps'])} bytes={robots_octets(ROBOTS_RULES_FIXTURE)}")
    for index, group in enumerate(rules_parsed["groups"]):
        rendered = ", ".join(f"{rule['type']}:{rule['pattern']}({rule['length']}B,line {rule['line']})"
                             for rule in group["rules"]) or "(no rules)"
        print(f"      group {index}: agents={group['agents']} {rendered}")
    rules_cases = [
        ("UA /no-webfetch/x", ROBOTS_UA, "/no-webfetch/x"),
        ("UA /no-webfetch/allowed/x", ROBOTS_UA, "/no-webfetch/allowed/x"),
        ("UA /docs/report.pdf", ROBOTS_UA, "/docs/report.pdf"),
        ("UA /docs/report.pdf?x=1", ROBOTS_UA, "/docs/report.pdf?x=1"),
        ("UA /private/page (wildcard group is not consulted)", ROBOTS_UA, "/private/page"),
        ("other /private/page", ROBOTS_OTHER_UA, "/private/page"),
        ("other /private/public/x", ROBOTS_OTHER_UA, "/private/public/x"),
        ("googlebot /x (empty group)", "googlebot/2.1", "/x"),
        ("googlebot /no-webfetch/x (other agent's rules ignored)", "googlebot/2.1", "/no-webfetch/x"),
    ]
    for label, agent, target in rules_cases:
        result = robots_evaluate(ROBOTS_RULES_FIXTURE, agent, target)
        rule = result["rule"]
        rendered = ("none" if rule is None else
                    f"{rule['type']} {rule['pattern']} len={rule['length']} line={rule['line']}")
        print(f"    {label}: allowed={result['allowed']} decision={result['decision']} rule={rendered} "
              f"matched={result['matchedKind']}:{result['matchedAgents']} groupRules={result['ruleCount']}")
    tie = robots_evaluate(ROBOTS_TIE_FIXTURE, ROBOTS_OTHER_UA, "/tie")
    deeper = robots_evaluate(ROBOTS_TIE_FIXTURE, ROBOTS_OTHER_UA, "/deeper/x")
    print(f"    tie fixture /tie: allowed={tie['allowed']} rule={tie['rule']['type']} "
          f"len={tie['rule']['length']} (Allow wins the tie)")
    print(f"    tie fixture /deeper/x: allowed={deeper['allowed']} rule={deeper['rule']['type']} "
          f"len={deeper['rule']['length']}")
    no_group = robots_evaluate(ROBOTS_NO_GROUP_FIXTURE, ROBOTS_UA, "/")
    print(f"    no-group fixture: allowed={no_group['allowed']} decision={no_group['decision']} "
          f"matched={no_group['matchedKind']}:{no_group['matchedAgents']} groupRules={no_group['ruleCount']}")
    odd_parsed = robots_parse(ROBOTS_ODD_FIXTURE)
    odd = robots_evaluate(ROBOTS_ODD_FIXTURE, ROBOTS_OTHER_UA, "/admin")
    odd_cyrillic = robots_evaluate(ROBOTS_ODD_FIXTURE, ROBOTS_OTHER_UA, "/заметки/x")
    print(f"    odd fixture: orphanRules={odd_parsed['orphanRules']} rule lengths="
          f"{[rule['length'] for rule in odd_parsed['groups'][0]['rules']]}")
    print(f"    odd fixture /admin: allowed={odd['allowed']} decision={odd['decision']} (a bare \"admin\" pattern cannot match \"/admin\")")
    print(f"    odd fixture /заметки/x: allowed={odd_cyrillic['allowed']} len={odd_cyrillic['rule']['length']} "
          f"(UTF-8 octets, not characters)")
    empty = robots_evaluate("", ROBOTS_UA, "/")
    print(f"    empty document: allowed={empty['allowed']} decision={empty['decision']} bytes={empty['bytes']}")
    print("    matcher table: '/private' vs '/private/x' True, vs '/x/private' False; "
          "'/*.pdf$' vs '/a.pdf' True, vs '/a.pdf?q=1' False; '/a*b$' vs '/aXb' True, vs '/aXb/' False; "
          "'/' vs '/anything' True; '/x$' vs '/x' True, vs '/x/' False")
    print(f"    documented bounds: maxRules default {DEFAULT_ROBOTS_MAX_RULES} / limit {ROBOTS_MAX_RULES_LIMIT}; "
          f"file size limit {ROBOTS_FILE_SIZE_LIMIT} bytes (RFC 9309 §2.5)")
    print("    tool end-to-end statuses: 200 -> parsed rules; 404 -> decision no-robots (allowed); "
          "503 -> decision unavailable (assume disallowed)")


# --------------------------------------------------------------------------
# §5 self-check — public values, definitional identities and cross-derivation
# --------------------------------------------------------------------------

def check():
    failures = []

    def expect(label, got, want):
        if got != want:
            failures.append(f"{label}: got {got!r}, want {want!r}")

    # (a) status texts come from the stdlib registry, not from our own table.
    for status, text in FIXTURE_STATUSES.items():
        expect(f"http.HTTPStatus({status}).phrase", http.HTTPStatus(status).phrase, text)

    # (b) metadata fixture: parser output vs regex-derived expectation.
    derived = derive_expectations(META_FIXTURE)
    summary = meta_summary(META_FIXTURE)
    expect("title (parser vs regex)", summary["title"], derived["title"])
    expect("description (parser vs regex)", summary["description"], derived["description"])
    expect("lang (parser vs regex)", summary["lang"], derived["lang"])
    expect("og property count (parser vs regex)", summary["openGraphCount"], derived["openGraphCount"])
    expect("body meta ignored", derived["bodyDescriptionIgnored"], True)
    expect("description from head, not body", summary["description"], "Widgets for everyone")
    expect("canonical raw href", summary["canonical"], "/products/widget")
    expect("robots", summary["robots"], "index,follow")
    expect("author", summary["author"], "A. Author")
    expect("charset", summary["charset"], "utf-8")
    expect("alternates", summary["alternates"], [["en", "/en/widget"], ["zh-Hans", "/zh/widget"]])
    expect("feeds", summary["feeds"],
           [["application/rss+xml", "Blog feed", "/feed.xml"], ["application/atom+xml", "", "/atom.xml"]])
    expect("icons deduplicated", summary["icons"], ["/favicon.ico", "/apple-touch-icon.png"])
    expect("json-ld blocks counted", summary["jsonLdCount"], 3)
    expect("blank json-ld block skipped", summary["jsonLdCount"], 3)
    expect("json-ld invalid counted", summary["jsonLdInvalid"], 1)
    expect("json-ld types from @graph",
           summary["jsonLd"][1]["types"], ["WebPage", "Organization", "Brand"])
    expect("json-ld first block", summary["jsonLd"][0], {"index": 1, "valid": True, "types": ["Product"]})
    expect("json-ld third block invalid", summary["jsonLd"][2]["valid"], False)
    expect("truncated flag", summary["truncated"], False)

    # (c) documented semantics on the edge fixtures.
    expect("http-equiv charset", extract_meta(CHARSET_HTTP_EQUIV_FIXTURE)["charset"], "iso-8859-1")
    unclosed = extract_meta(UNCLOSED_FIXTURE)
    expect("unclosed head scanned", (unclosed["title"], unclosed["robots"]), ("No closing head", "noindex"))
    expect("unclosed head not truncated", unclosed["truncated"], False)
    long_value = '<html><head><meta name="description" content="' + "x" * (MAX_META_TEXT + 50) + '">'
    capped = extract_meta(long_value)["description"]
    expect("value cap length", len(capped), MAX_META_TEXT + 1)
    expect("value cap ellipsis", capped.endswith("\u2026"), True)
    capped_ld = extract_meta('<html><head><script type="application/ld+json">' + "{" * (MAX_JSON_LD_CHARS + 1) + "</script>")
    expect("oversized json-ld rejected", (capped_ld["jsonLdCount"], capped_ld["jsonLdInvalid"]), (1, 1))
    expect("oversized json-ld error", capped_ld["jsonLd"][0]["valid"], False)
    limited = extract_meta(
        "".join(f'<script type="application/ld+json">{{"@type":"T{i}"}}</script>' for i in range(12)),
        max_json_ld=3,
    )
    expect("json-ld cap honoured", (limited["jsonLdCount"], len(limited["jsonLd"])), (12, 3))

    # (d) table oracle: public definitional cases (rowspan/colspan geometry).
    expect("colspan cap", anchors_table.extract('<table><tr><td colspan="9999">w</td></tr></table>')["tables"][0]["cols"], MAX_TABLE_COLS)
    expect("rowspan repeats text", anchors_table.extract(
        '<table><tr><td rowspan="2">x</td><td>1</td></tr><tr><td>2</td></tr></table>')["tables"][0]["rows"],
        [["x", "1"], ["x", "2"]])
    expect("cell cap", anchors_table.MAX_CELL, MAX_CELL_CHARS)

    # (e) sitemap oracle: two readers (xml.etree vs regex) must agree, and the
    #     documented invariants of the format must hold.
    for label, document in (("sitemap-a", SITEMAP_A_FIXTURE),
                            ("sitemap-c", SITEMAP_C_FIXTURE),
                            ("sitemap-index", SITEMAP_INDEX_FIXTURE)):
        expect(f"{label}: etree vs regex kind", sitemap_oracle(document)["kind"], regex_sitemap(document)["kind"])
        expect(f"{label}: etree vs regex urls", sitemap_oracle(document)["urls"], regex_sitemap(document)["urls"])
        expect(f"{label}: etree vs regex children",
               sitemap_oracle(document)["sitemaps"], regex_sitemap(document)["sitemaps"])
    parsed_a = sitemap_oracle(SITEMAP_A_FIXTURE)
    expect("urlset entries", len(parsed_a["urls"]), 3)
    expect("every loc non-empty", all(entry["loc"] for entry in parsed_a["urls"]), True)
    expect("priority range", all(entry["priority"] is None or 0 <= entry["priority"] <= 1
                                for entry in parsed_a["urls"]), True)
    expect("entity-decoded loc", parsed_a["urls"][1]["loc"], "https://example.test/pricing?plan=a&b=1")
    expect("explicit priority 1.0", parsed_a["urls"][0]["priority"], 1)
    expect("absent priority is None", parsed_a["urls"][2]["priority"], None)
    expect("zero priority folds to 0", sitemap_oracle(SITEMAP_C_FIXTURE)["urls"][0]["priority"], 0)
    expect("index children deduplicated", len(sitemap_oracle(SITEMAP_INDEX_FIXTURE)["sitemaps"]), 2)
    expect("index carries no urls", sitemap_oracle(SITEMAP_INDEX_FIXTURE)["urls"], [])
    robots = robots_oracle(ROBOTS_FIXTURE)
    expect("robots sitemaps deduplicated", robots["sitemaps"], ["/sitemap-index.xml", "/sitemap-a.xml"])
    expect("robots crawl delay", robots["crawlDelay"], "5")
    expect("robots ignores the commented-out disallow", "keep crawlers out" in robots["sitemaps"], False)
    expect("documented maxUrls default", DEFAULT_MAX_URLS, 100)
    expect("documented maxUrls limit", MAX_URLS_LIMIT, 1000)
    expect("documented maxSitemaps default", DEFAULT_MAX_SITEMAPS, 5)
    expect("documented maxSitemaps limit", MAX_SITEMAPS_LIMIT, 20)

    # (f) robots.txt rule engine: RFC 9309 semantics used as rulers, plus a
    # pattern-matcher table derived from the definitions (not from the code).
    expect("robots token of our UA", robots_token(ROBOTS_UA), "dsh-webfetch")
    expect("robots token of another UA", robots_token(ROBOTS_OTHER_UA), "otherbot")
    matcher_table = [
        ("/private", "/private/x", True),
        ("/private", "/x/private", False),
        ("/*.pdf$", "/a/report.pdf", True),
        ("/*.pdf$", "/a/report.pdf?q=1", False),
        ("/a*b$", "/aXb", True),
        ("/a*b$", "/aXb/", False),
        ("/", "/anything", True),
        ("/", "", False),
        ("/x$", "/x", True),
        ("/x$", "/x/", False),
        ("*", "/whatever", True),
        ("/a$b", "/a$b/x", True),
    ]
    for pattern, target, want in matcher_table:
        expect(f"matcher {pattern!r} vs {target!r}", robots_match(pattern, target), want)
    parsed_rules = robots_parse(ROBOTS_RULES_FIXTURE)
    expect("rules fixture group count", len(parsed_rules["groups"]), 4)
    expect("rules fixture empty Disallow ignored", parsed_rules["ignoredRules"], 1)
    expect("rules fixture orphan rules", parsed_rules["orphanRules"], 0)
    expect("rules fixture crawl delay", parsed_rules["crawlDelay"], "10")
    expect("rules fixture sitemaps deduplicated", len(parsed_rules["sitemaps"]), 1)
    for group in parsed_rules["groups"]:
        for rule in group["rules"]:
            expect(f"pattern length in octets {rule['pattern']!r}",
                   rule["length"], len(rule["pattern"].encode("utf-8")))
    # A specific group is used instead of `*` (RFC 9309 §2.2.1).
    specific = robots_evaluate(ROBOTS_RULES_FIXTURE, ROBOTS_UA, "/private/disallowed-in-star")
    expect("specific group beats the wildcard group", specific["decision"], "no-matching-rule")
    wildcard = robots_evaluate(ROBOTS_RULES_FIXTURE, ROBOTS_OTHER_UA, "/private/page")
    expect("wildcard group applies when nothing is specific", wildcard["matchedKind"], "wildcard")
    expect("wildcard group disallows /private", wildcard["allowed"], False)
    # Longest match wins, Allow wins the tie (§2.2.2).
    expect("longer Allow beats shorter Disallow",
           robots_evaluate(ROBOTS_RULES_FIXTURE, ROBOTS_OTHER_UA, "/private/public/x")["allowed"], True)
    expect("longer Disallow beats shorter Allow",
           robots_evaluate(ROBOTS_TIE_FIXTURE, ROBOTS_OTHER_UA, "/deeper/x")["allowed"], False)
    tie = robots_evaluate(ROBOTS_TIE_FIXTURE, ROBOTS_OTHER_UA, "/tie")
    expect("equal-length tie goes to Allow", (tie["allowed"], tie["rule"]["type"]), (True, "allow"))
    expect("tie winner length equals the pattern length", tie["rule"]["length"], robots_octets("/tie"))
    # `$` anchors the end, so a query string is a different path.
    expect("anchored pattern does not match a query variant",
           robots_evaluate(ROBOTS_RULES_FIXTURE, ROBOTS_UA, "/docs/report.pdf?x=1")["decision"],
           "no-matching-rule")
    expect("anchored pattern matches the plain path",
           robots_evaluate(ROBOTS_RULES_FIXTURE, ROBOTS_UA, "/docs/report.pdf")["allowed"], False)
    # No group at all: everything allowed, and it says why.
    no_group = robots_evaluate(ROBOTS_NO_GROUP_FIXTURE, ROBOTS_UA, "/")
    expect("no matching group allows", (no_group["allowed"], no_group["decision"]), (True, "no-group"))
    expect("no matching group reports the wildcard absence", no_group["matchedKind"], "none")
    # Groups never borrow rules across user agents.
    expect("another agent's rules do not leak",
           robots_evaluate(ROBOTS_RULES_FIXTURE, "googlebot/2.1", "/no-webfetch/x")["decision"],
           "no-matching-rule")
    # A bare pattern without a leading slash can never match a path.
    expect("orphan rule line ignored",
           robots_parse(ROBOTS_ODD_FIXTURE)["orphanRules"], 1)
    expect("bare pattern cannot match a path",
           robots_evaluate(ROBOTS_ODD_FIXTURE, ROBOTS_OTHER_UA, "/admin")["decision"], "no-matching-rule")
    expect("non-ASCII pattern length is octets",
           robots_evaluate(ROBOTS_ODD_FIXTURE, ROBOTS_OTHER_UA, "/заметки/x")["rule"]["length"],
           robots_octets("/заметки"))
    expect("octets of a 7-letter Cyrillic segment", robots_octets("/заметки"), 15)
    empty = robots_evaluate("", ROBOTS_UA, "/")
    expect("empty robots.txt allows everything", (empty["allowed"], empty["decision"], empty["bytes"]),
           (True, "no-group", 0))
    expect("documented robots bounds",
           (DEFAULT_ROBOTS_MAX_RULES, ROBOTS_MAX_RULES_LIMIT, ROBOTS_FILE_SIZE_LIMIT), (50, 200, 512000))

    if failures:
        print("oracle self-check FAILED:")
        for line in failures:
            print(f"  ✗ {line}")
        return 1
    print(f"oracle self-check OK ({len(FIXTURE_STATUSES)} statuses, metadata + table oracles cross-checked)")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv[1:]:
        sys.exit(check())
    print_anchors()
