// harness-portal：本机 DSH Desktop / Harness 的控制入口页。
//
// 页面功能：
//   1. 顶部检测 DSH Desktop 进程是否运行，提供「启动 / 关闭」按钮；
//   2. 自动从 harness.log 解析当前内核地址（含启动 token）；
//   3. 展示「内网（本地）地址」和「公网地址」（公网地址 = 本地地址把
//      127.0.0.1:43129 替换成 vvv.zhouzifei.com:43127，token 原样保留）；
//   4. 点击地址卡片在新标签页跳转；后台持续跟踪内核重启。
//
// 零第三方依赖，仅使用 Go 标准库。
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultProxyToken  = "xiaofei123"
	defaultAppPath     = `D:\dsh\DSH Desktop\DSH Desktop.exe`
	defaultAppExe      = "DSH Desktop.exe"
	defaultPublicHost  = "vvv.zhouzifei.com:43127"
)

func main() {
	var (
		listenHost = flag.String("host", "0.0.0.0", "监听地址（127.0.0.1 仅本机；0.0.0.0 局域网可访问）")
		listenPort = flag.Int("port", 43333, "监听端口")
		kernelURL  = flag.String("kernel", "", "内核完整地址（含 token），不指定则自动从日志发现")
		logPath    = flag.String("log", "", "harness.log 路径，不指定则在常见位置查找")
		appPath    = flag.String("app", defaultAppPath, "DSH Desktop 可执行文件路径")
		appExe     = flag.String("app-name", defaultAppExe, "DSH Desktop 进程映像名（用于检测/关闭）")
		publicHost = flag.String("public-host", defaultPublicHost, "公网主机（替换本地地址的 host）")
		proxyToken = flag.String("proxy-token", defaultProxyToken, "访问本页面的固定 token")
	)
	flag.Parse()

	mgr := newKernelManager()
	if *kernelURL != "" {
		if err := mgr.setKernelURL(*kernelURL); err != nil {
			log.Fatalf("内核地址无效: %v", err)
		}
	} else {
		mgr.logPath = *logPath
		if err := mgr.discover(); err != nil {
			log.Printf("⚠ 暂时未能发现内核: %v（会继续在后台尝试）", err)
		}
	}
	go mgr.backgroundLoop()

	app := &appController{appPath: *appPath, exeName: *appExe}
	page := &portalPage{mgr: mgr, publicHost: *publicHost}

	// 受 token 保护的路由
	protected := http.NewServeMux()
	protected.HandleFunc("/api/app/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"running": app.isRunning()})
	})
	protected.HandleFunc("/api/app/start", func(w http.ResponseWriter, r *http.Request) {
		if err := app.start(); err != nil {
			writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		log.Printf("已启动 DSH Desktop: %s", app.appPath)
		writeJSON(w, map[string]any{"ok": true})
	})
	protected.HandleFunc("/api/app/stop", func(w http.ResponseWriter, r *http.Request) {
		if err := app.stop(); err != nil {
			writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		log.Printf("已关闭 DSH Desktop")
		writeJSON(w, map[string]any{"ok": true})
	})
	protected.HandleFunc("/", page.serve)

	mux := http.NewServeMux()
	mux.HandleFunc("/__health", func(w http.ResponseWriter, r *http.Request) {
		full, _, _ := mgr.snapshot()
		status := "ready"
		if full == "" {
			status = "waiting-kernel"
		}
		fmt.Fprintf(w, `{"status":%q,"app_running":%t,"kernel":%q,"public_host":%q}`,
			status, app.isRunning(), full, *publicHost)
	})
	mux.Handle("/", tokenAuth(*proxyToken, protected))

	addr := fmt.Sprintf("%s:%d", *listenHost, *listenPort)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("harness-portal 启动：监听 %s", addr)
		full, _, _ := mgr.snapshot()
		if full != "" {
			log.Printf("当前内核: %s", full)
		}
		log.Printf("DSH Desktop: %s（运行中=%t）", app.appPath, app.isRunning())
		log.Printf("公网主机: %s", *publicHost)
		log.Printf("页面 token: %s", maskToken(*proxyToken))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("监听失败: %v", err)
		}
	}()

	<-stop
	log.Println("正在关闭...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func writeJSON(w http.ResponseWriter, v map[string]any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	fmt.Fprintf(w, "%s", jsonString(v))
}

// 极简 JSON 拼接（仅用于已知安全的 ASCII/受控字符串）。
func jsonString(v map[string]any) string {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	for k, val := range v {
		if !first {
			b.WriteByte(',')
		}
		first = false
		fmt.Fprintf(&b, "%q:", k)
		switch t := val.(type) {
		case string:
			fmt.Fprintf(&b, "%q", t)
		case bool:
			fmt.Fprintf(&b, "%t", t)
		default:
			b.WriteString("null")
		}
	}
	b.WriteByte('}')
	return b.String()
}

// ---------------------------------------------------------------------------
// DSH Desktop 进程控制
// ---------------------------------------------------------------------------

type appController struct {
	appPath string
	exeName string
	probes  func() []string // 用于检测的 host:port 列表
}

// isRunning 通过 TCP 探测 DSH Desktop 的监听端口判断是否运行
// （内核 43129/43130、桥接 43127/43128）。
func (a *appController) isRunning() bool {
	for _, addr := range a.probes() {
		conn, err := net.DialTimeout("tcp", addr, 1500*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
	}
	return false
}

// start 以分离方式启动 DSH Desktop（GUI 程序，不随门户退出）。
func (a *appController) start() error {
	if a.isRunning() {
		return errors.New("DSH Desktop 已在运行")
	}
	if _, err := os.Stat(a.appPath); err != nil {
		return fmt.Errorf("找不到程序: %w", err)
	}
	cmd := exec.Command(a.appPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200, // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
	}
	return cmd.Start()
}

// stop 强制结束 DSH Desktop 及其进程树。
func (a *appController) stop() error {
	cmd := exec.Command("taskkill", "/F", "/T", "/IM", a.exeName)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("关闭失败: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// ---------------------------------------------------------------------------
// 内核发现
// ---------------------------------------------------------------------------

type kernelManager struct {
	mu sync.Mutex

	logPath     string
	baseURL     string // 形如 http://127.0.0.1:43129
	launchToken string
	fullURL     string // 日志里的完整地址（含 token）
	updatedAt   time.Time
}

func newKernelManager() *kernelManager {
	return &kernelManager{}
}

var dshWebPattern = regexp.MustCompile(`dsh web:\s+(https?://[^\s]+)`)

// snapshot 返回当前完整地址、基础地址和更新时间。
func (m *kernelManager) snapshot() (full, base string, at time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.fullURL, m.baseURL, m.updatedAt
}

// 从日志中解析最后一条 “dsh web: <url>”。
func (m *kernelManager) discover() error {
	path := m.logPath
	if path == "" {
		found := findExistingLog()
		if found == "" {
			return errors.New("没有找到 harness.log（可用 -log 指定）")
		}
		path = found
		m.logPath = path
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("读取日志失败: %w", err)
	}

	matches := dshWebPattern.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		return errors.New("日志中没有内核地址")
	}
	return m.setKernelURL(matches[len(matches)-1][1])
}

func findExistingLog() string {
	appData := os.Getenv("APPDATA")
	candidates := []string{
		// 这台机器 APPDATA 被重定向到了 D:\Roaming
		`D:\Roaming\dsh-desktop\logs\harness.log`,
		`D:\Roaming\dsh-desktop-dev\logs\harness.log`,
	}
	if appData != "" {
		candidates = append(candidates,
			appData+`\dsh-desktop\logs\harness.log`,
			appData+`\dsh-desktop-dev\logs\harness.log`,
		)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}

// setKernelURL 接收完整的内核地址（含 ?token=）。
func (m *kernelManager) setKernelURL(raw string) error {
	full := strings.TrimSpace(raw)
	u, err := url.Parse(full)
	if err != nil {
		return err
	}
	token := u.Query().Get("token")
	baseURL := *u
	baseURL.RawQuery = ""
	baseURL.Fragment = ""
	base := strings.TrimRight(baseURL.String(), "?")

	m.mu.Lock()
	defer m.mu.Unlock()
	if full != m.fullURL {
		m.fullURL = full
		m.baseURL = base
		m.launchToken = token
		m.updatedAt = time.Now()
	}
	return nil
}

// 后台：周期性重读日志，内核重启后切到新地址。
func (m *kernelManager) backgroundLoop() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		_ = m.discover()
	}
}

// ---------------------------------------------------------------------------
// 入口导航页
// ---------------------------------------------------------------------------

type portalPage struct {
	mgr        *kernelManager
	publicHost string
}

type portalData struct {
	Local     string
	Public    string
	HasLocal  bool
	UpdatedAt string
}

// publicURL 把本地地址的 host 替换成公网主机，query（token）原样保留。
func derivePublic(local, publicHost string) string {
	u, err := url.Parse(local)
	if err != nil {
		return ""
	}
	u.Host = publicHost
	return u.String()
}

var portalTmpl = template.Must(template.New("portal").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)">
<title>DSH Harness 入口</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#18191c;--muted:#81858c;--line:#e8eaed;--accent:#2d6cdf;--ok:#22a55a;--warn:#b7791f;--danger:#d24b4b}
@media(prefers-color-scheme:dark){:root{--bg:#0f1012;--card:#181a1d;--ink:#f2f3f5;--muted:#95979d;--line:#26282c;--accent:#5b8def;--ok:#3ec478;--danger:#e06c6c}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px 18px}
.wrap{max-width:560px;margin:0 auto}
h1{margin:0 0 4px;font-size:26px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:14px;margin:0 0 20px}

/* 顶部：应用状态 + 启动/关闭 */
.control{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin-bottom:18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.status{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14.5px;flex:1}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}
.dot.run{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 22%,transparent)}
.btn{border:0;border-radius:10px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.start{background:var(--accent);color:#fff}
.btn.stop{background:color-mix(in srgb,var(--danger) 14%,transparent);color:var(--danger)}
.hint{font-size:12.5px;color:var(--muted);width:100%}
.hint.err{color:var(--danger)}

.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:16px;text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--accent);transform:translateY(-1px)}
.row{display:flex;align-items:center;gap:10px}
.badge{flex:none;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}
.url{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--muted);word-break:break-all}
.open{flex:none;font-weight:600;font-size:14px;color:var(--accent);white-space:nowrap}
.warnbox{background:color-mix(in srgb,#e5a13a 14%,transparent);border:1px solid color-mix(in srgb,#e5a13a 45%,transparent);color:var(--warn);border-radius:12px;padding:12px 14px;font-size:13.5px;margin-bottom:16px}
.meta{color:var(--muted);font-size:12.5px;margin-top:6px}
.meta a{color:var(--accent);text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>DSH Harness 入口</h1>
  <p class="sub">控制 DSH Desktop，或选择要打开的内核地址。</p>

  <!-- DSH Desktop 运行状态 + 启动/关闭 -->
  <div class="control">
    <div class="status">
      <span id="dot" class="dot"></span>
      <span id="statusText">检测中…</span>
    </div>
    <button id="btnStart" class="btn start" onclick="appAction('start')">启动</button>
    <button id="btnStop" class="btn stop" onclick="appAction('stop')">关闭</button>
    <div id="actionHint" class="hint"></div>
  </div>

  {{if not .HasLocal}}
  <div class="warnbox">尚未发现本地内核地址，请先启动 DSH Desktop；页面会在发现后自动更新（每 15 秒重新检测）。</div>
  {{end}}

  {{if .HasLocal}}
  <a class="card" href="{{.Local}}" target="_blank" rel="noopener noreferrer">
    <div class="row">
      <span class="badge">内网 · 本地</span>
      <span class="url">{{.Local}}</span>
      <span class="open">打开 ↗</span>
    </div>
  </a>

  <a class="card" href="{{.Public}}" target="_blank" rel="noopener noreferrer">
    <div class="row">
      <span class="badge">公网</span>
      <span class="url">{{.Public}}</span>
      <span class="open">打开 ↗</span>
    </div>
  </a>
  {{end}}

  <p class="meta">
    {{if .HasLocal}}内核地址更新于 {{.UpdatedAt}} · {{end}}
    <a href="./">刷新页面</a>
  </p>
</div>

<script>
const $ = (id) => document.getElementById(id)

function setRunning(running) {
  $('dot').classList.toggle('run', running)
  $('statusText').textContent = running ? 'DSH Desktop 运行中' : 'DSH Desktop 已停止'
  $('btnStart').disabled = running
  $('btnStop').disabled = !running
}

async function refreshStatus() {
  try {
    const j = await (await fetch('/api/app/status')).json()
    setRunning(j.running)
  } catch (e) { /* 忽略瞬时失败 */ }
}

async function appAction(action) {
  const hint = $('actionHint')
  hint.className = 'hint'
  hint.textContent = action === 'start' ? '正在启动…' : '正在关闭…'
  try {
    const j = await (await fetch('/api/app/' + action, { method: 'POST' })).json()
    if (!j.ok) {
      hint.className = 'hint err'
      hint.textContent = '操作失败：' + (j.error || '未知错误')
      return
    }
    hint.textContent = action === 'start'
      ? '已启动，等待内核就绪…'
      : '已关闭。'
    await refreshStatus()
    if (action === 'start') {
      // 内核需要几秒启动；10 秒后整页刷新以更新地址卡片
      setTimeout(() => location.reload(), 10000)
    }
  } catch (e) {
    hint.className = 'hint err'
    hint.textContent = '请求失败：' + e
  }
}

refreshStatus()
setInterval(refreshStatus, 4000)
</script>
</body>
</html>`))

func (p *portalPage) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	full, _, at := p.mgr.snapshot()
	data := portalData{
		Local:    full,
		Public:   derivePublic(full, p.publicHost),
		HasLocal: full != "",
	}
	if full != "" {
		data.UpdatedAt = at.Format("2006-01-02 15:04:05")
	}

	w.Header().Set("content-type", "text/html; charset=utf-8")
	if err := portalTmpl.Execute(w, data); err != nil {
		log.Printf("渲染页面失败: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 页面固定 token 校验
// ---------------------------------------------------------------------------

func tokenAuth(expected string, next http.Handler) http.Handler {
	const cookieName = "harness_proxy_token"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided := r.URL.Query().Get("token")
		if provided == "" {
			if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
				provided = strings.TrimPrefix(auth, "Bearer ")
			}
		}
		if provided == "" {
			provided = r.Header.Get("X-Proxy-Token")
		}
		// 浏览器首次 ?token=xxx 访问后会种下此 Cookie，后续自动带上
		if provided == "" {
			if c, err := r.Cookie(cookieName); err == nil {
				provided = c.Value
			}
		}

		if subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			w.Header().Set("www-authenticate", `Bearer realm="harness-portal"`)
			http.Error(w, `{"ok":false,"error":"token 无效"}`, http.StatusUnauthorized)
			return
		}

		// 通过 query/header 鉴权且还没有 Cookie 时种一个，方便浏览器连续使用
		if existing, err := r.Cookie(cookieName); err != nil || existing.Value != provided {
			http.SetCookie(w, &http.Cookie{
				Name:     cookieName,
				Value:    provided,
				Path:     "/",
				MaxAge:   7 * 24 * 60 * 60,
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
			})
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func maskToken(t string) string {
	if len(t) <= 8 {
		return strings.Repeat("*", len(t))
	}
	return t[:4] + "…" + t[len(t)-4:]
}
