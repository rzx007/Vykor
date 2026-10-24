# Aora 上游引擎

这里保存 aora-bot 固定版本 `e3b6148c818da4a8e1966f2bc89cdb3cee473b73` 的原始脚本与许可文件，供父目录的头像适配调用。

- `rings.js`、`emotions.js` 提供形状与表情数据，`ball.js` 创建 SVG，`engine.js` 提供 `window.EmotionBall.create` 入口并管理动画实例。
- 父目录的 `aora-runtime.ts` 按上述顺序加载脚本、创建实例，并在页面隐藏或减少动态效果时暂停动画；卸载时销毁实例。动画状态由引擎实例持有，SVG 输出到调用方提供的容器。
- [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)、[LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) 保留上游原文；桌面打包配置将这三份文件放入发行包。

上游脚本保持原样，新增 React 展示或生命周期适配放在父目录。更新上游时同步核对固定版本、四份脚本与三份许可文件。
