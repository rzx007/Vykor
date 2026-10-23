# @vykor/themes

提供内置主题和当前主题管理，供终端或其他界面读取统一的颜色字段。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/themes` 导入 `ThemeManager`、主题类型和内置主题。

| 目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 主题字段、管理器和公开导出 |
| [src/builtin](src/builtin/README.md) | 五个内置主题与默认注册列表 |
| [src/__test__](src/__test__) | 主题注册、选择和读取测试 |

`ThemeManager` 创建时注册内置主题并选择 `default`，调用方可注册主题、调用 `setActive()` 切换，再用 `getActive()` 读取定义。主题表和当前名称只保存在实例内存中；实际渲染和选择的长期保存由界面宿主负责。

新增内置配色放 `src/builtin/`，主题管理逻辑放 `src/`，测试放在实现所属目录的同层 `__test__/`。

## 测试

```bash
pnpm --filter @vykor/themes test
```
