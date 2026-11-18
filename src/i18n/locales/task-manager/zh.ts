const taskManager = {
  title: "任务管理器",
  subtitle: "查看进程、CPU、内存、磁盘、网络与 GPU 的使用情况，结束进程或调整优先级。",
  tabs: {
    processes: "进程",
    performance: "性能",
  },
  actions: {
    refresh: "刷新",
    settings: "设置",
    close: "关闭",
  },
  service: {
    label: "特权服务",
    state: {
      notInstalled: "未安装",
      stopped: "已停止",
      running: "运行中",
      unavailable: "不可用",
      unknown: "未知",
    },
  },
  error: {
    "not-found": "进程已退出，或 PID 已被复用。",
    "invalid-input": "请求参数无效。",
    "access-denied": "需要管理员权限或特权服务。",
    "service-unavailable": "特权服务未安装或未运行。",
    "not-implemented": "该功能尚未提供。",
    internal: "读取系统数据时出错。",
  },
  empty: {
    processes: "采样开始后，进程数据会显示在这里。",
    performance: "采样开始后，性能图表会显示在这里。",
    service: "在本页安装特权服务后，即可操作系统进程并查看每个进程的网络与磁盘流量。",
  },
  settings: {
    title: "任务管理器设置",
    placeholder: "采样间隔与特权服务的安装/卸载操作会放在这里。",
  },
};

export default taskManager;
