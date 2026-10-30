# opalite翻译

在网页和 PDF 中翻译选中文字，支持接入自己的 OpenAI 兼容 API。

![网页翻译浮窗](docs/opalite-popup-preview.png)

## 安装

适用于 Chrome / Edge 141 及以上版本。

1. [下载扩展包](https://raw.githubusercontent.com/guiltyassin13/selected-line-translator/main/dist/opalite-translator-v1.6.1.zip)，解压到固定目录。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式。
3. 点击“加载解压缩的扩展”，选择包含 `manifest.json` 的目录。从源码安装时，选择 `extension` 文件夹。

更新时，覆盖原目录中的文件，点击扩展卡片的“重新加载”，再刷新网页。

## 配置 API

点击浏览器工具栏中的 opalite 图标，填写以下三项：

| 配置项 | 填写内容 |
| --- | --- |
| API 地址 | 服务商的 OpenAI 兼容接口地址，支持基础地址或完整的 `/chat/completions` 地址 |
| API Key | 服务商提供的密钥 |
| 模型名称 | 要使用的模型，按服务商文档填写 |

点击“保存并测试”检查连接。目标语言默认为简体中文，可在设置中修改；接口不支持流式输出时，可关闭流式选项。

## 使用

- **网页**：选中文字，按 `Alt+Shift+Y`，或右键点击“翻译选中内容”，译文会显示在选区旁的浮窗中。
- **PDF**：在浏览器自带阅读器中选中文字，右键点击“翻译选中内容”，译文会显示在侧栏中。支持在线和本地 PDF，扫描件无法取词。离开来源标签页时，侧栏自动收起。

浮窗提供复制、重新翻译和 Esc 关闭；原文与译文可分别滚动。设置中可开启浮窗拖动、翻译完成后点击外部关闭，也可修改网页快捷键。

## 数据

API Key 保存在浏览器本地。翻译时，选中的文字会发送给你配置的 API 服务。

## 开发

扩展源码位于 `extension/`。使用 Node.js 运行检查：

```sh
npm run check
npm test
```
