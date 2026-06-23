import {
  Bell,
  BookOpen,
  ChartBar,
  CheckCircle,
  ClipboardText,
  FileText,
  GearSix,
  GraduationCap,
  House,
  Info,
  List,
  Pause,
  Play,
  SignIn,
  ShieldCheck,
  TerminalWindow,
  Trash,
  UserCircle,
  Users,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import {
  buildCommand,
  createAccount,
  deleteAccount,
  fetchAccounts,
  fetchAdminStats,
  fetchBackendLogs,
  fetchConsoleConfig,
  fetchCourses,
  fetchCoursePoints,
  fetchCurrentUser,
  fetchModelsByApiUrl,
  fetchServerHealth,
  fetchTaskStatus,
  initialLogs,
  loginBackend,
  notificationDefaults,
  nowTime,
  pauseBackendTask,
  resumeBackendTask,
  runtimeDefaults,
  saveConsoleConfig,
  startBackendTask,
  startSelectedCourses,
  stopBackendTask,
  tikuDefaults,
  type AccountInfo,
  type AdminStats,
  type ConsoleLog,
  type CourseInfo,
  type LogLevel,
  type NotificationConfig,
  type NotOpenAction,
  type RunState,
  type RuntimeConfig,
  type TikuConfig,
  type UserSession,
} from "./adapters/mockChaoxing";

type ViewId = "login" | "overview" | "courses" | "tasks" | "accounts" | "admin" | "runtime" | "tiku" | "notify" | "logs" | "help";
type SaveState = "idle" | "loading" | "success" | "error";

type NavItem = {
  id: ViewId;
  label: string;
  icon: ComponentType<{ size?: number; weight?: "regular" | "fill" | "duotone" }>;
};

const navItems: NavItem[] = [
  { id: "login", label: "登录", icon: SignIn },
  { id: "overview", label: "总览", icon: House },
  { id: "courses", label: "课程列表", icon: GraduationCap },
  { id: "tasks", label: "任务中心", icon: Play },
  { id: "accounts", label: "账号管理", icon: Users },
  { id: "admin", label: "管理员", icon: ChartBar },
  { id: "runtime", label: "任务配置", icon: GearSix },
  { id: "tiku", label: "题库设置", icon: BookOpen },
  { id: "notify", label: "通知设置", icon: Bell },
  { id: "logs", label: "运行日志", icon: TerminalWindow },
  { id: "help", label: "帮助", icon: FileText },
];

const pageTitles: Record<ViewId, string> = {
  login: "登录",
  overview: "总览",
  courses: "课程列表",
  tasks: "任务中心",
  accounts: "账号管理",
  admin: "管理员",
  runtime: "任务配置",
  tiku: "题库设置",
  notify: "通知设置",
  logs: "运行日志",
  help: "帮助",
};

const pageDescriptions: Record<ViewId, string> = {
  login: "连接本地控制台会话，超星账号会写入 config.ini 供后端读取课程与启动任务。",
  overview: "查看本地配置、任务状态和最近一次运行结果。",
  courses: "读取当前账号的课程列表，选择课程后可同步到任务中心。",
  tasks: "按课程选择启动、停止、暂停或恢复本地 main.py 任务，并观察执行状态。",
  accounts: "维护账号清单，用于区分不同使用配置。",
  admin: "查看控制台统计、配置状态和任务运行概况。",
  runtime: "保存账号、课程 ID 和已关闭任务点处理策略。",
  tiku: "配置 AI 答题服务商、官网链接、API 请求地址、模型、API Key 和提交策略。",
  notify: "设置外部通知服务，用于任务结束或错误提醒。",
  logs: "观察 mock 运行日志，后续可替换为真实进程输出。",
  help: "常用运行命令和免责声明入口。",
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function App() {
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runtime, setRuntime] = useState<RuntimeConfig>(runtimeDefaults);
  const [tiku, setTiku] = useState<TikuConfig>(tikuDefaults);
  const [notification, setNotification] = useState<NotificationConfig>(notificationDefaults);
  const [logs, setLogs] = useState<ConsoleLog[]>(initialLogs);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [logFilter, setLogFilter] = useState<LogLevel | "all">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [user, setUser] = useState<UserSession | null>(null);
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [selectedCourseIds, setSelectedCourseIds] = useState<string[]>([]);
  const [connectionState, setConnectionState] = useState<"checking" | "connected" | "disconnected">("checking");
  const [connectionMessage, setConnectionMessage] = useState("正在检测服务器会话");

  const courseCount = useMemo(
    () => runtime.courseList.split(",").map((item) => item.trim()).filter(Boolean).length,
    [runtime.courseList],
  );

  const visibleLogs = logFilter === "all" ? logs : logs.filter((log) => log.level === logFilter);
  const hasConfigError = !runtime.username || !runtime.password;
  const command = buildCommand(runtime);
  const consoleConfig = useMemo(() => ({ runtime, tiku, notification }), [runtime, tiku, notification]);

  async function refreshConnection() {
    setConnectionState("checking");
    try {
      const health = await fetchServerHealth();
      setConnectionState("connected");
      setConnectionMessage(`${health.service} 已连接，任务状态 ${health.state}`);
      return true;
    } catch (error) {
      setConnectionState("disconnected");
      setConnectionMessage(error instanceof Error ? error.message : "服务器服务未连接");
      return false;
    }
  }

  useEffect(() => {
    let cancelled = false;

    refreshConnection();
    fetchConsoleConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }
        setRuntime(config.runtime);
        setTiku(config.tiku);
        setNotification(config.notification);
        addLog("info", "已从 Flask 后端读取 config.ini 配置");
      })
      .catch(() => {
        if (!cancelled) {
          addLog("warn", "后端未启动，当前使用前端默认配置");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchCurrentUser()
      .then((currentUser) => setUser(currentUser))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (runState !== "running" && activeView !== "logs") {
      return;
    }

    const timer = window.setInterval(() => {
      fetchTaskStatus()
        .then(setRunState)
        .catch(() => undefined);
      fetchBackendLogs()
        .then((backendLogs) => {
          if (backendLogs.length) {
            setLogs(backendLogs);
          }
        })
        .catch(() => undefined);
    }, 1600);

    return () => window.clearInterval(timer);
  }, [runState, activeView]);

  function addLog(level: LogLevel, message: string) {
    setLogs((current) => [
      ...current,
      {
        id: Date.now(),
        time: nowTime(),
        level,
        message,
      },
    ]);
  }

  async function toggleRun() {
    if (runState === "running") {
      try {
        await stopBackendTask();
        setRunState("idle");
        addLog("warn", "已向后端发送停止任务请求");
      } catch (error) {
        addLog("error", error instanceof Error ? error.message : "停止任务失败");
      }
      return;
    }

    try {
      setRunState("running");
      addLog("info", `通过后端启动任务: ${command}`);
      const result = await startBackendTask(consoleConfig);
      addLog("info", `后端任务已启动: ${result.task_id}`);
    } catch (error) {
      setRunState("error");
      addLog("error", error instanceof Error ? error.message : "启动任务失败");
    }
  }

  async function saveMock(message: string) {
    setSaveState("loading");
    if (hasConfigError && activeView === "runtime") {
      setSaveState("error");
      addLog("error", "保存失败，账号和密码是运行配置的必填项");
      return;
    }

    try {
      await saveConsoleConfig(consoleConfig);
      setSaveState("success");
      addLog("info", message);
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (error) {
      setSaveState("error");
      addLog("error", error instanceof Error ? error.message : "保存配置失败");
    }
  }

  return (
    <div className="min-h-[100dvh] bg-[#f7faf8] text-[#10201a]">
      <div className="grid min-h-[100dvh] grid-cols-1 lg:grid-cols-[248px_1fr]">
        <aside className="sticky top-0 hidden h-[100dvh] overflow-y-auto border-r border-emerald-950/10 bg-white lg:block">
          <Sidebar activeView={activeView} onSelect={setActiveView} />
        </aside>

        <AnimatePresence>
          {mobileNavOpen ? (
            <motion.div
              className="fixed inset-0 z-40 bg-emerald-950/20 p-3 lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.aside
                className="h-full w-[min(320px,92vw)] rounded-[8px] bg-white shadow-2xl shadow-emerald-950/15"
                initial={{ x: -24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -24, opacity: 0 }}
              >
                <div className="flex justify-end p-3">
                  <IconButton label="关闭导航" onClick={() => setMobileNavOpen(false)}>
                    <X size={18} />
                  </IconButton>
                </div>
                <Sidebar
                  activeView={activeView}
                  onSelect={(view) => {
                    setActiveView(view);
                    setMobileNavOpen(false);
                  }}
                />
              </motion.aside>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <main className="min-w-0">
          <header className="sticky top-0 z-20 border-b border-emerald-950/10 bg-[#f7faf8]/95 px-4 py-3 backdrop-blur md:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <IconButton label="打开导航" className="lg:hidden" onClick={() => setMobileNavOpen(true)}>
                  <List size={20} />
                </IconButton>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-emerald-700">Chaoxing 控制台</p>
                  <h1 className="truncate text-xl font-semibold tracking-[0] text-[#10201a] md:text-2xl">
                    {pageTitles[activeView]}
                  </h1>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusPill state={runState} />
                <button
                  className={cx(
                    "inline-flex h-10 items-center gap-2 rounded-[8px] px-4 text-sm font-semibold transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60",
                    runState === "running"
                      ? "bg-white text-emerald-900 ring-1 ring-emerald-800/20 hover:bg-emerald-50"
                      : "bg-emerald-700 text-white hover:bg-emerald-800",
                  )}
                  onClick={toggleRun}
                  disabled={saveState === "loading"}
                >
                  {runState === "running" ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
                  <span className="hidden sm:inline">{runState === "running" ? "停止" : "开始"}</span>
                </button>
              </div>
            </div>
          </header>

          <section className="mx-auto min-w-0 max-w-[1400px] px-4 py-5 md:px-6">
            <p className="mb-5 max-w-[68ch] text-sm leading-6 text-emerald-950/65">
              {pageDescriptions[activeView]}
            </p>
            <ServerSessionPanel
              state={connectionState}
              message={connectionMessage}
              onCheck={refreshConnection}
            />

            <AnimatePresence mode="wait">
              <motion.div
                key={activeView}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
              >
                {activeView === "login" && (
                  <LoginView
                    user={user}
                    onLogin={(nextUser, credentials) => {
                      setUser(nextUser);
                      if (credentials.loginType === "chaoxing") {
                        setRuntime((current) => ({
                          ...current,
                          username: credentials.username,
                          password: credentials.password,
                        }));
                      }
                      addLog("info", `${nextUser.loginType === "admin" ? "管理员" : "超星账号"}登录已写入本地会话`);
                      setActiveView(nextUser.loginType === "admin" ? "admin" : "overview");
                    }}
                  />
                )}
                {activeView === "overview" && (
                  <Overview
                    courseCount={courseCount}
                    runState={runState}
                    runtime={runtime}
                    tiku={tiku}
                    notification={notification}
                    logs={logs}
                    command={command}
                  />
                )}
                {activeView === "courses" && (
                  <CoursesView
                    courses={courses}
                    selectedCourseIds={selectedCourseIds}
                    onCourses={setCourses}
                    onSelectedCourseIds={setSelectedCourseIds}
                    onLog={addLog}
                  />
                )}
                {activeView === "tasks" && (
                  <TaskCenterView
                    runtime={runtime}
                    runState={runState}
                    selectedCourseIds={selectedCourseIds}
                    logs={logs}
                    onRuntime={setRuntime}
                    onRunState={setRunState}
                    onLog={addLog}
                    onStart={async (courseIds) => {
                      const result = await startSelectedCourses(courseIds, runtime);
                      addLog("info", `已按选中课程启动后端任务 ${result.task_id}`);
                    }}
                  />
                )}
                {activeView === "accounts" && <AccountsView onLog={addLog} />}
                {activeView === "admin" && <AdminView />}
                {activeView === "runtime" && (
                  <RuntimeSettings
                    runtime={runtime}
                    onChange={setRuntime}
                    saveState={saveState}
                    onSave={() => saveMock("运行配置已保存到后端 config.ini")}
                  />
                )}
                {activeView === "tiku" && (
                  <TikuSettings
                    tiku={tiku}
                    onChange={setTiku}
                    saveState={saveState}
                    onSave={() => saveMock("AI 答题配置已保存到后端 config.ini")}
                  />
                )}
                {activeView === "notify" && (
                  <NotificationSettings
                    notification={notification}
                    onChange={setNotification}
                    saveState={saveState}
                    onSave={() => saveMock("通知配置已保存到后端 config.ini")}
                    onTest={() => addLog(notification.url ? "info" : "error", notification.url ? "测试通知已加入发送队列" : "测试失败，webhook/url 为空")}
                  />
                )}
                {activeView === "logs" && (
                  <LogsView
                    logs={visibleLogs}
                    allLogs={logs}
                    filter={logFilter}
                    autoScroll={autoScroll}
                    onFilter={setLogFilter}
                    onAutoScroll={setAutoScroll}
                    onClear={() => setLogs([])}
                    onSeedError={() => addLog("error", "模拟错误: 登录状态失效或验证码需要人工处理")}
                  />
                )}
                {activeView === "help" && <HelpView command={command} />}
              </motion.div>
            </AnimatePresence>
          </section>
        </main>
      </div>
      <CopyrightWatermark />
    </div>
  );
}

function CopyrightWatermark() {
  return (
    <div className="pointer-events-none fixed bottom-2 right-2 z-30 rounded-[8px] border border-emerald-950/10 bg-white/90 px-2.5 py-1 text-xs font-medium text-emerald-950/55 shadow-sm shadow-emerald-950/5 backdrop-blur sm:bottom-4 sm:right-4">
      © Jamyoung
    </div>
  );
}

function Sidebar({ activeView, onSelect }: { activeView: ViewId; onSelect: (view: ViewId) => void }) {
  return (
    <div className="flex min-h-full flex-col p-4">
      <div className="mb-6 rounded-[8px] border border-emerald-950/10 bg-emerald-50 p-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-[8px] bg-emerald-700 text-white">
            <ShieldCheck size={22} weight="fill" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#10201a]">本地控制台</p>
            <p className="text-xs text-emerald-950/60">控制面板</p>
          </div>
        </div>
      </div>
      <nav className="space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeView;
          return (
            <button
              key={item.id}
              className={cx(
                "flex h-10 w-full items-center gap-3 rounded-[8px] px-3 text-left text-sm font-medium transition active:translate-y-px",
                active ? "bg-emerald-700 text-white" : "text-emerald-950/70 hover:bg-emerald-50 hover:text-emerald-950",
              )}
              onClick={() => onSelect(item.id)}
            >
              <Icon size={18} weight={active ? "fill" : "regular"} />
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function ServerSessionPanel({
  state,
  message,
  onCheck,
}: {
  state: "checking" | "connected" | "disconnected";
  message: string;
  onCheck: () => void;
}) {
  const tone = state === "connected" ? "success" : "error";
  return (
    <div className="mb-5 rounded-[8px] border border-emerald-950/10 bg-white p-4 shadow-sm shadow-emerald-950/[0.03]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cx(
                "inline-flex h-7 items-center rounded-[8px] px-2.5 text-xs font-semibold",
                state === "connected" && "bg-emerald-100 text-emerald-800",
                state === "checking" && "bg-amber-100 text-amber-800",
                state === "disconnected" && "bg-red-100 text-red-800",
              )}
            >
              {state === "connected" ? "服务器已连接" : state === "checking" ? "正在检测" : "服务器未连接"}
            </span>
            <p className="text-sm text-emerald-950/65">{message}</p>
          </div>
          {state === "disconnected" ? (
            <InlineAlert tone={tone} text="请检查服务器后端是否已启动，前端会通过浏览器本地 device_id 隔离不同用户的数据。" />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button className="secondary-button" type="button" onClick={onCheck}>
            重新检测
          </button>
        </div>
      </div>
    </div>
  );
}

function Overview({
  courseCount,
  runState,
  runtime,
  tiku,
  notification,
  logs,
  command,
}: {
  courseCount: number;
  runState: RunState;
  runtime: RuntimeConfig;
  tiku: TikuConfig;
  notification: NotificationConfig;
  logs: ConsoleLog[];
  command: string;
}) {
  const errorCount = logs.filter((log) => log.level === "error").length;
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="运行状态" value={runLabel(runState)} tone={runState === "running" ? "active" : "neutral"} />
          <MetricCard label="待处理课程" value={`${courseCount}`} tone="neutral" />
          <MetricCard label="AI 答题" value={tiku.provider && tiku.apiUrl && tiku.model ? "已配置" : "未完整"} tone={tiku.provider && tiku.apiUrl && tiku.model ? "active" : "warn"} />
          <MetricCard label="错误摘要" value={`${errorCount} 条`} tone={errorCount ? "error" : "neutral"} />
        </div>

        <Panel title="配置完整度" icon={ClipboardText}>
          <div className="grid gap-3 md:grid-cols-3">
            <ChecklistItem checked={Boolean(runtime.username && runtime.password)} title="账号信息" text="手机号或账号与密码用于本地运行参数。" />
            <ChecklistItem checked={courseCount > 0} title="课程列表" text="支持以英文逗号分隔多个课程 ID。" />
            <ChecklistItem checked={Boolean(notification.url)} title="外部通知" text="任务结束和错误提醒会使用该 webhook。" />
          </div>
        </Panel>

        <Panel title="当前命令预览" icon={TerminalWindow}>
          <CodeBlock value={command} />
        </Panel>
      </div>

      <Panel title="最近运行结果" icon={Info}>
        <div className="space-y-3">
          {logs.slice(-5).map((log) => (
            <LogRow key={log.id} log={log} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

function LoginView({
  user,
  onLogin,
}: {
  user: UserSession | null;
  onLogin: (
    user: UserSession,
    credentials: { username: string; password: string; loginType: "chaoxing" | "admin" },
  ) => void;
}) {
  const [loginType, setLoginType] = useState<"chaoxing" | "admin">("chaoxing");
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  async function submit() {
    setState("loading");
    setError("");
    try {
      const nextUser = await loginBackend(username, password, loginType);
      setState("success");
      onLogin(nextUser, { username, password, loginType });
    } catch (caught) {
      setState("error");
      setError(caught instanceof Error ? caught.message : "登录失败");
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,560px)_1fr]">
      <Panel title="本地会话登录" icon={UserCircle}>
        <div className="space-y-4">
          <Segmented
            value={loginType}
            options={[
              { label: "超星账号", value: "chaoxing" },
              { label: "管理员", value: "admin" },
              { label: "本地", value: "local" },
            ]}
            onChange={(value) => setLoginType(value === "admin" ? "admin" : "chaoxing")}
          />
          <Field label={loginType === "admin" ? "管理员用户名" : "手机号 / 账号"} error={!username ? "请输入账号" : undefined}>
            <input className="field" value={username} onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <Field label="密码" error={!password ? "请输入密码" : undefined}>
            <input className="field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          {error ? <InlineAlert tone="error" text={error} /> : null}
          {state === "success" ? <InlineAlert tone="success" text="登录信息已保存到本地后端，课程读取会使用当前配置。" /> : null}
          <button className="primary-button" disabled={state === "loading" || !username || !password} onClick={submit}>
            {state === "loading" ? "登录中" : "登录"}
          </button>
        </div>
      </Panel>
      <Panel title="连接说明" icon={Info}>
        <div className="space-y-3 text-sm leading-6 text-emerald-950/70">
          <p>超星账号登录会写入当前浏览器会话对应的服务器配置，用于读取课程与启动任务。</p>
          <p>不同浏览器会话会使用独立配置，避免互相覆盖。</p>
          <p>管理员登录用于进入本地统计视图，不会连接外部身份服务。</p>
        </div>
      </Panel>
    </div>
  );
}

function CoursesView({
  courses,
  selectedCourseIds,
  onCourses,
  onSelectedCourseIds,
  onLog,
}: {
  courses: CourseInfo[];
  selectedCourseIds: string[];
  onCourses: (courses: CourseInfo[]) => void;
  onSelectedCourseIds: (ids: string[]) => void;
  onLog: (level: LogLevel, message: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedCourseId, setExpandedCourseId] = useState("");
  const [points, setPoints] = useState<unknown[]>([]);

  async function loadCourses() {
    setLoading(true);
    setError("");
    try {
      const nextCourses = await fetchCourses();
      onCourses(nextCourses);
      onLog("info", `课程列表已刷新，共 ${nextCourses.length} 门`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "课程读取失败";
      setError(message);
      onLog("error", message);
    } finally {
      setLoading(false);
    }
  }

  async function toggleDetails(courseId: string) {
    if (expandedCourseId === courseId) {
      setExpandedCourseId("");
      setPoints([]);
      return;
    }
    setExpandedCourseId(courseId);
    setPoints([]);
    try {
      setPoints(await fetchCoursePoints(courseId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "章节读取失败");
    }
  }

  function toggleSelect(courseId: string) {
    onSelectedCourseIds(
      selectedCourseIds.includes(courseId) ? selectedCourseIds.filter((id) => id !== courseId) : [...selectedCourseIds, courseId],
    );
  }

  return (
    <div className="space-y-4">
      <Panel title="课程列表" icon={GraduationCap}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button className="primary-button" disabled={loading} onClick={loadCourses}>
            {loading ? "读取中" : "刷新课程"}
          </button>
          <span className="text-sm text-emerald-950/60">已选择 {selectedCourseIds.length} 门课程</span>
        </div>
        {error ? <InlineAlert tone="error" text={error} /> : null}
        {loading ? <SkeletonRows /> : null}
        {!loading && !courses.length ? (
          <div className="rounded-[8px] border border-dashed border-emerald-950/20 p-8 text-center text-sm text-emerald-950/60">
            暂无课程数据。请先在登录或任务配置中保存账号密码，然后刷新课程。
          </div>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {courses.map((course) => {
            const selected = selectedCourseIds.includes(course.courseId);
            return (
              <div key={course.courseId} className="rounded-[8px] border border-emerald-950/10 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[#10201a]">{course.name}</p>
                    <p className="mt-1 text-xs text-emerald-950/55">
                      courseId: {course.courseId} {course.clazzId ? ` / clazzId: ${course.clazzId}` : ""}
                    </p>
                  </div>
                  <button className={selected ? "primary-button" : "secondary-button"} onClick={() => toggleSelect(course.courseId)}>
                    {selected ? "已选择" : "选择"}
                  </button>
                </div>
                <button className="mt-3 text-sm font-medium text-emerald-700 hover:text-emerald-900" onClick={() => toggleDetails(course.courseId)}>
                  {expandedCourseId === course.courseId ? "收起章节" : "查看章节"}
                </button>
                {expandedCourseId === course.courseId ? (
                  <pre className="mt-3 max-h-56 overflow-auto rounded-[8px] bg-emerald-50 p-3 text-xs leading-5 text-emerald-950/75">
                    {points.length ? JSON.stringify(points.slice(0, 8), null, 2) : "暂无章节数据或正在读取"}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function TaskCenterView({
  runtime,
  runState,
  selectedCourseIds,
  logs,
  onRuntime,
  onRunState,
  onLog,
  onStart,
}: {
  runtime: RuntimeConfig;
  runState: RunState;
  selectedCourseIds: string[];
  logs: ConsoleLog[];
  onRuntime: (config: RuntimeConfig) => void;
  onRunState: (state: RunState) => void;
  onLog: (level: LogLevel, message: string) => void;
  onStart: (courseIds: string[]) => Promise<void>;
}) {
  const fallbackCourseIds = runtime.courseList.split(",").map((item) => item.trim()).filter(Boolean);
  const activeCourseIds = selectedCourseIds.length ? selectedCourseIds : fallbackCourseIds;

  async function start() {
    if (!activeCourseIds.length) {
      onLog("error", "请先选择课程或填写课程 ID");
      return;
    }
    try {
      onRunState("running");
      await onStart(activeCourseIds);
    } catch (caught) {
      onRunState("error");
      onLog("error", caught instanceof Error ? caught.message : "启动任务失败");
    }
  }

  async function pause() {
    await pauseBackendTask();
    onLog("warn", "暂停请求已发送到后端");
  }

  async function resume() {
    await resumeBackendTask();
    onLog("info", "恢复请求已发送到后端");
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Panel title="任务控制" icon={Play}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard label="任务状态" value={runLabel(runState)} tone={runState === "error" ? "error" : runState === "running" ? "active" : "neutral"} />
            <MetricCard label="目标课程" value={`${activeCourseIds.length}`} tone={activeCourseIds.length ? "active" : "warn"} />
            <MetricCard label="错误日志" value={`${logs.filter((log) => log.level === "error").length}`} tone={logs.some((log) => log.level === "error") ? "error" : "neutral"} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_160px_160px]">
            <Field label="已关闭任务点处理">
              <Segmented
                value={runtime.notopenAction}
                options={[
                  { label: "retry", value: "retry" },
                  { label: "ask", value: "ask" },
                  { label: "continue", value: "continue" },
                ]}
                onChange={(value) => onRuntime({ ...runtime, notopenAction: value as NotOpenAction })}
              />
            </Field>
            <Field label="播放倍速">
              <input className="field" type="number" min={1} max={2} step={0.1} value={runtime.speed} onChange={(event) => onRuntime({ ...runtime, speed: Number(event.target.value) })} />
            </Field>
            <Field label="并发章节">
              <input className="field" type="number" min={1} max={8} value={runtime.jobs} onChange={(event) => onRuntime({ ...runtime, jobs: Number(event.target.value) })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="primary-button" disabled={runState === "running" || !activeCourseIds.length} onClick={start}>
              <Play size={17} weight="fill" />
              启动选中课程
            </button>
            <button className="secondary-button" disabled={runState !== "running"} onClick={pause}>
              <Pause size={17} />
              暂停
            </button>
            <button className="secondary-button" onClick={resume}>
              <Play size={17} />
              恢复
            </button>
          </div>
          <InlineAlert tone={activeCourseIds.length ? "success" : "error"} text={activeCourseIds.length ? `将运行课程：${activeCourseIds.join(", ")}` : "课程为空，请先在课程列表选择课程或在任务配置中填写课程 ID。"} />
        </div>
      </Panel>
      <Panel title="任务日志" icon={TerminalWindow}>
        <div className="max-h-[460px] overflow-auto rounded-[8px] bg-[#0d1612] p-3 font-mono text-sm leading-6 text-emerald-50">
          {logs.slice(-12).length ? logs.slice(-12).map((log) => <LogRow key={log.id} log={log} terminal />) : "暂无任务日志"}
        </div>
      </Panel>
    </div>
  );
}

function AccountsView({ onLog }: { onLog: (level: LogLevel, message: string) => void }) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [accountName, setAccountName] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setAccounts(await fetchAccounts());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号列表读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function add() {
    try {
      await createAccount(accountName, username);
      setAccountName("");
      setUsername("");
      onLog("info", "本地账号已添加");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加账号失败");
    }
  }

  async function remove(accountId: number) {
    await deleteAccount(accountId);
    onLog("warn", `本地账号 ${accountId} 已删除`);
    await load();
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
      <Panel title="添加账号" icon={Users}>
        <div className="space-y-4">
          <Field label="显示名称" error={!accountName ? "请输入显示名称" : undefined}>
            <input className="field" value={accountName} onChange={(event) => setAccountName(event.target.value)} />
          </Field>
          <Field label="超星用户名" error={!username ? "请输入用户名" : undefined}>
            <input className="field" value={username} onChange={(event) => setUsername(event.target.value)} />
          </Field>
          {error ? <InlineAlert tone="error" text={error} /> : null}
          <button className="primary-button" disabled={!accountName || !username} onClick={add}>
            添加账号
          </button>
        </div>
      </Panel>
      <Panel title="账号列表" icon={UserCircle}>
        {loading ? <SkeletonRows /> : null}
        {!loading && !accounts.length ? <div className="rounded-[8px] border border-dashed border-emerald-950/20 p-8 text-center text-sm text-emerald-950/60">还没有本地账号。</div> : null}
        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-emerald-950/10 p-3">
              <div>
                <p className="font-semibold text-[#10201a]">{account.account_name}</p>
                <p className="text-sm text-emerald-950/55">{account.username}</p>
              </div>
              <button className="secondary-button text-red-700" onClick={() => remove(account.id)}>
                <Trash size={17} />
                删除
              </button>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function AdminView() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAdminStats()
      .then(setStats)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "统计读取失败"));
  }, []);

  return (
    <div className="space-y-4">
      {error ? <InlineAlert tone="error" text={error} /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="本地账号" value={`${stats?.accounts ?? 0}`} tone="neutral" />
        <MetricCard label="配置课程" value={`${stats?.configured_courses ?? 0}`} tone="neutral" />
        <MetricCard label="任务状态" value={stats ? runLabel(stats.task_state) : "读取中"} tone={stats?.task_state === "running" ? "active" : "neutral"} />
        <MetricCard label="后端日志" value={`${stats?.logs ?? 0}`} tone="neutral" />
      </div>
    </div>
  );
}

function RuntimeSettings({
  runtime,
  onChange,
  saveState,
  onSave,
}: {
  runtime: RuntimeConfig;
  onChange: (config: RuntimeConfig) => void;
  saveState: SaveState;
  onSave: () => void;
}) {
  const missingRequired = !runtime.username || !runtime.password;
  return (
    <FormShell saveState={saveState} onSave={onSave} buttonLabel="保存任务配置">
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="手机号/账号" error={!runtime.username ? "请输入账号" : undefined}>
          <input
            className="field"
            value={runtime.username}
            placeholder="例如 13800000000"
            onChange={(event) => onChange({ ...runtime, username: event.target.value })}
          />
        </Field>
        <Field label="密码" error={!runtime.password ? "请输入密码" : undefined}>
          <input
            className="field"
            type="password"
            value={runtime.password}
            placeholder="仅保存在前端状态中"
            onChange={(event) => onChange({ ...runtime, password: event.target.value })}
          />
        </Field>
      </div>

      <Field label="课程 ID 列表">
        <textarea
          className="field min-h-28 resize-y"
          value={runtime.courseList}
          onChange={(event) => onChange({ ...runtime, courseList: event.target.value })}
        />
      </Field>

      <div className="grid gap-4 lg:grid-cols-[1fr_180px_180px]">
        <Field label="已关闭任务点处理">
          <Segmented
            value={runtime.notopenAction}
            options={[
              { label: "重试", value: "retry" },
              { label: "询问", value: "ask" },
              { label: "继续", value: "continue" },
            ]}
            onChange={(value) => onChange({ ...runtime, notopenAction: value as NotOpenAction })}
          />
        </Field>
        <Field label="播放倍速">
          <input
            className="field"
            type="number"
            min={1}
            max={2}
            step={0.1}
            value={runtime.speed}
            onChange={(event) => onChange({ ...runtime, speed: Number(event.target.value) })}
          />
        </Field>
        <Field label="并发章节">
          <input
            className="field"
            type="number"
            min={1}
            max={8}
            value={runtime.jobs}
            onChange={(event) => onChange({ ...runtime, jobs: Number(event.target.value) })}
          />
        </Field>
      </div>

      {missingRequired ? (
        <InlineAlert tone="error" text="账号和密码为空时无法生成完整运行配置。" />
      ) : (
        <InlineAlert tone="success" text="运行配置格式正常，保存后可生成命令参数。" />
      )}
    </FormShell>
  );
}

function TikuSettings({
  tiku,
  onChange,
  saveState,
  onSave,
}: {
  tiku: TikuConfig;
  onChange: (config: TikuConfig) => void;
  saveState: SaveState;
  onSave: () => void;
}) {
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState<"idle" | "loading" | "success" | "empty">("idle");

  useEffect(() => {
    let cancelled = false;

    setModelStatus(tiku.apiUrl ? "loading" : "idle");
    fetchModelsByApiUrl(tiku.apiUrl)
      .then((models) => {
        if (cancelled) {
          return;
        }

        setModelOptions(models);
        setModelStatus(models.length ? "success" : "empty");

        if (models.length && !models.includes(tiku.model)) {
          onChange({ ...tiku, model: models[0] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions([]);
          setModelStatus("empty");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tiku.apiUrl]);

  return (
    <FormShell saveState={saveState} onSave={onSave} buttonLabel="保存 AI 答题设置">
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="AI 服务商 Provider">
          <input
            className="field"
            value={tiku.provider}
            placeholder="例如 AI 或 SiliconFlow"
            onChange={(event) => onChange({ ...tiku, provider: event.target.value })}
          />
        </Field>
        <Field label="官网/文档链接">
          <input
            className="field"
            type="url"
            value={tiku.officialUrl}
            placeholder="https://..."
            onChange={(event) => onChange({ ...tiku, officialUrl: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Field label="API 请求地址" error={!tiku.apiUrl ? "请输入 AI 答题 API 请求地址" : undefined}>
          <input
            className="field"
            type="url"
            value={tiku.apiUrl}
            placeholder="https://.../v1/chat/completions"
            onChange={(event) => onChange({ ...tiku, apiUrl: event.target.value })}
          />
        </Field>
        <Field label="模型名称">
          <select
            className="field"
            value={tiku.model}
            disabled={modelStatus === "loading" || modelStatus === "idle" || modelStatus === "empty"}
            onChange={(event) => onChange({ ...tiku, model: event.target.value })}
          >
            {modelStatus === "loading" ? <option>正在获取模型列表</option> : null}
            {modelStatus === "idle" ? <option>先填写 API 请求地址</option> : null}
            {modelStatus === "empty" ? <option>未识别到可用模型</option> : null}
            {modelStatus === "success"
              ? modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))
              : null}
          </select>
          <p className="mt-1 text-xs leading-5 text-emerald-950/55">
            根据 API 请求地址自动获取模型列表。当前为前端 mock，后续可替换为后端模型接口。
          </p>
        </Field>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Field label="API Key">
          <input
            className="field"
            value={tiku.token}
            placeholder="sk-... 或服务商控制台密钥"
            onChange={(event) => onChange({ ...tiku, token: event.target.value })}
          />
        </Field>
        <Field label={`AI 答题覆盖率 ${tiku.coverRate}%`}>
          <input
            className="w-full accent-emerald-700"
            type="range"
            min={0}
            max={100}
            value={tiku.coverRate}
            onChange={(event) => onChange({ ...tiku, coverRate: Number(event.target.value) })}
          />
        </Field>
      </div>
      <Toggle
        checked={tiku.submit}
        label="AI 覆盖率达标后提交"
        text="关闭时仅保存 AI 生成的答案，后续可人工检查。"
        onChange={(checked) => onChange({ ...tiku, submit: checked })}
      />
      <InlineAlert
        tone={tiku.apiUrl && tiku.model && modelStatus === "success" ? "success" : "error"}
        text={
          tiku.apiUrl && tiku.model && modelStatus === "success"
            ? "AI 答题通过 API 请求地址、模型名称和 API Key 接入，保存后由后端任务使用。"
            : "API 请求地址无法匹配模型列表时，后续无法接入真实 AI 答题服务。"
        }
      />
    </FormShell>
  );
}

function NotificationSettings({
  notification,
  onChange,
  saveState,
  onSave,
  onTest,
}: {
  notification: NotificationConfig;
  onChange: (config: NotificationConfig) => void;
  saveState: SaveState;
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <FormShell saveState={saveState} onSave={onSave} buttonLabel="保存通知设置">
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Field label="Provider">
          <select
            className="field"
            value={notification.provider}
            onChange={(event) => onChange({ ...notification, provider: event.target.value })}
          >
            <option>ServerChan</option>
            <option>PushPlus</option>
            <option>Bark</option>
            <option>自定义</option>
          </select>
        </Field>
        <Field label="Webhook / URL" error={!notification.url ? "测试通知需要填写 URL" : undefined}>
          <input
            className="field"
            value={notification.url}
            placeholder="https://..."
            onChange={(event) => onChange({ ...notification, url: event.target.value })}
          />
        </Field>
      </div>
      <button className="secondary-button w-fit" type="button" onClick={onTest}>
        <Bell size={17} />
        测试通知
      </button>
      <InlineAlert tone={notification.url ? "success" : "error"} text={notification.url ? "通知地址格式待后端验证。" : "未填写 URL 时不会发送外部通知。"} />
    </FormShell>
  );
}

function LogsView({
  logs,
  allLogs,
  filter,
  autoScroll,
  onFilter,
  onAutoScroll,
  onClear,
  onSeedError,
}: {
  logs: ConsoleLog[];
  allLogs: ConsoleLog[];
  filter: LogLevel | "all";
  autoScroll: boolean;
  onFilter: (value: LogLevel | "all") => void;
  onAutoScroll: (value: boolean) => void;
  onClear: () => void;
  onSeedError: () => void;
}) {
  const errorLogs = allLogs.filter((log) => log.level === "error");
  return (
    <div className="space-y-4">
      <Panel title="日志控制" icon={TerminalWindow}>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            value={filter}
            options={[
              { label: "全部", value: "all" },
              { label: "Info", value: "info" },
              { label: "Warn", value: "warn" },
              { label: "Error", value: "error" },
            ]}
            onChange={(value) => onFilter(value as LogLevel | "all")}
          />
          <Toggle checked={autoScroll} label="自动滚动" text="新日志出现时跟随到底部。" onChange={onAutoScroll} compact />
          <button className="secondary-button" onClick={onSeedError}>
            <WarningCircle size={17} />
            模拟错误
          </button>
          <button className="secondary-button" onClick={onClear}>
            清空日志
          </button>
        </div>
      </Panel>

      {errorLogs.length > 0 ? <InlineAlert tone="error" text={`当前共有 ${errorLogs.length} 条错误日志，建议先检查账号、验证码或通知配置。`} /> : null}

      <div className="rounded-[8px] border border-emerald-950/10 bg-[#0d1612] p-3 shadow-sm">
        {logs.length ? (
          <div className="max-h-[520px] overflow-auto font-mono text-sm leading-6 text-emerald-50">
            {logs.map((log) => (
              <LogRow key={log.id} log={log} terminal />
            ))}
          </div>
        ) : (
          <div className="grid min-h-56 place-items-center text-center text-sm text-emerald-50/60">
            暂无日志。开始任务或点击模拟错误后会显示输出。
          </div>
        )}
      </div>
    </div>
  );
}

function HelpView({ command }: { command: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="源码运行" icon={TerminalWindow}>
        <CodeBlock value={"pip install -r requirements.txt\npython main.py"} />
      </Panel>
      <Panel title="配置文件运行" icon={FileText}>
        <CodeBlock value={"copy config_template.ini config.ini\npython main.py -c config.ini"} />
      </Panel>
      <Panel title="命令行参数运行" icon={ClipboardText}>
        <CodeBlock value={command} />
      </Panel>
      <Panel title="Docker 运行" icon={TerminalWindow}>
        <CodeBlock value={"docker build -t chaoxing .\ndocker run -it -v 本地路径/config.ini:/config/config.ini chaoxing"} />
      </Panel>
      <div className="xl:col-span-2">
        <Panel title="免责声明入口" icon={WarningCircle}>
          <p className="max-w-[78ch] text-sm leading-6 text-emerald-950/70">
            本页面是本地配置与任务观察原型，仅用于学习讨论和项目维护。请遵守平台规则、开源协议和项目 README 中的免责声明。
          </p>
        </Panel>
      </div>
    </div>
  );
}

function FormShell({
  children,
  saveState,
  onSave,
  buttonLabel,
}: {
  children: React.ReactNode;
  saveState: SaveState;
  onSave: () => void;
  buttonLabel: string;
}) {
  return (
    <Panel title="配置表单" icon={GearSix}>
      <div className="space-y-5">
        {saveState === "loading" ? <SkeletonRows /> : children}
        {saveState === "error" ? <InlineAlert tone="error" text="保存失败，请检查必填项。" /> : null}
        {saveState === "success" ? <InlineAlert tone="success" text="配置已保存到后端 config.ini。" /> : null}
        <button className="primary-button" onClick={onSave} disabled={saveState === "loading"}>
          {saveState === "loading" ? "保存中" : buttonLabel}
        </button>
      </div>
    </Panel>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: ComponentType<{ size?: number; weight?: "regular" | "fill" | "duotone" }>;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-[8px] border border-emerald-950/10 bg-white p-4 shadow-sm shadow-emerald-950/[0.03] md:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={18} weight="duotone" />
        <h2 className="text-base font-semibold tracking-[0] text-[#10201a]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "active" | "neutral" | "warn" | "error" }) {
  return (
    <div className="rounded-[8px] border border-emerald-950/10 bg-white p-4 shadow-sm shadow-emerald-950/[0.03]">
      <p className="text-sm text-emerald-950/60">{label}</p>
      <p
        className={cx(
          "mt-2 text-2xl font-semibold tracking-[0]",
          tone === "active" && "text-emerald-700",
          tone === "neutral" && "text-[#10201a]",
          tone === "warn" && "text-amber-700",
          tone === "error" && "text-red-700",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-emerald-950/75">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs font-medium text-red-700">{error}</span> : null}
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-[8px] border border-emerald-950/10 bg-emerald-50 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          className={cx(
            "h-9 rounded-[8px] px-3 text-sm font-medium transition active:translate-y-px",
            value === option.value ? "bg-white text-emerald-800 shadow-sm" : "text-emerald-950/60 hover:text-emerald-950",
          )}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  label,
  text,
  onChange,
  compact,
}: {
  checked: boolean;
  label: string;
  text: string;
  onChange: (checked: boolean) => void;
  compact?: boolean;
}) {
  return (
    <button
      className={cx(
        "flex items-center gap-3 rounded-[8px] border border-emerald-950/10 bg-white text-left transition hover:bg-emerald-50 active:translate-y-px",
        compact ? "px-3 py-2" : "w-full p-3",
      )}
      type="button"
      onClick={() => onChange(!checked)}
    >
      <span className={cx("relative h-6 w-11 rounded-full transition", checked ? "bg-emerald-700" : "bg-emerald-950/20")}>
        <span className={cx("absolute top-1 size-4 rounded-full bg-white transition", checked ? "left-6" : "left-1")} />
      </span>
      <span>
        <span className="block text-sm font-medium text-[#10201a]">{label}</span>
        {!compact ? <span className="block text-xs leading-5 text-emerald-950/60">{text}</span> : null}
      </span>
    </button>
  );
}

function ChecklistItem({ checked, title, text }: { checked: boolean; title: string; text: string }) {
  return (
    <div className="rounded-[8px] border border-emerald-950/10 p-3">
      <div className="flex items-center gap-2">
        {checked ? <CheckCircle size={18} weight="fill" className="text-emerald-700" /> : <WarningCircle size={18} weight="fill" className="text-amber-700" />}
        <p className="text-sm font-semibold text-[#10201a]">{title}</p>
      </div>
      <p className="mt-2 text-sm leading-5 text-emerald-950/60">{text}</p>
    </div>
  );
}

function InlineAlert({ tone, text }: { tone: "success" | "error"; text: string }) {
  return (
    <div
      className={cx(
        "flex items-start gap-2 rounded-[8px] border px-3 py-2 text-sm leading-5",
        tone === "success" ? "border-emerald-700/20 bg-emerald-50 text-emerald-900" : "border-red-700/20 bg-red-50 text-red-900",
      )}
    >
      {tone === "success" ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
      <span>{text}</span>
    </div>
  );
}

function LogRow({ log, terminal }: { log: ConsoleLog; terminal?: boolean }) {
  return (
    <div className={cx("grid grid-cols-[72px_64px_1fr] gap-2 py-1", terminal ? "text-emerald-50/85" : "text-sm text-emerald-950/70")}>
      <span className={terminal ? "text-emerald-50/45" : "text-emerald-950/45"}>{log.time}</span>
      <span
        className={cx(
          "font-semibold",
          log.level === "info" && (terminal ? "text-emerald-300" : "text-emerald-700"),
          log.level === "warn" && "text-amber-600",
          log.level === "error" && "text-red-500",
        )}
      >
        {log.level.toUpperCase()}
      </span>
      <span>{log.message}</span>
    </div>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-[8px] bg-[#0d1612] p-4 text-sm leading-6 text-emerald-50">
      <code>{value}</code>
    </pre>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-12 animate-pulse rounded-[8px] bg-emerald-950/10" />
      ))}
    </div>
  );
}

function IconButton({
  label,
  children,
  className,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx("grid size-10 place-items-center rounded-[8px] border border-emerald-950/10 bg-white text-emerald-950 transition hover:bg-emerald-50 active:translate-y-px", className)}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function StatusPill({ state }: { state: RunState }) {
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center rounded-[8px] px-3 text-xs font-semibold",
        state === "running" && "bg-emerald-100 text-emerald-800",
        state === "idle" && "bg-emerald-950/10 text-emerald-950/70",
        state === "done" && "bg-emerald-100 text-emerald-800",
        state === "error" && "bg-red-100 text-red-800",
      )}
    >
      {runLabel(state)}
    </span>
  );
}

function runLabel(state: RunState) {
  const labels: Record<RunState, string> = {
    idle: "未运行",
    running: "运行中",
    error: "异常",
    done: "已完成",
  };
  return labels[state];
}

export default App;
