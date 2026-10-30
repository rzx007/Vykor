import {rm} from 'node:fs/promises';
import {defineConfig} from 'astro/config';
import starlight from '@astrojs/starlight';
import {typeDocSidebarGroup} from 'starlight-typedoc';
import apiReference from './config/api-reference';
import {documentationBase,documentationSite} from './config/site.mjs';

export default defineConfig({
  site: documentationSite(process.env.CLIENT_DOCS_SITE),
  base: documentationBase(process.env.CLIENT_DOCS_BASE),
  trailingSlash: 'always',
  // Keep Astro's cookie implementation in the prerender bundle; pnpm does not hoist it into this app.
  vite: {resolve: {noExternal: ['cookie']}},
  integrations: [starlight({
    title: 'Vykor Client SDK',
    description: '连接已有 daemon，管理 Agent 生命周期、权限和同步恢复。',
    defaultLocale: 'root',
    locales: {root: {label: '简体中文',lang: 'zh-CN'}},
    social: [{icon: 'github',label: 'GitHub',href: 'https://github.com/rzx007/Vykor'}],
    editLink: {baseUrl: 'https://github.com/rzx007/Vykor/edit/main/apps/client-docs/'},
    customCss: ['./src/styles/custom.css'],
    plugins: [apiReference],
    sidebar: [
      {label: '总览',slug: ''},
      {label: '快速开始',items: [
        {label: '安装与连接',slug: 'getting-started/installation'},
        {label: '第一个 Agent 任务',slug: 'getting-started/first-run'},
      ]},
      {label: '核心概念',items: [{label: '会话与运行生命周期',slug: 'concepts/lifecycle'}]},
      {label: '使用指南',items: [
        {label: '会话与输入',slug: 'guides/sessions'},
        {label: '权限处理',slug: 'guides/permissions'},
        {label: '事件同步与恢复',slug: 'guides/sync-recovery'},
        {label: '工作区文件',slug: 'guides/files'},
        {label: '附件与后台任务',slug: 'guides/attachments-jobs'},
        {label: '结构化交付',slug: 'guides/structured-delivery'},
        {label: '错误与兼容性',slug: 'guides/errors-compatibility'},
        {label: '可选本机服务管理',slug: 'guides/local-service'},
      ]},
      {label: '参考说明',slug: 'reference/overview'},
      typeDocSidebarGroup,
    ],
  }),{
    name: 'exclude-maintenance-readme',
    hooks: {
      // public/ requires a repository README, but it is not a published asset.
      'astro:build:done': async ({dir})=>{await rm(new URL('README.md',dir),{force:true});},
    },
  }],
});
