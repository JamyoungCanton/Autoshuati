export type RunState = "idle" | "running" | "error" | "done";
export type LogLevel = "info" | "warn" | "error";
export type NotOpenAction = "retry" | "ask" | "continue";

export type RuntimeConfig = {
  username: string;
  password: string;
  courseList: string;
  notopenAction: NotOpenAction;
  speed: number;
  jobs: number;
};

export type TikuConfig = {
  provider: string;
  officialUrl: string;
  apiUrl: string;
  model: string;
  token: string;
  coverRate: number;
  submit: boolean;
};

export type NotificationConfig = {
  provider: string;
  url: string;
};

export type ConsoleLog = {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
};

export type ConsoleConfig = {
  runtime: RuntimeConfig;
  tiku: TikuConfig;
  notification: NotificationConfig;
};

export type UserSession = {
  id: string | number;
  username: string;
  account_name?: string;
  role?: string;
  loginType: "guest" | "chaoxing" | "admin";
};

export type CourseInfo = {
  id: string;
  courseId: string;
  name: string;
  clazzId?: string;
  cpi?: string;
  teacher?: string;
  [key: string]: unknown;
};

export type AccountInfo = {
  id: number;
  account_name: string;
  username: string;
  is_active?: boolean;
  created_at?: string;
};

export type AdminStats = {
  accounts: number;
  configured_courses: number;
  task_state: RunState;
  logs: number;
  ai_provider: string;
  notification_provider: string;
};

const DEVICE_ID_KEY = "chaoxing.deviceId";

export function getDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const nextId = window.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_ID_KEY, nextId);
  return nextId;
}

async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Device-Id", getDeviceId());
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return fetch(`/api${cleanPath}`, { ...init, headers });
}

export async function fetchServerHealth(): Promise<{ success: boolean; service: string; state: RunState; device_id?: string }> {
  const response = await apiFetch("/health");
  if (!response.ok) {
    throw await parseApiError(response, "服务器服务未连接");
  }
  return response.json();
}

export const runtimeDefaults: RuntimeConfig = {
  username: "",
  password: "",
  courseList: "2151141,189191,198198",
  notopenAction: "retry",
  speed: 1,
  jobs: 4,
};

export const tikuDefaults: TikuConfig = {
  provider: "SiliconFlow",
  officialUrl: "https://cloud.siliconflow.cn/",
  apiUrl: "https://api.siliconflow.cn/v1/chat/completions",
  model: "Qwen/Qwen2.5-7B-Instruct",
  token: "",
  coverRate: 80,
  submit: false,
};

export const notificationDefaults: NotificationConfig = {
  provider: "ServerChan",
  url: "",
};

export const initialLogs: ConsoleLog[] = [
  { id: 1, time: "09:30:12", level: "info", message: "读取 config.ini 模板，等待用户保存配置" },
  { id: 2, time: "09:30:18", level: "info", message: "题库 provider 已识别为 TikuYanxi" },
  { id: 3, time: "09:31:02", level: "warn", message: "课程列表包含 3 个 ID，请在运行前确认班级映射" },
  { id: 4, time: "09:31:27", level: "error", message: "通知 webhook 为空，任务结束后不会发送外部通知" },
];

const modelCatalog: Array<{ match: string; models: string[] }> = [
  {
    match: "siliconflow",
    models: [
      "Qwen/Qwen2.5-7B-Instruct",
      "Qwen/Qwen2.5-14B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "THUDM/glm-4-9b-chat",
    ],
  },
  {
    match: "deepseek",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    match: "dashscope",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
  },
  {
    match: "openai",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  },
  {
    match: "freemodel",
    models: ["gpt-4o-mini", "gpt-4.1-mini", "deepseek-chat", "qwen-plus"],
  },
];

export async function fetchModelsByApiUrl(apiUrl: string): Promise<string[]> {
  const normalizedUrl = apiUrl.trim().toLowerCase();

  if (!normalizedUrl) {
    return [];
  }

  try {
    const response = await apiFetch(`/ai/models?api_url=${encodeURIComponent(apiUrl)}`);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.models)) {
        return data.models;
      }
    }
  } catch {
    await new Promise((resolve) => window.setTimeout(resolve, 420));
  }

  const matchedCatalog = modelCatalog.find((item) => normalizedUrl.includes(item.match));
  if (matchedCatalog) {
    return matchedCatalog.models;
  }

  if (normalizedUrl.includes("/v1/chat/completions") || normalizedUrl.startsWith("http://") || normalizedUrl.startsWith("https://")) {
    return ["qwen-plus", "deepseek-chat", "gpt-4.1-mini"];
  }

  return [];
}

export async function fetchConsoleConfig(): Promise<ConsoleConfig> {
  const response = await apiFetch("/config");
  if (!response.ok) {
    throw new Error("Failed to load backend config");
  }
  const data = await response.json();
  return data.config;
}

export async function saveConsoleConfig(config: ConsoleConfig): Promise<void> {
  const response = await apiFetch("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error("Failed to save backend config");
  }
}

async function parseApiError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = await response.json();
    return new Error(data.error || data.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function loginBackend(username: string, password: string, type: "chaoxing" | "admin"): Promise<UserSession> {
  const response = await apiFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, type }),
  });
  if (!response.ok) {
    throw await parseApiError(response, "登录失败");
  }
  const data = await response.json();
  return type === "admin" ? data.user : data.account;
}

export async function logoutBackend(): Promise<void> {
  await apiFetch("/auth/logout", { method: "POST" });
}

export async function fetchCurrentUser(): Promise<UserSession> {
  const response = await apiFetch("/auth/me");
  if (!response.ok) {
    throw await parseApiError(response, "无法读取登录状态");
  }
  const data = await response.json();
  return data.user;
}

export async function fetchCourses(): Promise<CourseInfo[]> {
  const response = await apiFetch("/courses");
  if (!response.ok) {
    throw await parseApiError(response, "无法读取课程列表");
  }
  const data = await response.json();
  return Array.isArray(data.courses) ? data.courses : [];
}

export async function fetchCoursePoints(courseId: string): Promise<unknown[]> {
  const response = await apiFetch(`/courses/${encodeURIComponent(courseId)}/points`);
  if (!response.ok) {
    throw await parseApiError(response, "无法读取课程章节");
  }
  const data = await response.json();
  return Array.isArray(data.points) ? data.points : [];
}

export async function fetchAccounts(): Promise<AccountInfo[]> {
  const response = await apiFetch("/accounts");
  if (!response.ok) {
    throw await parseApiError(response, "无法读取账号列表");
  }
  const data = await response.json();
  return Array.isArray(data.accounts) ? data.accounts : [];
}

export async function createAccount(account_name: string, username: string): Promise<AccountInfo> {
  const response = await apiFetch("/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_name, username }),
  });
  if (!response.ok) {
    throw await parseApiError(response, "添加账号失败");
  }
  const data = await response.json();
  return data.account;
}

export async function deleteAccount(accountId: number): Promise<void> {
  const response = await apiFetch(`/accounts/${accountId}`, { method: "DELETE" });
  if (!response.ok) {
    throw await parseApiError(response, "删除账号失败");
  }
}

export async function startBackendTask(config: ConsoleConfig): Promise<{ task_id: string }> {
  const response = await apiFetch("/tasks/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Failed to start task");
  }
  return { task_id: data.task_id };
}

export async function startSelectedCourses(courseIds: string[], config: RuntimeConfig): Promise<{ task_id: string }> {
  const response = await apiFetch("/tasks/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      course_ids: courseIds,
      config: {
        speed: config.speed,
        jobs: config.jobs,
        notopen_action: config.notopenAction,
      },
    }),
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || "Failed to start selected courses");
  }
  return { task_id: data.task_id };
}

export async function pauseBackendTask(): Promise<void> {
  const response = await apiFetch("/tasks/pause", { method: "POST" });
  if (!response.ok) {
    throw await parseApiError(response, "暂停任务失败");
  }
}

export async function resumeBackendTask(): Promise<void> {
  const response = await apiFetch("/tasks/resume", { method: "POST" });
  if (!response.ok) {
    throw await parseApiError(response, "恢复任务失败");
  }
}

export async function stopBackendTask(): Promise<void> {
  const response = await apiFetch("/tasks/stop", { method: "POST" });
  if (!response.ok) {
    throw new Error("Failed to stop task");
  }
}

export async function fetchTaskStatus(): Promise<RunState> {
  const response = await apiFetch("/tasks/status");
  if (!response.ok) {
    throw new Error("Failed to load task status");
  }
  const data = await response.json();
  const state = data.status?.state;
  if (state === "running") {
    return "running";
  }
  if (state === "error") {
    return "error";
  }
  if (state === "done" || state === "completed") {
    return "done";
  }
  return "idle";
}

export async function fetchBackendLogs(): Promise<ConsoleLog[]> {
  const response = await apiFetch("/logs");
  if (!response.ok) {
    throw new Error("Failed to load logs");
  }
  const data = await response.json();
  return Array.isArray(data.logs) ? data.logs : [];
}

export async function fetchAdminStats(): Promise<AdminStats> {
  const response = await apiFetch("/admin/stats");
  if (!response.ok) {
    throw await parseApiError(response, "无法读取管理员统计");
  }
  const data = await response.json();
  return data.stats;
}

export function buildCommand(config: RuntimeConfig) {
  const courses = config.courseList.trim() || "课程ID1,课程ID2";
  return `python main.py -u "${config.username || "手机号"}" -p "密码" -l ${courses} -a ${config.notopenAction}`;
}

export function nowTime() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}
