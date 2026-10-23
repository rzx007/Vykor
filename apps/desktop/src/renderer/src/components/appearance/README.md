# 外观设置

此目录负责主题、颜色、字体、字号、减少动态效果和窗口材质偏好。外观设置入口为 `appearance-settings.tsx`，应用根部通过 `appearance-provider.tsx` 读取并应用设置。

- `appearance-preferences.ts` 定义默认值并校验已保存的数据；偏好保存在当前窗口的 `localStorage`，键名为 `vykor-desktop-appearance-v1`。
- `appearance-fonts.ts` 定义字体选项和后备顺序，检测固定本地字体是否可用；缺少已选本地字体时回到随应用携带的字体。
- `appearance-provider.tsx` 把偏好写入根元素的 CSS 变量。正文读取 `--font-sans`，代码读取 `--font-mono`；终端和插件页面复用这些变量。
- `appearance-colors.ts` 负责从用户选择的颜色派生各界面表面的颜色。

默认正文按西文、中文、`sans-serif` 排列，默认代码按系统等宽字体、`monospace` 排列。修改默认字体时，同步更新 `../../assets/main.css`、`../../../index.html` 的启动画面、`../../../../document-preview/style.css` 和 [设计基线](../../../../../DESIGN.md)。既有字体选项的标识用于恢复保存值，不能随意改名或删除。

新增外观偏好应把默认值、读取校验、根变量应用和设置入口一起放在本目录；新增测试放在 `__test__/`。终端独立偏好和具体业务页面样式留在各自功能目录。
