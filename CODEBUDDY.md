# Aperture 项目开发守则

## 重大变更需获批

任何重大逻辑变动（超出纯 Bug 修复或文档更新范围的架构变更、功能修改、流程重构），必须先向用户说明并获得明确同意后方可执行。不得自行决定。

## 改动原则：连带修改所有关联部分

修改代码时必须连带修改所有关联部分，不能只改一处。改动前先理清依赖链：配置项、接口签名、环境变量、Secret、测试用例、部署配置等所有相关方一并更新。改一处漏一处会导致 Bug 越来越多。

## 排错流程：先查日志再分析

遇到错误时，第一步骤是检查 Worker 日志（`wrangler tail`）和 Cloudflare Dashboard 的 Observability 日志，获取原始错误信息后再分析原因。不得跳过日志排查直接猜测问题。

## 项目定位

Aperture 是纯协议翻译层。

- **Worker 只做**：接收请求 → 检测协议格式 → 翻译为 Chat Completions → 转发给 AI Gateway → 翻译响应 → 返回
- **Worker 不管**：认证（由 AI Gateway 处理）、限速（由 AI Gateway 处理）、模型映射（统一固定为 `deepseek-v4-flash`）、请求体大小限制（由 Cloudflare 平台处理）
