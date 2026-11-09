// Space preview strings. Every later lane adds keys here, in both files at
// once: the two objects must always carry the same key set.
export default {
  title: "文件预览",
  subtitle: "无需离开应用即可预览文件。",
  window: {
    close: "关闭",
    previous: "上一个",
    next: "下一个",
    multiSelect: "已选择 {{count}} 项",
  },
  toolbar: {
    openInWindow: "在独立窗口中打开",
    zoomIn: "放大",
    zoomOut: "缩小",
    fit: "适应窗口",
  },
  settings: {
    spaceEnabled: "空格预览",
    spaceEnabledHint: "在资源管理器、桌面或 Everything 中选中文件后按空格键。",
    readingWidth: "阅读宽度",
    fontSize: "字号",
    defaultEncoding: "默认编码",
  },
  encoding: {
    auto: "自动检测",
    utf8: "UTF-8",
    utf16le: "UTF-16 LE",
    utf16be: "UTF-16 BE",
    gb18030: "GB18030",
    big5: "Big5",
    windows1252: "Windows-1252",
    shiftJis: "Shift-JIS",
  },
  error: {
    notAuthorized: "该文件不是从预览入口打开的，无法读取。",
    notFound: "文件已不存在。",
    tooLarge: "文件过大，无法预览。",
    invalidInput: "请求参数无效。",
    unsupported: "暂不支持该格式。",
    internal: "读取文件时发生错误。",
  },
  unsupported: {
    title: "该格式暂不支持预览",
    body: "仍可以使用系统默认应用打开该文件。",
  },
  editor: {
    save: "保存",
    saving: "保存中…",
    discardConfirm: "放弃未保存的修改？",
    saved: "已保存",
  },
};
