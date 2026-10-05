---
version: 1
slug: "ponents-desktop-notes-page-notes-page-tsx-d42ba752"
primary_target: "apps/desktop/src/renderer/src/components/desktop/notes-page/notes-page.tsx"
related_targets: ["apps/desktop/src/renderer/src/components/desktop/notes-page/note-editor.tsx","apps/desktop/src/renderer/src/components/desktop/notes-page/note-list.tsx","apps/desktop/src/renderer/src/components/motion/project-folder.tsx"]
---

# 便签桌面与收纳夹

范围：现有全局便签的 Operate（快速完成记录任务）界面；本地 Markdown、自动保存和错误恢复继续沿用原逻辑。

## Direction contract

THESIS：打开就有可写的纸片，旧想法可以铺开找回，也可以收成一叠。

OWN-WORLD：沿用 Vykor 的语义颜色、默认字体、圆润 Lucide 图标和控件。纸片是可独立操作的真实便签对象，不是页面外壳；不增加彩色分类、手写字体或自由拖拽画布。

STORY：有恢复稿时先恢复，否则打开空白本地纸片。写下后自动存好，收起不归档也不删除。两种形态使用同一份数据。

FIRST VIEWPORT：顶部紧凑工具栏保留桌面／收纳切换、搜索和记一句。默认桌面左侧为可写纸片，右侧为近期卡片；窄窗口改为纵向。长便签可展开阅读。

FORM：用户明确批准的双形态，不进行随机方案选择。收纳采用 beUI project-folder，最多五张封面预览，展开内容浏览全部便签；卡片可取出编辑，Escape 收回并还原焦点。

FINISH：完成必要的功能测试、类型和局部代码检查。按用户约定不搭预览、不截图、不主动验收样式，由用户实际查看反馈；保留未保存草稿及清楚的失败提示。
