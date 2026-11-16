# CHANGELOG · dsh-webfetch

> 版本口径：patch 修 bug/补测试｜minor 新增用户可见功能｜major 破坏性变更。安装：`dsh plugin --profile web add github:TYEclipse/dsh-webfetch`

## [0.7.1] — 2026-11-17
### Patch · R102
- [自主进化] R102 修 web_robots 的 note 文案：原来把示例 pattern 硬编码成 admin

## [0.7.0] — 2026-11-17
### Minor · R102
- [自主进化] R102 新增 web_robots：RFC 9309 robots.txt 规则判定（组选择 / * 与 $ 通配 / 最长匹配 + Allow 胜平局 / 4xx 无规则、5xx 视为禁止）

## [0.6.0] — 2026-10-28
### Minor · R82
- [自主进化] R82 新增 web_sitemap——从 robots.txt 的 Sitemap 指令枚举整站 URL（跟随 sitemap 索引、lastmod/changefreq/priority、相对地址解析、重复折叠；失败与 gzip 带因列出不中断），oracle 扩 sitemap 区（ElementTree 与正则双读对拍）

## [0.5.0] — 2026-10-10
### Minor · R65
- [自主进化] R65 新增 web_meta（元数据读取：canonical/Open Graph/Twitter/hreflang/订阅源自动发现/图标/JSON-LD，解析失败如实报错）+ oracle 迁到 test/oracle/anchors.py（7 测试文件全带标记，双引擎自检）

## [0.4.0] — 2026-09-17
### Minor · R41
- [自主进化] R41 新增 web_table——HTML 表格结构化提取（表头识别 / colspan·rowspan 网格展开 / 行列上限），oracle 锚点 25 fixture，测试 97→125

## [0.3.2] — 2026-09-11
### Patch · R31
- [自主进化] 接入版本与覆盖率门禁（工具链）

## [0.3.1] — 2026-09-11
### Patch · R31
- [自主进化] 接入版本与覆盖率门禁（工具链）

