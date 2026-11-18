const taskManager = {
  title: "Task Manager",
  subtitle:
    "See processes, CPU, memory, disk, network and GPU usage, and end processes or change their priority.",
  tabs: {
    processes: "Processes",
    performance: "Performance",
  },
  actions: {
    refresh: "Refresh",
    settings: "Settings",
    close: "Close",
  },
  service: {
    label: "Privileged service",
    state: {
      notInstalled: "Not installed",
      stopped: "Stopped",
      running: "Running",
      unavailable: "Unavailable",
      unknown: "Unknown",
    },
  },
  error: {
    "not-found": "The process has already exited or its PID was reused.",
    "invalid-input": "The request was invalid.",
    "access-denied": "Administrator rights or the privileged service are required.",
    "service-unavailable": "The privileged service is not installed or not running.",
    "not-implemented": "This feature is not available yet.",
    internal: "Something went wrong while reading system data.",
  },
  empty: {
    processes: "Process data will appear here once sampling starts.",
    performance: "Performance charts will appear here once sampling starts.",
    service:
      "Install the privileged service from this page to act on system processes and see per-process network and disk traffic.",
  },
  settings: {
    title: "Task manager settings",
    placeholder: "The sampling interval and the service install/uninstall actions live here.",
  },
};

export default taskManager;
