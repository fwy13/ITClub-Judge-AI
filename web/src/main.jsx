import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  NavLink,
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";
import {
  Code2,
  House,
  Layers3,
  Trophy,
  ChartNoAxesCombined,
  LogOut,
  LogIn,
  Upload,
  Play,
  CheckCircle2,
  Clock3,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Terminal,
  Search,
  Menu,
  UserRound,
  ChevronDown,
  FileSpreadsheet,
  Activity,
  Download,
  Database,
  Trash2,
  ArchiveRestore,
} from "lucide-react";
import MonacoEditor from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";
const API = "/api";
function configureProblemEditor(monaco) {
  monaco.editor.defineTheme("itclub-python", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "F47CFF", fontStyle: "bold" },
      { token: "type.identifier", foreground: "45E6C8" },
      { token: "identifier", foreground: "77BDFB" },
      { token: "string", foreground: "B8E986" },
      { token: "number", foreground: "FFCB6B" },
      { token: "comment", foreground: "8494A8", fontStyle: "italic" },
      { token: "delimiter", foreground: "D7E3F0" },
      { token: "operator", foreground: "89DDFF" },
    ],
    colors: {
      "editor.background": "#1E242E",
      "editor.foreground": "#D7E3F0",
      "editor.lineHighlightBackground": "#293241",
      "editorLineNumber.foreground": "#65758B",
      "editorLineNumber.activeForeground": "#B8C7D9",
      "editorCursor.foreground": "#64FFDA",
      "editor.selectionBackground": "#315A7D99",
      "editorIndentGuide.background1": "#334155",
      "editorIndentGuide.activeBackground1": "#64748B",
    },
  });
}
async function request(path, options = {}) {
  const token = localStorage.getItem("token");
  const isForm = options.body instanceof FormData;
  const r = await fetch(API + path, {
    ...options,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || `HTTP ${r.status}`);
  return j;
}
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
function metricLabel(metric) {
  return String(metric || "score").replaceAll("_", " ").toUpperCase();
}
function metricScore(score) {
  if (score == null || !Number.isFinite(Number(score))) return "—";
  return Number(score).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
function submissionScore(submission) {
  if (submission?.score == null || !Number.isFinite(Number(submission.score))) return "—";
  if (submission.kind === "code") return `${Number(submission.score).toFixed(2).replace(/\.00$/, "")}%`;
  return `${metricScore(submission.score)}${submission.metric ? ` ${metricLabel(submission.metric)}` : ""}`;
}
function UserAvatar({ user, className = "" }) {
  const initials = (user?.username || "?").slice(0, 2).toUpperCase();
  return (
    <span className={`user-avatar ${className}`.trim()}>
      {user?.avatar ? <img src={user.avatar} alt="" /> : initials}
    </span>
  );
}
function App() {
  const [user, setUser] = useState(
    JSON.parse(localStorage.getItem("user") || "null"),
  );
  const [drawer, setDrawer] = useState(false);
  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
    location.href = "/";
  };
  return (
    <BrowserRouter>
      <header className="topbar">
        <div className="navwrap">
          <Link to="/" className="brand">
            <img src="/itclub-logo.png" alt="IT CLUB" />
          </Link>
          <button className="mobile-toggle" onClick={() => setDrawer(!drawer)}>
            <Menu size={22} />
          </button>
          <nav
            className={drawer ? "nav open" : "nav"}
            onClick={() => setDrawer(false)}
          >
            <NavLink to="/" end>
              <House size={16} /> Home
            </NavLink>
            <NavLink to="/problems">
              <Layers3 size={16} /> AI Arena
            </NavLink>
            <NavLink to="/contests">
              <Trophy size={16} /> Contests
            </NavLink>
            <NavLink to="/ranklist">
              <ChartNoAxesCombined size={16} /> Ranklist
            </NavLink>
            <NavLink to="/submissions">
              <Activity size={16} /> My submissions
            </NavLink>
            {user?.role === "admin" && (
              <NavLink to="/admin/problems">
                <ShieldCheck size={16} /> Admin
              </NavLink>
            )}
          </nav>
          <div className="account">
            {user ? (
              <>
                <Link
                  className="account-profile"
                  to="/profile"
                  title="View profile"
                >
                  <UserAvatar user={user} className="account-avatar" />
                  <span className="account-name">{user.username}</span>
                  <ChevronRight className="account-profile-arrow" size={13} />
                </Link>
                <button className="btn ghost small" onClick={logout}>
                  <LogOut size={16} /> Logout
                </button>
              </>
            ) : (
              <Link className="btn primary small" to="/login">
                <LogIn size={16} /> Login / Register
              </Link>
            )}
          </div>
        </div>
      </header>
      <main>
        <RouterContent user={user} setUser={setUser} />
      </main>
      <footer>
        <span>
          <b>IT CLUB</b> · AI Online Judge
        </span>
        <span>
          Built for learning, experimentation and responsible assessment.
        </span>
      </footer>
    </BrowserRouter>
  );
}
function RouterContent({ user, setUser }) {
  const p = useLocation().pathname;
  if (p === "/") return <Home />;
  if (p === "/login" || p === "/register")
    return <AuthPage setUser={setUser} register={p === "/register"} />;
  if (p === "/profile") return <ProfilePage user={user} setUser={setUser} />;
  if (p.startsWith("/profile/"))
    return <ProfilePage user={user} setUser={setUser} username={decodeURIComponent(p.split("/")[2])} />;
  if (p === "/problems") return <Problems />;
  if (p.startsWith("/problems/"))
    return (
      <ProblemPage slug={decodeURIComponent(p.split("/")[2])} user={user} />
    );
  if (p === "/submissions") return <Submissions user={user} />;
  if (p.startsWith("/submissions/"))
    return <SubmissionDetail id={p.split("/")[2]} user={user} />;
  if (p === "/admin/problems") return <AdminProblems user={user} />;
  if (p === "/ranklist") return <Ranklist />;
  if (p === "/contests") return <Contests />;
  return (
    <div className="shell">
      <h2>Page not found</h2>
      <Link to="/problems">Browse problems</Link>
    </div>
  );
}
function Home() {
  return (
    <>
      <section className="hero">
        <div className="shell hero-grid">
          <div>
            <h1>
              ITClub Arena
              <br />
              <span>Cùng nhau chiến thắng</span>
            </h1>
            <p>
              Contest sẽ diễn ra vào 14:00 chiều thứ Hai hằng tuần
              <br />
              Tham gia để luyện tập, thử sức và nâng cao kỹ năng của bạn
            </p>
            <div className="actions">
              <Link className="btn bright" to="/problems">
                Explore problems <ChevronRight size={17} />
              </Link>
              <Link className="btn outline-light" to="/ranklist">
                View leaderboard
              </Link>
            </div>
          </div>
          <div className="hero-art">
            <div className="terminal-top">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span>submission.py</span>
              <Terminal size={17} />
            </div>
            <div className="terminal-code">
              <div>
                <em>01</em>
                <span className="purple">import</span> numpy{" "}
                <span className="purple">as</span> np
              </div>
              <div>
                <em>02</em>
              </div>
              <div>
                <em>03</em>
                <span className="blue">def</span>{" "}
                <span className="cyan">solve</span>(arr):
              </div>
              <div>
                <em>04</em> <span className="purple">return</span>{" "}
                np.maximum(arr, 0)
              </div>
              <div>
                <em>05</em>
              </div>
              <div>
                <em>06</em>
                <span className="comment"># Real-time test feedback</span>
              </div>
            </div>
            <div className="terminal-result">
              <CheckCircle2 size={19} /> Test case 01 passed <span>0.043s</span>
            </div>
            <div className="terminal-result">
              <CheckCircle2 size={19} /> Test case 02 passed <span>0.046s</span>
            </div>
            <div className="terminal-running">
              <span className="spinner" /> Test case 03 running...
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
function AuthPage({ setUser, register }) {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      let data = await request("/auth/" + (register ? "register" : "login"), {
        method: "POST",
        body: JSON.stringify({ username, email, password }),
      });
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      setUser(data.user);
      nav("/");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="auth-back">
      <div className="auth-box">
        <div className="auth-icon">
          <ShieldCheck size={27} />
        </div>
        <h1>{register ? "Create an account" : "Welcome back"}</h1>
        <p>
          {register
            ? "Join the IT Club Judge community"
            : "Sign in to submit your solutions and track progress"}
        </p>
        <form onSubmit={submit}>
          <label>
            Username or email{register && <small> (username only)</small>}
            <input
              required
              placeholder={register ? "your_username" : "Username or email"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          {register && (
            <label>
              Email address
              <input
                required
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          <label>
            Password
            <input
              required
              type="password"
              minLength={register ? 10 : 1}
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <div className="error-msg">{error}</div>}
          <button disabled={loading} className="btn primary wide">
            {loading
              ? "Please wait..."
              : register
                ? "Create account"
                : "Sign in"}{" "}
            <ChevronRight size={18} />
          </button>
        </form>
        <div className="auth-switch">
          {register ? "Already have an account?" : "New to IT Club Judge?"}{" "}
          <Link to={register ? "/login" : "/register"}>
            {register ? "Sign in" : "Register now"}
          </Link>
        </div>
      </div>
    </div>
  );
}
async function resizeAvatar(file) {
  if (file.size > 8 * 1024 * 1024) throw Error("Original image must be 8 MB or smaller.");
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sourceX = (bitmap.width - side) / 2;
  const sourceY = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, sourceX, sourceY, side, side, 0, 0, 320, 320);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  if (!blob) throw Error("Could not process this image.");
  return new File([blob], "avatar.webp", { type: "image/webp" });
}
function ProfilePage({ user, setUser, username = null }) {
  const isOwn = !username || username === user?.username;
  const targetUsername = username || user?.username;
  const [profile, setProfile] = useState(isOwn ? user : null);
  const [form, setForm] = useState({ username: user?.username || "", email: user?.email || "" });
  const [loading, setLoading] = useState(Boolean(targetUsername));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const avatarInput = useRef(null);
  const applyProfile = (next, syncAccount = false) => {
    setProfile(next);
    if (syncAccount) {
      setForm({ username: next.username, email: next.email });
      setUser(next);
      localStorage.setItem("user", JSON.stringify(next));
    }
  };
  useEffect(() => {
    if (!targetUsername) return;
    setLoading(true);
    setError("");
    request(isOwn ? "/auth/me" : `/users/${encodeURIComponent(targetUsername)}/profile`)
      .then((data) => applyProfile(data.user, isOwn))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [targetUsername, isOwn]);
  const saveAccount = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const data = await request("/auth/profile", { method: "PUT", body: JSON.stringify(form) });
      applyProfile(data.user, true);
      setSuccess("Account information updated.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const changeAvatar = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const resized = await resizeAvatar(file);
      const body = new FormData();
      body.append("avatar", resized);
      const data = await request("/auth/avatar", { method: "POST", body });
      applyProfile({ ...profile, avatar: data.avatar }, true);
      setSuccess("Avatar cropped and resized successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  if (!targetUsername) {
    return (
      <div className="shell page profile-guest">
        <h1>Your profile</h1><p>Sign in to view and edit your account.</p>
        <Link className="btn primary" to="/login">Sign in</Link>
      </div>
    );
  }
  if (loading) return <div className="shell page"><p>Loading profile...</p></div>;
  if (!profile) return <div className="shell page profile-guest"><h1>Profile unavailable</h1><p>{error || "Profile not found."}</p><Link className="btn ghost" to="/ranklist">Back to ranklist</Link></div>;
  return (
    <div className="shell page profile-page">
      <section className="profile-hero">
        <UserAvatar user={profile} className="profile-avatar" />
        <div className="profile-identity">
          <h1>{profile.username}</h1>
          {isOwn && <p>{profile.email}</p>}
          <small>Member since {new Date(profile.created_at).toLocaleDateString()}</small>
        </div>
        <div className="profile-stats">
          <div><b>{profile.solved || 0}</b><span>Problems solved</span></div>
          <div><b>{profile.attempts || 0}</b><span>Submissions</span></div>
        </div>
      </section>

      <section className={`profile-content${isOwn ? "" : " profile-content-public"}`}>
        <div className="panel profile-summary">
          <div className="panel-head"><UserRound size={18} /> Profile overview</div>
          <dl className="profile-overview-grid">
            <div><dt>Username</dt><dd>{profile.username}</dd></div>
            {isOwn && <div><dt>Email</dt><dd>{profile.email}</dd></div>}
            <div><dt>Member since</dt><dd>{new Date(profile.created_at).toLocaleDateString()}</dd></div>
            {isOwn && <div><dt>User ID</dt><dd>{profile.id}</dd></div>}
          </dl>
        </div>

        {isOwn && (
          <div className="panel profile-editor">
            <div className="panel-head"><ShieldCheck size={18} /> Edit account</div>
            <div className="profile-avatar-editor">
              <UserAvatar user={profile} className="profile-edit-avatar" />
              <div>
                <strong>Profile picture</strong>
                <p>Choose an image up to 8 MB. It will be center-cropped and resized to 320 × 320 WebP.</p>
                <button className="btn ghost small" type="button" disabled={saving} onClick={() => avatarInput.current?.click()}>
                  <Upload size={15} /> Change avatar
                </button>
                <input ref={avatarInput} className="avatar-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={changeAvatar} />
              </div>
            </div>
            <form className="profile-form" onSubmit={saveAccount}>
              <label>Username<input required minLength={3} maxLength={40} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
              <label>Email address<input required type="email" maxLength={255} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
              {error && <div className="error-msg" role="alert">{error}</div>}
              {success && <div className="success-msg" role="status">{success}</div>}
              <button className="btn primary" disabled={saving}>{saving ? "Saving..." : "Save account"}</button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
function useProblems() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    request("/problems")
      .then((d) => setItems(d.problems))
      .catch((e) => setError(e.message));
  }, []);
  return { items, error };
}
function Pill({ children }) {
  return <span className="pill">{children}</span>;
}
function problemPresentation(problem) {
  const text = `${problem.category || ""} ${problem.title || ""} ${problem.slug || ""}`.toLowerCase();
  if (problem.kind === "csv") {
    if (/natural language|\bnlp\b|text|language/.test(text)) {
      return { track: "Natural Language Processing", tech: "Natural Language Processing", tone: "nlp" };
    }
    if (/computer vision|\bcv\b|image|vision/.test(text)) {
      return { track: "Computer Vision", tech: "Computer Vision", tone: "vision" };
    }
    return { track: "Machine Learning", tech: "Machine Learning", tone: "machine-learning" };
  }
  const tech = text.includes("pytorch")
    ? "PyTorch"
    : text.includes("numpy")
      ? "NumPy"
      : "Python";
  return { track: "Function Only", tech, tone: tech.toLowerCase() };
}
function problemSummary(description) {
  const text = String(description || "")
    .replace(/[`#>*_[\]()~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 150 ? `${text.slice(0, 147)}...` : text;
}
function Problems() {
  const { items, error } = useProblems();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const pageSize = 12;
  const shown = items.filter((p) => {
    const meta = problemPresentation(p);
    const searchable = `${p.title} ${p.category} ${p.slug} ${meta.track} ${meta.tech}`;
    return (
      (filter === "all" || p.kind === filter) &&
      searchable.toLowerCase().includes(search.toLowerCase())
    );
  });
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageItems = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => setPage(1), [search, filter]);
  return (
    <div className="shell page arena-page">
      <div className="arena-banner">
        <div className="arena-banner-copy">
          <span className="arena-kicker">AI OLYMPIC PRACTICE</span>
          <h1>AI Arena</h1>
          <p>
            Khám phá các thử thách lập trình và trí tuệ nhân tạo, luyện tập
            trên dữ liệu thực tế và chinh phục từng bài toán.
          </p>
          <div className="arena-stats">
            <span><Trophy size={16} /><b>{items.length}</b> challenges</span>
            <span><FileSpreadsheet size={16} /><b>{items.filter((p) => p.kind === "csv").length}</b> AI Tracks</span>
            <span><CheckCircle2 size={16} /> Automated evaluation</span>
          </div>
        </div>
        <div className="arena-banner-mark" aria-hidden="true">
          <span><Layers3 size={54} /></span>
        </div>
      </div>
      <div className="arena-toolbar">
        <div className="filters">
          <div className="search">
            <Search size={17} />
            <input
              placeholder="Search challenges..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="tabs">
            {[
              ["all", "All challenges"],
              ["code", "Function Only"],
              ["csv", "AI Tracks"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="error-msg">{error}</p>}
      <div className="arena-grid">
        {pageItems.map((p, i) => {
          const meta = problemPresentation(p);
          return (
            <Link
              key={p.slug}
              className={`arena-card arena-card-${meta.tone}`}
              to={`/problems/${p.slug}`}
            >
              <div className="arena-card-cover">
                <div className="arena-card-symbol">
                  {p.kind === "csv" ? <FileSpreadsheet size={28} /> : <Code2 size={28} />}
                </div>
                <strong>{meta.track}</strong>
                <span className="arena-card-number">#{String((currentPage - 1) * pageSize + i + 1).padStart(2, "0")}</span>
              </div>
              <div className="arena-card-body">
                <h2>{p.title}</h2>
                <p>{problemSummary(p.description)}</p>
                <span className="arena-tech">{meta.tech}</span>
                <div className="arena-card-footer">
                  <span className="arena-card-stats">
                    <span><Activity size={14} /> {p.submissions || 0} submissions</span>
                    <span><UserRound size={14} /> {p.participants || 0} participants</span>
                  </span>
                  <b>Open challenge <ChevronRight size={16} /></b>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      {!shown.length && !error && (
        <div className="panel empty">No challenges match your search.</div>
      )}
      {!!shown.length && pageCount > 1 && (
        <nav className="arena-pagination" aria-label="Challenge pages">
          <button type="button" aria-label="Previous page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button>
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
            <button type="button" key={number} className={number === currentPage ? "active" : ""} aria-current={number === currentPage ? "page" : undefined} onClick={() => setPage(number)}>{number}</button>
          ))}
          <button type="button" aria-label="Next page" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button>
        </nav>
      )}
      <div className="arena-count">Showing {pageItems.length} of {shown.length} challenges{pageCount > 1 ? ` · Page ${currentPage} of ${pageCount}` : ""}</div>
    </div>
  );
}
function ProblemPage({ slug, user }) {
  const [problem, setProblem] = useState(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState("description");
  const [mySubmissions, setMySubmissions] = useState([]);
  const [solutions, setSolutions] = useState([]);
  const [leaderboard, setLeaderboard] = useState(null);
  const [dataFiles, setDataFiles] = useState([]);
  const [solutionSearch, setSolutionSearch] = useState("");
  const [tabLoading, setTabLoading] = useState(false);
  const draftKey = `itclub-draft:${user?.id || "guest"}:${slug}`;
  useEffect(() => {
    request("/problems/" + slug)
      .then((d) => {
        setProblem(d.problem);
        setCode(localStorage.getItem(draftKey) ?? d.problem.starter ?? "");
        if (d.problem.kind === "csv") {
          request(`/problems/${encodeURIComponent(slug)}/data-files`)
            .then((data) => setDataFiles(data.files || []))
            .catch(() => setDataFiles([]));
        } else {
          setDataFiles([]);
        }
      })
      .catch((e) => setError(e.message));
  }, [slug]);
  useEffect(() => {
    if (activeTab !== "my" || !user) return;
    setTabLoading(true);
    request(`/submissions?slug=${encodeURIComponent(slug)}`)
      .then((data) => setMySubmissions(data.submissions || []))
      .catch((err) => setError(err.message))
      .finally(() => setTabLoading(false));
  }, [activeTab, user, slug, job]);
  useEffect(() => {
    if (activeTab !== "solutions" || !problem) return;
    setTabLoading(true);
    request(`/problems/${encodeURIComponent(slug)}/${problem.kind === "csv" ? "leaderboard" : "solutions"}`)
      .then((data) => {
        if (problem.kind === "csv") setLeaderboard(data);
        else setSolutions(data.solutions || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setTabLoading(false));
  }, [activeTab, slug, problem?.kind, job]);
  const updateCode = (value) => {
    const next = value ?? "";
    setCode(next);
    localStorage.setItem(draftKey, next);
  };
  const resetCode = () => {
    const starter = problem?.starter || "";
    setCode(starter);
    localStorage.setItem(draftKey, starter);
  };
  const visibleSolutions = solutions.filter((solution) => {
    const query = solutionSearch.trim().toLowerCase();
    if (!query) return true;
    return [solution.username, solution.status, solution.kind, solution.metric]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  const visibleLeaderboard = (leaderboard?.entries || []).filter((entry) => {
    const query = solutionSearch.trim().toLowerCase();
    return !query || entry.username.toLowerCase().includes(query);
  });
  const send = async () => {
    setError("");
    setSubmitting(true);
    try {
      let data;
      if (problem.kind === "csv") {
        if (!file) throw Error("Select a CSV file");
        const fd = new FormData();
        fd.set("slug", slug);
        fd.set("file", file);
        data = await request("/submissions/csv", { method: "POST", body: fd });
      } else {
        data = await request("/submissions/code", {
          method: "POST",
          body: JSON.stringify({ slug, code }),
        });
      }
      setJob(data.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  if (error && !problem)
    return <div className="shell page error-msg">{error}</div>;
  if (!problem) return <div className="shell page">Loading...</div>;
  return (
    <div className="shell page problem-detail-page">
      <div className="crumbs">
        <Link to="/problems">AI Arena</Link>
        <ChevronRight size={15} />
        {problem.title}
      </div>
      <section className="problem-workspace">
        <nav className="problem-tabs" aria-label="Problem sections">
        {[
          ["description", "Description"],
          ["submit", "Submit"],
          ["my", "My submission"],
          ["solutions", problem.kind === "csv" ? "Leaderboard" : "All Solutions"],
        ].map(([key, label]) => (
          <button key={key} className={activeTab === key ? "active" : ""} onClick={() => { setActiveTab(key); setError(""); }}>
            {label}
          </button>
        ))}
        </nav>
        <div className="problem-workspace-body">
          <div className="problem-head">
        <div>
          <h1>{problem.title}</h1>
          <div className="meta">
            <Pill>{problem.category}</Pill>
            <span className="type-label">
              {problem.kind === "csv" ? "AI Track" : "Function Only"}
            </span>
          </div>
        </div>
          </div>

      {activeTab === "description" && (
        <article className="description problem-description">
          <div className="problem-description-title">Description</div>
          <div className="panel-body">
            <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{problem.description}</ReactMarkdown></div>
            {problem.kind === "code" ? (
              <>
                <h3>Submission format</h3>
                <p>
                  Implement the required Python function or class. The server
                  evaluates your code against private test cases.
                </p>
                <h3>Sample test case</h3>
                <div className="sample-io">
                  <strong>Input</strong>
                  <pre>{(problem.sample_tests[0]?.args || []).map(plainValue).join("\n") || "(no arguments)"}</pre>
                  <strong>Expected output</strong>
                  <pre>{plainValue(problem.sample_tests[0]?.expected)}</pre>
                  <a className="btn ghost small" href={`/api/problems/${encodeURIComponent(slug)}/sample-input.txt`} download>Download sample input (.txt)</a>
                </div>
              </>
            ) : (
              <>
                <h3>Submission format</h3>
                <p>
                  Upload a CSV file with the required columns. The scoring
                  service validates structure, alignment, and metric.
                </p>
                <p>
                  Scoring metric: <b>{problem.metric}</b>
                </p>
                <section className="competition-data" aria-labelledby="competition-data-title">
                  <div className="competition-data-head">
                    <div>
                      <span className="competition-data-icon"><Database size={20} /></span>
                      <div><h3 id="competition-data-title">Competition data</h3><p>Train a model, predict the test rows, then follow the sample submission schema.</p></div>
                    </div>
                  </div>
                  {dataFiles.length ? (
                    <div className="competition-file-list">
                      {dataFiles.map((item) => (
                        <a key={item.key} className="competition-file" href={`/api/problems/${encodeURIComponent(slug)}/data/${encodeURIComponent(item.key)}`} download>
                          <FileSpreadsheet size={20} />
                          <span><b>{item.label}</b><small>{item.name} · {formatBytes(item.size)}</small></span>
                          <Download size={17} />
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="competition-data-empty">No public dataset files have been attached to this challenge yet.</p>
                  )}
                </section>
              </>
            )}
          </div>
        </article>
      )}

      {activeTab === "submit" && (
        <article className="panel editor-panel problem-submit-panel">
          {problem.kind === "csv" && (
            <div className="panel-head">
              <Upload size={19} /> Prediction upload
              <span className="editor-badge">CSV</span>
            </div>
          )}
          {problem.kind === "code" ? (
            <div className="code-editor-shell">
              <div className="code-editor-toolbar">
                <span><Code2 size={15} /> Source Code</span>
                <div className="code-toolbar-actions">
                  <span className="code-language">Python 3</span>
                  <button className="editor-reset" type="button" onClick={resetCode}>Reset template</button>
                </div>
              </div>
              <div className="monaco-code"><MonacoEditor height="600px" language="python" theme="itclub-python" beforeMount={configureProblemEditor} value={code} onChange={updateCode} options={{minimap:{enabled:false},overviewRulerLanes:0,hideCursorInOverviewRuler:true,fontSize:14,automaticLayout:true,scrollBeyondLastLine:false,tabSize:4,wordWrap:"on",bracketPairColorization:{enabled:true},guides:{bracketPairs:true,indentation:true},semanticHighlighting:{enabled:true}}} /></div>
            </div>
          ) : (
            <div className="upload-area">
              <Upload size={40} />
              <h3>Upload prediction file</h3>
              <p>Choose a .csv file (up to 10 MB)</p>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              {file && <span className="file-name">{file.name}</span>}
            </div>
          )}
          <div className="editor-bottom">
            {!user ? (
              <Link className="btn primary" to="/login">
                Sign in to submit
              </Link>
            ) : (
              <button
                onClick={send}
                disabled={submitting}
                className="btn primary"
              >
                <Play size={17} />
                {submitting ? "Submitting..." : "Submit for grading"}
              </button>
            )}
          </div>
          {job && (
            <div className="submission-queued success-msg">
              Submission queued. Your draft is still saved.
              <Link to={`/submissions/${job}`}>View live result <ChevronRight size={15} /></Link>
            </div>
          )}
          {error && <p className="error-msg pad">{error}</p>}
        </article>
      )}

      {activeTab === "my" && (
        <section className="panel problem-submissions-panel">
          <div className="panel-head"><Activity size={18} /> My submissions</div>
          {!user ? (
            <div className="empty"><p>Sign in to view your submissions for this challenge.</p><Link className="btn primary small" to="/login">Sign in</Link></div>
          ) : tabLoading ? <p className="empty">Loading submissions...</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Status</th><th>Result</th><th>Score</th><th>Submitted</th><th></th></tr></thead>
                <tbody>{mySubmissions.map((submission) => (
                  <tr key={submission.id}>
                    <td><span className={`status ${submission.status}`}>{submission.status}</span></td>
                    <td>{submission.passed}/{submission.total}</td>
                    <td>{submission.score == null ? "—" : Number(submission.score).toFixed(4)}</td>
                    <td>{new Date(submission.created_at).toLocaleString()}</td>
                    <td><Link to={`/submissions/${submission.id}`}>Details <ChevronRight size={15} /></Link></td>
                  </tr>
                ))}</tbody>
              </table>
              {!mySubmissions.length && <p className="empty">You have not submitted this challenge yet.</p>}
            </div>
          )}
        </section>
      )}

      {activeTab === "solutions" && (
        <section className="panel solutions-table-panel">
          <div className="solutions-toolbar">
            <div>
              <h3>{problem.kind === "csv" ? "Challenge leaderboard" : "All submissions"}</h3>
              <p>{problem.kind === "csv"
                ? `${metricLabel(leaderboard?.metric || problem.metric)} · ${leaderboard?.greater_is_better ? "Higher is better" : "Lower is better"}`
                : "Submission history from club members."}</p>
            </div>
            <label className="solutions-search">
              <Search size={16} />
              <input value={solutionSearch} onChange={(event) => setSolutionSearch(event.target.value)} placeholder={problem.kind === "csv" ? "Search participant..." : "Search user or status..."} />
            </label>
          </div>
          {tabLoading ? <p className="empty">Loading submissions...</p> : (
            problem.kind === "csv" ? (
              <>
                {!!visibleLeaderboard.length && (
                  <div className="challenge-podium">
                    {visibleLeaderboard.slice(0, 3).map((entry) => (
                      <Link key={entry.best_submission_id} className={`challenge-podium-card challenge-place-${entry.rank}`} to={`/profile/${encodeURIComponent(entry.username)}`}>
                        <span className="challenge-medal">{entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : "🥉"}</span>
                        <UserAvatar user={entry} className="challenge-podium-avatar" />
                        <b>{entry.username}</b>
                        <strong title={String(entry.score)}>{metricScore(entry.score)}</strong>
                      </Link>
                    ))}
                  </div>
                )}
                <div className="table-wrap">
                  <table className="solutions-table challenge-leaderboard-table">
                    <thead><tr><th>Rank</th><th>Participant</th><th>Best score</th><th>Attempts</th><th>Achieved at</th></tr></thead>
                    <tbody>{visibleLeaderboard.map((entry) => (
                      <tr key={entry.best_submission_id} className={entry.username === user?.username ? "current-participant" : ""}>
                        <td className="leaderboard-rank">#{entry.rank}</td>
                        <td><Link className="solution-user" to={`/profile/${encodeURIComponent(entry.username)}`}><UserAvatar user={entry} className="solution-avatar" /><b>{entry.username}</b>{entry.username === user?.username && <span className="you-badge">You</span>}</Link></td>
                        <td><b title={String(entry.score)}>{metricScore(entry.score)}</b> <small>{metricLabel(leaderboard?.metric)}</small></td>
                        <td>{entry.attempts}</td>
                        <td>{new Date(entry.achieved_at).toLocaleString()}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                  {!visibleLeaderboard.length && <p className="empty">The leaderboard will appear after the first accepted CSV submission.</p>}
                </div>
              </>
            ) : (
              <div className="table-wrap">
                <table className="solutions-table">
                  <thead><tr><th>#</th><th>User</th><th>Judge status</th><th>Score</th><th>Language</th><th>Submitted at</th></tr></thead>
                  <tbody>{visibleSolutions.map((solution) => (
                    <tr key={solution.id}>
                      <td className="solution-id">#{String(solution.id).slice(0, 8)}</td>
                      <td><Link className="solution-user" to={`/profile/${encodeURIComponent(solution.username)}`}><UserAvatar user={solution} className="solution-avatar" /><b>{solution.username}</b></Link></td>
                      <td><span className={`status ${solution.status}`}>{solution.status.replaceAll("_", " ")}</span></td>
                      <td><b>{submissionScore(solution)}</b></td>
                      <td>Python</td>
                      <td>{new Date(solution.created_at).toLocaleString()}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {!visibleSolutions.length && <p className="empty">No member submissions found.</p>}
              </div>
            )
          )}
          {error && <p className="error-msg">{error}</p>}
        </section>
      )}
        </div>
      </section>
    </div>
  );
}
function useSubmission(id, user) {
  const [sub, setSub] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!user) return;
    let running = true;
    const load = () =>
      request("/submissions/" + id)
        .then((d) => {
          if (running) setSub(d.submission);
        })
        .catch((e) => {
          if (running) setError(e.message);
        });
    load();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "subscribe",
          token: localStorage.getItem("token"),
          submission_id: id,
        }),
      );
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "snapshot") setSub(m.submission);
        if (m.type === "test_completed" || m.type === "completed")
          setSub((s) => ({ ...s, ...m }));
      } catch {}
    };
    const timer = setInterval(() => {
      if (running) load();
    }, 5000);
    return () => {
      running = false;
      ws.close();
      clearInterval(timer);
    };
  }, [id, user]);
  return { sub, error };
}
function SubmissionDetail({ id, user }) {
  const { sub, error } = useSubmission(id, user);
  if (!user)
    return (
      <div className="shell page">
        <h1>Sign in to see your submission</h1>
        <Link to="/login">Login</Link>
      </div>
    );
  if (error) return <div className="shell page error-msg">{error}</div>;
  if (!sub) return <div className="shell page">Loading submission...</div>;
  const results = Array.isArray(sub.results) ? sub.results : [];
  const percent = sub.total ? Math.round((sub.passed / sub.total) * 100) : 0;
  return (
    <div className="shell page">
      <div className="crumbs">
        <Link to="/submissions">My submissions</Link>
        <ChevronRight size={15} />
        {id.slice(0, 8)}
      </div>
      <div className="page-heading">
        <span className="section-kicker">LIVE GRADING</span>
        <h1>Submission results</h1>
        <p>
          {sub.problem_slug} · {new Date(sub.created_at).toLocaleString()}
        </p>
      </div>
      <div className="result-layout">
        <div className="panel result-main">
          <div className="panel-head">
            <Activity size={19} /> Execution progress{" "}
            <span className="live-label">
              <span className="pulse" /> REAL-TIME
            </span>
          </div>
          <div className="panel-body">
            <div className="status-header">
              <span className={"status " + sub.status}>{sub.status}</span>
              <b>
                {sub.passed} / {sub.total} passed
              </b>
            </div>
            <div className="progress-track">
              <div style={{ width: percent + "%" }} />
            </div>
            <div className="test-list">
              {results.map((t, i) => (
                <div className="test-line" key={i}>
                  <span
                    className={
                      t.status === "accepted" ? "test-check" : "test-fail"
                    }
                  >
                    {t.status === "accepted" ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <span>!</span>
                    )}
                  </span>
                  <div>
                    <b>Test case {t.index + 1}</b>
                    <div className="muted text-xs">
                      {t.status.replaceAll("_", " ")}
                    </div>
                  </div>
                  {t.error && (
                    <small title={t.error}>{t.error.slice(0, 80)}</small>
                  )}
                </div>
              ))}
              {sub.status === "queued" || sub.status === "running" ? (
                <div className="test-line">
                  <span className="spinner" />
                  Waiting for remaining test cases...
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="panel result-side">
          <div className="panel-head">Score summary</div>
          <div className="panel-body">
            <span className="stat-label">Passed test cases</span>
            <div className="big-stat">
              {sub.passed}
              <span>/{sub.total}</span>
            </div>
            <div className="divider" />
            {sub.score != null && (
              <>
                <span className="stat-label">{sub.metric}</span>
                <div className="big-stat">{Number(sub.score).toFixed(5)}</div>
              </>
            )}
            {sub.error && <p className="error-msg">{sub.error}</p>}
            <Link
              className="btn primary wide"
              to={"/problems/" + sub.problem_slug}
            >
              Try again
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
function Submissions({ user }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (user)
      request("/submissions")
        .then((d) => setRows(d.submissions))
        .catch((e) => setError(e.message));
  }, [user]);
  if (!user)
    return (
      <div className="shell page">
        <h1>My submissions</h1>
        <p>You must be signed in to view your results.</p>
        <Link to="/login" className="btn primary">
          Sign in
        </Link>
      </div>
    );
  return (
    <div className="shell page">
      <div className="page-heading">
        <span className="section-kicker">YOUR PROGRESS</span>
        <h1>My submissions</h1>
        <p>Review your code attempts and CSV scores.</p>
      </div>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Problem</th>
              <th>Type</th>
              <th>Score</th>
              <th>Date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={"/submissions/" + s.id} className="problem-title">
                    {s.problem_title || s.problem_slug}
                  </Link>
                </td>
                <td>{s.problem_category || (s.kind === "csv" ? "AI Track" : "Function Only")}</td>
                <td><b>{submissionScore(s)}</b></td>
                <td>{new Date(s.created_at).toLocaleString()}</td>
                <td>
                  <Link to={"/submissions/" + s.id}>
                    <ChevronRight size={17} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="empty">
            No submissions yet. <Link to="/problems">Choose a problem</Link>
          </p>
        )}
      </div>
      {error && <div className="error-msg">{error}</div>}
    </div>
  );
}
function Ranklist() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    request("/leaderboard")
      .then((data) => setUsers(data.users || []))
      .catch((err) => setError(err.message));
  }, []);
  // The API ranks distinct solved problems first and total attempts second.
  const podiumOrder = [1, 0, 2].filter((index) => index < users.length);
  const medals = ["🥇", "🥈", "🥉"];
  const places = ["1st place", "2nd place", "3rd place"];
  return (
    <div className="shell page ranklist-page">
      {error && <p className="error-msg" role="alert">{error}</p>}
      {users.length > 0 && (
        <section className={`rank-podium rank-podium-${Math.min(users.length, 3)}`} aria-label="Top three on the leaderboard">
          {podiumOrder.map((index) => {
            const user = users[index];
            return (
              <article key={user.username} className={`rank-podium-card rank-position-${index + 1}`}>
                <div className="rank-medal" aria-hidden="true">{medals[index]}</div>
                <UserAvatar user={user} className="rank-avatar" />
                <div className="rank-place">{places[index]}</div>
                <Link className="rank-name" to={`/profile/${encodeURIComponent(user.username)}`}>{user.username}</Link>
                <div className="rank-score"><b>{user.solved}</b><span>Function Only solved</span></div>
                <div className="rank-attempts">{user.attempts} attempts</div>
                <div className="rank-stand" aria-hidden="true">{index + 1}</div>
              </article>
            );
          })}
        </section>
      )}
      <div className="panel table-wrap">
        <table>
          <thead><tr><th>Rank</th><th>User</th><th>Function Only solved</th><th>Attempts</th></tr></thead>
          <tbody>
            {users.map((user, index) => (
              <tr key={user.username} className={index < 3 ? `rank-row rank-row-${index + 1}` : undefined}>
                <td>{index < 3 ? <span className="rank-table-medal">{medals[index]} <b>#{index + 1}</b></span> : <b>#{index + 1}</b>}</td>
                <td><Link className="rank-table-user" to={`/profile/${encodeURIComponent(user.username)}`}><UserAvatar user={user} className="rank-table-avatar" /><span className="problem-title">{user.username}</span></Link></td>
                <td>{user.solved}</td>
                <td>{user.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!users.length && !error && <p className="empty">No ranked members yet.</p>}
      </div>
    </div>
  );
}
function Contests() {
  return (
    <div className="shell page">
      <div className="page-heading">
        <span className="section-kicker">COMPETITIONS</span>
        <h1>Contests</h1>
        <p>Scheduled events and competition listings will appear here.</p>
      </div>
      <div className="panel empty">
        <Trophy size={35} />
        <h3>No active contests</h3>
        <p>
          Contest scheduling and registration are not included in this release.
        </p>
        <Link to="/problems">Practice problems instead</Link>
      </div>
    </div>
  );
}
// Only administrators see this route; the API independently enforces privileges.
const defaultCsvConfig = {
  version: 1,
  id_column: "id",
  target_column: "label",
  prediction_columns: ["prediction"],
  task_type: "binary_probability",
  metric: "log_loss",
  greater_is_better: false,
  allow_extra_columns: false,
};
const competitionUploadFields = [
  { key: "train", field: "train_data", filename: "train.csv", label: "Training dataset", accept: ".csv,text/csv", help: "Public · includes features and training labels" },
  { key: "test", field: "test_data", filename: "test.csv", label: "Test dataset", accept: ".csv,text/csv", help: "Public · features that participants must predict" },
  { key: "sample_submission", field: "sample_submission", filename: "sample_submission.csv", label: "Sample submission", accept: ".csv,text/csv", help: "Public · exact schema required by the Judge" },
  { key: "bundle", field: "data_bundle", filename: "data.zip", label: "Data bundle", accept: ".zip,application/zip", help: "Public · optional archive containing competition resources" },
];
// Editable text cases are serialized to the original structured worker protocol.
const plainValue = v => typeof v === 'string' ? v : JSON.stringify(v ?? null);
const displayTests = tests => (tests || []).map(t => ({input:(t.args || []).map(plainValue).join("\n"),output:plainValue(t.expected)}));
const initialTests = [{input:"2", output:"4"}];
const emptyAdmin = {
  slug: "",
  title: "",
  category: "Python",
  difficulty: "Easy",
  kind: "code",
  description: "",
  starter: "def solve(x):\n    pass",
  function: "solve",
  class_name: "",
  tests: initialTests,
  config: JSON.stringify(defaultCsvConfig, null, 2),
};
function AdminProblems({ user }) {
  const [items, setItems] = useState([]),
    [editing, setEditing] = useState(null),
    [model, setModel] = useState(emptyAdmin),
    [truth, setTruth] = useState(null),
    [sample, setSample] = useState(null),
    [datasetUploads, setDatasetUploads] = useState({ train_data: null, test_data: null, data_bundle: null }),
    [removeFiles, setRemoveFiles] = useState([]),
    [statusFilter, setStatusFilter] = useState("all"),
    [deleteTarget, setDeleteTarget] = useState(null),
    [deleteConfirmation, setDeleteConfirmation] = useState(""),
    [datasetMaxMb, setDatasetMaxMb] = useState(100),
    [importFile, setImportFile] = useState(null),
    [importing, setImporting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const load = () =>
    request("/admin/problems")
      .then((d) => { setItems(d.problems); setDatasetMaxMb(d.dataset_max_mb || 100); })
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (user?.role === "admin") load();
  }, [user?.role]);
  const start = (problem) => {
    setEditing(problem?.slug || null);
    setTruth(null);
    setSample(null);
    setDatasetUploads({ train_data: null, test_data: null, data_bundle: null });
    setRemoveFiles([]);
    setError("");
    setSuccess("");
    setModel(
      problem
        ? {
            ...problem,
            tests: displayTests(problem.tests),
            config: JSON.stringify(problem.config || defaultCsvConfig, null, 2),
          }
        : emptyAdmin,
    );
  };
  const change = (key, value) => setModel((m) => ({ ...m, [key]: value }));
  const updateTest = (index, key, value) => setModel(m => ({ ...m, tests: m.tests.map((t,i) => i===index ? {...t,[key]:value} : t) }));
  const uploadBatch = async () => {
    if (!importFile) return;
    setError(""); setSuccess(""); setImporting(true);
    try {
      const body=new FormData(); body.set("file",importFile);
      const result=await request("/admin/problems/import-csv",{method:"POST",body});
      setSuccess(`Imported ${result.imported} exercises (${result.tests} test cases).`);
      setImportFile(null); await load();
    } catch (e) { setError(e.message) }
    finally { setImporting(false) }
  };
  const downloadTemplate = async () => {
    try {
      const token=localStorage.getItem("token");
      const response=await fetch("/api/admin/problems/import-template.csv",{headers:{Authorization:`Bearer ${token}`}});
      if(!response.ok) throw Error("Template download failed");
      const blob=await response.blob(); const url=URL.createObjectURL(blob);
      const a=document.createElement("a"); a.href=url; a.download="python-problems-template.csv"; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) { setError(e.message) }
  };
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (model.kind === "code" && (!model.tests.length || model.tests.some(t => !t.output.trim()))) throw Error("Add a test case with expected output");
      if (model.kind === "csv") JSON.parse(model.config);
      const body = new FormData();
      for (const key of [
        "slug",
        "title",
        "category",
        "difficulty",
        "kind",
        "description",
        "starter",
        "function",
        "class_name",
        "config",
      ])
        body.set(key, model[key] || "");
      if (model.kind === "code") body.set("tests", JSON.stringify(model.tests));
      if (truth) body.set("ground_truth", truth);
      if (sample) body.set("sample_submission", sample);
      for (const [key, file] of Object.entries(datasetUploads)) if (file) body.set(key, file);
      for (const key of removeFiles) body.set(`remove_${key}`, "true");
      await request(
        "/admin/problems" + (editing ? "/" + encodeURIComponent(editing) : ""),
        { method: editing ? "PUT" : "POST", body },
      );
      setSuccess(
        editing
          ? "Exercise updated successfully."
          : "Exercise created successfully.",
      );
      setEditing(null);
      setModel(emptyAdmin);
      setTruth(null);
      setSample(null);
      setDatasetUploads({ train_data: null, test_data: null, data_bundle: null });
      setRemoveFiles([]);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const archive = async (slug) => {
    if (
      !window.confirm(
        `Archive ${slug}? Existing submissions will be preserved.`,
      )
    )
      return;
    setError("");
    setSuccess("");
    try {
      await request("/admin/problems/" + encodeURIComponent(slug), {
        method: "DELETE",
      });
      setSuccess("Exercise archived");
      await load();
    } catch (e) {
      setError(e.message);
    }
  };
  const unarchive = async (slug) => {
    setError(""); setSuccess("");
    try {
      await request(`/admin/problems/${encodeURIComponent(slug)}/unarchive`, { method: "POST" });
      setSuccess("Exercise restored to AI Arena");
      await load();
    } catch (e) { setError(e.message); }
  };
  const openPermanentDelete = (problem) => {
    setDeleteTarget(problem);
    setDeleteConfirmation("");
    setError("");
  };
  const permanentlyDelete = async () => {
    if (!deleteTarget || deleteConfirmation !== deleteTarget.slug) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = await request(`/admin/problems/${encodeURIComponent(deleteTarget.slug)}/permanent`, {
        method: "DELETE",
        body: JSON.stringify({ confirm_slug: deleteConfirmation }),
      });
      setSuccess(`Exercise deleted with ${result.deleted_submissions} submission(s).`);
      if (editing === deleteTarget.slug) start(null);
      setDeleteTarget(null); setDeleteConfirmation("");
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const toggleRemoval = (key) => setRemoveFiles((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const visibleItems = items.filter((problem) => statusFilter === "all" || (statusFilter === "active" ? problem.active : !problem.active));
  if (!user)
    return (
      <div className="shell page">
        <h1>Administrator sign-in required</h1>
        <Link to="/login" className="btn primary">
          Login
        </Link>
      </div>
    );
  if (user.role !== "admin")
    return (
      <div className="shell page">
        <h1>Access restricted</h1>
        <p>Only administrators can create and manage exam exercises.</p>
      </div>
    );
  return (
    <div className="shell page admin-page">
      <div className="page-heading">
        <span className="section-kicker">ADMINISTRATION</span>
        <h1>Exercise management</h1>
        <p>
          Create and update Python coding exercises or CSV-based AI assessments.
        </p>
      </div>
      {error && <p className="error-msg">{error}</p>}
      {success && <p className="admin-success">{success}</p>}
      <section className="panel admin-csv-examples" aria-label="CSV examples for problem authors">
        <div className="panel-head"><FileSpreadsheet size={18} /> Example CSV inputs and outputs</div>
        <div className="admin-csv-examples-body">
          <p>Download and edit these files when adding exercises. For Python problems, each CSV row defines a test input and expected output. For AI grading, keep ground truth private and give students only the sample prediction format.</p>
          <div className="admin-template-grid">
            <a className="admin-template-link" href="/templates/python-problem-tests.csv" download>
              <b>Python problem input/output</b><small>Multiple test cases with function signatures</small><span>Download CSV</span>
            </a>
            <a className="admin-template-link" href="/templates/ai-ground-truth-example.csv" download>
              <b>AI ground truth</b><small>Private example target values</small><span>Download CSV</span>
            </a>
            <a className="admin-template-link" href="/templates/ai-predictions-example.csv" download>
              <b>AI sample predictions</b><small>Example expected submission columns</small><span>Download CSV</span>
            </a>
          </div>
          <div className="admin-template-preview">
            <strong>Python test case preview</strong>
            <div className="table-wrap"><table>
              <thead><tr><th>Problem slug</th><th>Input</th><th>Output</th></tr></thead>
              <tbody>
                <tr><td>sum-pair</td><td><code>2, 5</code></td><td><code>7</code></td></tr>
                <tr><td>sum-pair</td><td><code>10, -3</code></td><td><code>7</code></td></tr>
              </tbody>
            </table></div>
            <small>The downloaded CSV uses a newline between positional arguments inside quoted input cells.</small>
          </div>
        </div>
      </section>
      <section className="panel bulk-import">
        <div className="panel-head"><Upload size={18}/> Bulk import Python exercises (CSV)</div>
        <div className="bulk-import-body">
          <p>Import many exercises at once. Repeat the slug in multiple rows to add test cases.</p>
          <button type="button" className="btn ghost small" onClick={downloadTemplate}>Download CSV template</button>
          <input aria-label="Python problems CSV" type="file" accept=".csv,text/csv" onChange={e => setImportFile(e.target.files?.[0] || null)}/>
          <button type="button" className="btn primary small" disabled={!importFile || importing} onClick={uploadBatch}>{importing ? "Importing..." : "Import exercises"}</button>
        </div>
      </section>
      <div className="admin-layout">
        <section className="panel">
          <div className="panel-head">
            <Layers3 size={18} /> Published exercises{" "}
            <span className="editor-badge">
              {items.filter((p) => p.active).length} active
            </span>
          </div>
          <div className="admin-status-filters" role="group" aria-label="Filter exercises by status">
            {[['all','All'],['active','Active'],['archived','Archived']].map(([key,label]) => (
              <button key={key} type="button" className={statusFilter === key ? "active" : ""} onClick={() => setStatusFilter(key)}>{label}</button>
            ))}
          </div>
          <div className="admin-list">
            {visibleItems.map((p) => (
              <div key={p.slug} className={`admin-item${p.active ? "" : " archived"}`}>
                <div>
                  <b>{p.title} {!p.active && <span className="archived-badge">Archived</span>}</b>
                  <small>
                    {p.slug} ·{" "}
                    {p.kind === "csv" ? "CSV scoring" : "Python tests"} ·{" "}
                    {p.deletion_preview?.submissions || 0} submissions
                  </small>
                </div>
                <div className="admin-actions">
                  <button className="btn ghost small" onClick={() => start(p)}>
                    Edit
                  </button>
                  {p.active && (
                    <button
                      className="btn ghost small"
                      onClick={() => archive(p.slug)}
                    >
                      Archive
                    </button>
                  )}
                  {!p.active && (
                    <>
                      <button className="btn ghost small" onClick={() => unarchive(p.slug)}><ArchiveRestore size={14} /> Unarchive</button>
                      <button className="btn danger small" onClick={() => openPermanentDelete(p)}><Trash2 size={14} /> Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!visibleItems.length && <p className="empty">No exercises match this filter.</p>}
          </div>
          <div className="admin-list-foot">
            <button className="btn primary small" onClick={() => start(null)}>
              Create new exercise
            </button>
          </div>
        </section>
        <section className="panel admin-editor">
          <div className="panel-head">
            <Code2 size={18} />
            {editing ? "Edit exercise" : "Create exercise"}
          </div>
          <form onSubmit={save} className="admin-form">
            <div className="admin-two">
              <label>
                Slug
                <input
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  value={model.slug}
                  disabled={!!editing}
                  onChange={(e) => change("slug", e.target.value)}
                  placeholder="vector-add"
                />
              </label>
              <label>
                Exercise title
                <input
                  required
                  value={model.title}
                  onChange={(e) => change("title", e.target.value)}
                  placeholder="Vector Addition"
                />
              </label>
            </div>
            <div className="admin-two">
              <label>
                Category
                <input
                  required
                  value={model.category}
                  onChange={(e) => change("category", e.target.value)}
                />
              </label>
              <label>
                Difficulty
                <select
                  value={model.difficulty}
                  onChange={(e) => change("difficulty", e.target.value)}
                >
                  {["Easy", "Medium", "Hard"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Exercise type
              <select
                disabled={!!editing}
                value={model.kind}
                onChange={(e) => change("kind", e.target.value)}
              >
                <option value="code">Python code</option>
                <option value="csv">CSV / AI grading</option>
              </select>
            </label>
            <label>
              Description (Markdown .md)
              <textarea
                required
                rows="5"
                value={model.description}
                onChange={(e) => change("description", e.target.value)}
                placeholder="## Problem\nExplain the task, constraints and examples using Markdown."
              />
            </label>
            {model.kind === "code" ? (
              <>
                <div className="admin-two">
                  <label>
                    Function name
                    <input
                      required
                      value={model.function || ""}
                      onChange={(e) => change("function", e.target.value)}
                      placeholder="solve"
                    />
                  </label>
                  <label>
                    Class name (optional)
                    <input
                      value={model.class_name || ""}
                      onChange={(e) => change("class_name", e.target.value)}
                      placeholder="Solution"
                    />
                  </label>
                </div>
                <label>
                  Starter signature (students see only this signature)
                  <div className="admin-monaco"><MonacoEditor height="230px" language="python" theme="vs-dark" value={model.starter || ""} onChange={value => change("starter",value ?? "")} options={{minimap:{enabled:false},fontSize:13,automaticLayout:true,scrollBeyondLastLine:false}} /></div>
                  <small>The public API strips implementation bodies and exposes only the callable signature with pass.</small>
                </label>
                <div className="admin-test-header"><h3>Input / output test cases</h3><small>One positional argument per nonempty input line; the first case is the public sample.</small></div>
                {model.tests.map((test,index) => <div className="admin-test" key={index}>
                  <div className="admin-test-title"><b>Test {index+1} {index===0?"(sample)":"(hidden)"}</b><button type="button" className="btn ghost small" disabled={model.tests.length===1} onClick={() => change("tests", model.tests.filter((_,i)=>i!==index))}>Remove</button></div>
                  <div className="admin-two"><label>Input (one argument per line)<textarea rows="5" spellCheck={false} value={test.input} onChange={e => updateTest(index,"input",e.target.value)} placeholder={'[2, 7, 11, 15]\n9'}/></label><label>Expected output<textarea required rows="5" spellCheck={false} value={test.output} onChange={e => updateTest(index,"output",e.target.value)} placeholder="[0, 1]"/></label></div>
                </div>)}
                <button type="button" className="btn ghost small" onClick={() => change("tests",[...model.tests,{input:"",output:""}])}>+ Add test case</button>
              </>
            ) : (
              <>
                <label>
                  Scoring configuration (JSON)
                  <textarea
                    className="admin-code"
                    rows="12"
                    required
                    value={model.config || ""}
                    onChange={(e) => change("config", e.target.value)}
                  />
                  <small>
                    Example metrics: log_loss, accuracy, rmse, micro_f1,
                    ndcg_at_k, sacrebleu. Column names must match CSV headers.
                  </small>
                </label>
                <label>
                  Ground truth CSV{" "}
                  {editing
                    ? "(required for first edit of bundled problem)"
                    : "(required)"}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    required={!editing}
                    onChange={(e) => setTruth(e.target.files?.[0] || null)}
                  />
                  <small>Private · used only by CSV Judge and never exposed by a download API.</small>
                </label>
                <div className="competition-upload-editor">
                  <div className="admin-test-header"><h3>Competition data</h3><small>Public files shown on the challenge page. Maximum combined challenge size: {datasetMaxMb} MB.</small></div>
                  {competitionUploadFields.map((definition) => {
                    const existing = model.data_files?.find((file) => file.name === definition.filename);
                    const selected = definition.field === "sample_submission" ? sample : datasetUploads[definition.field];
                    const markedForRemoval = removeFiles.includes(definition.key);
                    return (
                      <div className={`competition-upload-row${markedForRemoval ? " removing" : ""}`} key={definition.key}>
                        <div><b>{definition.label}</b><small>{definition.help}</small>{existing && <span>{existing.name} · {formatBytes(existing.size)}</span>}</div>
                        <input type="file" accept={definition.accept} onChange={(event) => {
                          const next = event.target.files?.[0] || null;
                          if (definition.field === "sample_submission") setSample(next);
                          else setDatasetUploads((current) => ({ ...current, [definition.field]: next }));
                          if (next) setRemoveFiles((current) => current.filter((key) => key !== definition.key));
                        }} />
                        {selected && <small className="selected-file">Selected: {selected.name}</small>}
                        {editing && existing && (
                          <label className="remove-file-toggle"><input type="checkbox" checked={markedForRemoval} disabled={Boolean(selected)} onChange={() => toggleRemoval(definition.key)} /> Remove existing file</label>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <div className="admin-submit">
              <button
                type="button"
                className="btn ghost"
                onClick={() => start(null)}
              >
                Reset
              </button>
              <button className="btn primary" disabled={busy} type="submit">
                {busy
                  ? "Saving..."
                  : editing
                    ? "Update exercise"
                    : "Publish exercise"}
              </button>
            </div>
          </form>
        </section>
      </div>
      {deleteTarget && (
        <div className="confirm-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(null); }}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-problem-title">
            <span className="confirm-danger-icon"><Trash2 size={24} /></span>
            <h2 id="delete-problem-title">Delete exercise permanently?</h2>
            <p>This cannot be undone. The exercise, all submission history and its stored CSV files will be removed.</p>
            <div className="delete-impact">
              <span><b>{deleteTarget.deletion_preview?.submissions || 0}</b> submissions</span>
              <span><b>{deleteTarget.deletion_preview?.files || 0}</b> stored files</span>
              <span><b>{formatBytes(deleteTarget.deletion_preview?.bytes || 0)}</b> data</span>
            </div>
            <label>Type <code>{deleteTarget.slug}</code> to confirm<input autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label>
            <div className="confirm-actions"><button className="btn ghost" type="button" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</button><button className="btn danger" type="button" disabled={busy || deleteConfirmation !== deleteTarget.slug} onClick={permanentlyDelete}>{busy ? "Deleting..." : "Delete permanently"}</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
