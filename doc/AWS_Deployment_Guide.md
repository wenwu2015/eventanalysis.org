# EventAnalysis.org AWS 部署指南

本项目采用 Route 53 + ACM + S3 静态网站端点 + CloudFront。公开页面全部是构建时生成的 HTML/CSS；CloudFront 只处理 canonical URL、根路径语言选择、安全响应头和缓存。

## 生产架构

```text
GoDaddy（仅保留注册商）
  -> Route 53（DNS 托管）
  -> CloudFront（HTTPS / CDN / 根路径语言分流）
  -> S3 website endpoint（dist/client 静态文件）
```

- 正式域名：`https://eventanalysis.org`
- `www.eventanalysis.org`：301 到无 `www` 正式域名
- S3 bucket：`eventanalysis.org`
- CloudFront distribution：`EPXANA1AARBLN`
- CloudFront 临时域名：`d3j6lm0zu6uu8t.cloudfront.net`
- ACM 区域：`us-east-1`（CloudFront 强制要求）
- 资源索引：`ops/aws/deployment.json`

## GoDaddy 名称服务器

GoDaddy 只负责域名注册，DNS 托管必须在“名称服务器 / Nameservers”设置中改为：

```text
ns-716.awsdns-25.net
ns-1118.awsdns-11.org
ns-73.awsdns-09.com
ns-1862.awsdns-40.co.uk
```

不要把它们作为普通 NS 记录添加在 GoDaddy DNS 记录表中；必须替换注册商当前的 `domaincontrol.com` 名称服务器。

## 语言路由

只有根路径 `/` 读取浏览器标准 `Accept-Language`：

- `zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant` -> `/zh-hant/`
- 其他中文 -> `/zh/`
- 支持的地区变体按基础语言匹配，例如 `pt-BR` -> `/pt/`
- 不支持或缺失语言 -> `/en/`

这是 CloudFront Viewer Request 的 302，不写 Cookie、不保存访客状态。进入显式语言 URL 后不再自动改写；每个页面的原生 HTML 语言菜单仍可手动切换。

## 日常发布

```bash
cd /Users/a1111/Desktop/workspace/Five/project/eventanalysis.org
npm run release:aws
```

发布脚本会依次执行 lint、全部测试和静态构建，将 `dist/client` 增量同步到 S3，删除已下线文件，并创建 CloudFront 全站失效请求。共享 assets 使用一年 immutable 缓存；HTML、XML 和文本默认使用五分钟缓存。

底层命令：

```bash
aws s3 sync dist/client s3://eventanalysis.org --delete
aws cloudfront create-invalidation --distribution-id EPXANA1AARBLN --paths "/*"
```

## 验证

```bash
dig +short NS eventanalysis.org
curl -sI -H 'Accept-Language: ja-JP' https://eventanalysis.org/
curl -sI https://www.eventanalysis.org/
curl -sI https://eventanalysis.org/en/
curl -sI https://eventanalysis.org/not-found
```

预期：根路径日文请求 302 到 `/ja/`；`www` 301 到根域；显式语言页 200；不存在页面返回自定义 404。响应应包含 HSTS、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、Referrer Policy 和 Permissions Policy。

## 回滚

S3 没有数据库或运行时状态。回滚时从 Git checkout 到已知提交，运行 `npm run release:aws` 即可覆盖静态对象并刷新 CloudFront。域名层回滚只需将 Route 53 Alias 指向旧目标；不要删除 Hosted Zone 或证书作为日常回滚方式。
