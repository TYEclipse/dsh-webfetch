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
