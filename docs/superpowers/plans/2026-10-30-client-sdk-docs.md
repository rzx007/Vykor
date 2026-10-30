# Vykor Client SDK Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立工作区包中交付可构建、可搜索、带真实 SDK 示例和自动 API 参考的公开文档站。

**Architecture:** Starlight 展示手写指南；TypeDoc 从两个构建声明入口生成参考；示例独立检查且直接嵌入页面。已有 Pages workflow 将文档与官网组合部署。

**Tech Stack:** pnpm workspace、Astro、Starlight、TypeDoc、starlight-typedoc、TypeScript、GitHub Actions。

**Spec:** [设计与验收](../specs/2026-10-30-client-sdk-docs-design.md)

## Global Constraints

- 不修改 SDK 公开范围，不在文档站依赖私有 application-client。
- 仅从 `packages/client/dist/index.d.ts` 和 `packages/client/dist/service.d.ts` 生成 API。
- 示例构建不发送请求；文档站保留根路径和 `client-sdk/` 子路径部署能力。
- 不覆盖现有官网，不触发远端发布，不自动提交本轮代码。

## Task 1: 站点工作区与构建

- [x] 新建 `apps/client-docs/package.json`、`astro.config.ts`、`tsconfig.json`、内容集合配置与样式；接入现有 workspace。
- [x] 增加根命令、忽略生成文件，保持文档站独立启动与构建。
- [x] 执行依赖安装与最小页面构建，确认包版本和 Node 要求匹配。

## Task 2: API 参考

- [x] 配置 `config/api-reference.ts` 和 API 专用 tsconfig，接入 Starlight 插件。
- [x] 对生成入口和公开范围编写行为检查，先看到错误范围被拒绝，再验证正确配置。
- [x] 从构建声明生成参考，核对主入口和 service 入口链接。

## Task 3: 示例与中文指南

- [x] 在 `examples/` 整理安装连接、任务与权限、事件、文件、本机服务示例。
- [x] 增加示例类型检查配置，纠正与当前 SDK 声明不符的调用。
- [x] 在 `src/content/docs/` 编排首页、指南、概念、错误与参考入口，直接展示示例源码。
- [x] 为新增分类写 README，维护说明不进入公开文档集合。

## Task 4: 构建检查与发布接入

- [x] 对站内链接和部署前缀检查编写有成功/失败夹具的测试，再实现构建产物检查。
- [x] 为现有 `.github/workflows/pages.yml` 增加文档构建与组合输出，保留官网。
- [x] 更新根 README、SDK README、现有 SDK 文档的文档站入口与开发说明。

## Task 5: 验证与复审

- [x] 执行站点类型检查、示例检查、脚本测试、根路径及子路径构建检查。
- [x] 执行 `pnpm check-docs`、`pnpm check:retired-ui`、`git diff --check`。
- [x] 独立 review 内容、API 边界、构建与部署；修复确认的问题并报告实际验证结果。

## 已验证结果与收尾

- `pnpm --filter @vykor/client-docs check-types`：Astro 检查 17 个文件，0 错误、0 警告、0 提示；Node 和浏览器示例均通过 TypeScript 检查。
- `pnpm docs:check`：SDK 构建、站点及示例类型检查、12 项测试通过，包含实际 TypeDoc 输出、站内链接、部署配置、维护 README 产物排除、权限重复回复与 409 竞争处理。
- `pnpm docs:build` 在 `/Vykor/client-sdk/` 前缀下构建成功；根路径独立构建也成功。两种模式均生成 199 页，API、Pagefind 搜索、站内链接和静态资源检查通过。
- 仓库文档检查与 retired-ui 检查通过；`git diff --check` 通过。
- 现有官网 64 项测试与 `/Vykor/` 前缀构建通过。
- 已完成独立内容与构建复审，修复权限回复重复处理、Pages 触发范围遗漏和维护 README 进入产物的问题。修复后 `pnpm docs:check`、根路径及 `/Vykor/client-sdk/` 子路径构建全部通过；最终复核未发现遗留问题。
- 本轮未提交代码、未推送，也未触发远端部署。
