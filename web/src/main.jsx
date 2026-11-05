import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
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
  ChevronRight,
  Terminal,
  Search,
  Menu,
  BrainCircuit,
  UserRound,
  ChevronDown,
  FileSpreadsheet,
  Activity,
} from "lucide-react";
import MonacoEditor from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";
const API = "/api";
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
function App() {
  const [user, setUser] = useState(
    JSON.parse(localStorage.getItem("user") || "null"),
  );
  const [route, setRoute] = useState(location.pathname);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    const cb = () => setRoute(location.pathname);
    window.addEventListener("popstate", cb);
    return () => window.removeEventListener("popstate", cb);
  }, []);
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
            <span className="brand-sub">JUDGE</span>
          </Link>
          <button className="mobile-toggle" onClick={() => setDrawer(!drawer)}>
            <Menu size={22} />
          </button>
          <nav
            className={drawer ? "nav open" : "nav"}
            onClick={() => setDrawer(false)}
          >
            <Link to="/" className={route === "/" ? "home-nav-link active" : "home-nav-link"}>
              <House size={16} /> Home
            </Link>
            <Link to="/problems">
              <Layers3 size={16} /> Problems
            </Link>
            <Link to="/contests">
              <Trophy size={16} /> Contests
            </Link>
            <Link to="/ranklist">
              <ChartNoAxesCombined size={16} /> Ranklist
            </Link>
            <Link to="/submissions">
              <Activity size={16} /> My submissions
            </Link>
            {user?.role === "admin" && (
              <Link to="/admin/problems">
                <ShieldCheck size={16} /> Admin
              </Link>
            )}
          </nav>
          <div className="account">
            {user ? (
              <>
                <span className="username">
                  <UserRound size={17} />
                  {user.username}
                </span>
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
            <span className="eyebrow">
              <span className="pulse" /> IT CLUB · AI LEARNING PLATFORM
            </span>
            <h1>
              Build solutions.
              <br />
              <span>Prove your thinking.</span>
            </h1>
            <p>
              Practice algorithms, NumPy, PyTorch, and machine learning
              challenges. Submit your solutions and follow each test case live
              as it is evaluated.
            </p>
            <div className="actions">
              <Link className="btn bright" to="/problems">
                Explore problems <ChevronRight size={17} />
              </Link>
              <Link className="btn outline-light" to="/ranklist">
                View leaderboard
              </Link>
            </div>
            <div className="hero-points">
              <span>
                <ShieldCheck size={17} /> Isolated evaluation
              </span>
              <span>
                <Activity size={17} /> Real-time results
              </span>
              <span>
                <BrainCircuit size={17} /> AI challenges
              </span>
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
      <section className="shell">
        <div className="section-head">
          <div>
            <span className="section-kicker">GET STARTED</span>
            <h2>Choose your challenge</h2>
            <p>
              One platform for coding exercises and data science assessments.
            </p>
          </div>
        </div>
        <div className="feature-grid">
          <Link to="/problems" className="feature">
            <span className="feature-icon">
              <Code2 />
            </span>
            <h3>Algorithmic problems</h3>
            <p>
              Write Python functions and validate against hidden test cases in
              an isolated runtime.
            </p>
            <span className="feature-link">
              Browse tasks <ChevronRight size={16} />
            </span>
          </Link>
          <Link to="/problems" className="feature">
            <span className="feature-icon">
              <BrainCircuit />
            </span>
            <h3>Machine learning</h3>
            <p>
              Practice with NumPy and PyTorch in AI-focused coding challenges.
            </p>
            <span className="feature-link">
              Explore AI <ChevronRight size={16} />
            </span>
          </Link>
          <Link to="/problems" className="feature">
            <span className="feature-icon">
              <FileSpreadsheet />
            </span>
            <h3>CSV competitions</h3>
            <p>
              Upload predictions and get scores from classification, ranking,
              and regression metrics.
            </p>
            <span className="feature-link">
              Upload predictions <ChevronRight size={16} />
            </span>
          </Link>
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
      nav("/problems");
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
function Problems() {
  const { items, error } = useProblems();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const shown = items.filter(
    (p) =>
      (filter === "all" || p.kind === filter) &&
      (p.title + " " + p.category).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="shell page">
      <div className="page-heading">
        <span className="section-kicker">CHALLENGE LIBRARY</span>
        <h1>Problem set</h1>
        <p>
          Explore programming and AI tasks. Select a challenge to start grading.
        </p>
      </div>
      <div className="panel">
        <div className="filters">
          <div className="search">
            <Search size={17} />
            <input
              placeholder="Search problems..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="tabs">
            {[
              ["all", "All problems"],
              ["code", "Code judge"],
              ["csv", "CSV judge"],
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
        {error && <p className="error-msg">{error}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Problem</th>
                <th>Category</th>
                <th>Type</th>
                <th>Difficulty</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={p.slug}>
                  <td className="muted">{String(i + 1).padStart(2, "0")}</td>
                  <td>
                    <Link className="problem-title" to={"/problems/" + p.slug}>
                      {p.title}
                    </Link>
                    <div className="muted text-xs">{p.slug}</div>
                  </td>
                  <td>
                    <Pill>{p.category}</Pill>
                  </td>
                  <td>
                    <span className="type-label">
                      {p.kind === "csv" ? "CSV" : "Function only"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={"difficulty " + p.difficulty.toLowerCase()}
                    >
                      {p.difficulty}
                    </span>
                  </td>
                  <td>
                    <Link to={"/problems/" + p.slug}>
                      <ChevronRight size={18} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-footer">Showing {shown.length} problems</div>
      </div>
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
  const navigate = useNavigate();
  useEffect(() => {
    request("/problems/" + slug)
      .then((d) => {
        setProblem(d.problem);
        setCode(d.problem.starter || "");
      })
      .catch((e) => setError(e.message));
  }, [slug]);
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
      navigate("/submissions/" + data.id);
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
    <div className="shell page">
      <div className="crumbs">
        <Link to="/problems">Problems</Link>
        <ChevronRight size={15} />
        {problem.title}
      </div>
      <div className="problem-head">
        <div>
          <h1>{problem.title}</h1>
          <div className="meta">
            <Pill>{problem.category}</Pill>
            <span className={"difficulty " + problem.difficulty.toLowerCase()}>
              {problem.difficulty}
            </span>
            <span className="type-label">
              {problem.kind === "csv" ? "CSV prediction" : "Python function"}
            </span>
          </div>
        </div>
      </div>
      <div className="solve-grid">
        <article className="panel description">
          <div className="panel-head">
            <Layers3 size={19} /> Problem description
          </div>
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
                <a className="btn ghost small" href={`/api/problems/${encodeURIComponent(slug)}/sample-submission.csv`} download>Download sample CSV</a>
              </>
            )}
          </div>
        </article>
        <article className="panel editor-panel">
          <div className="panel-head">
            <Code2 size={19} />{" "}
            {problem.kind === "code" ? "Solution editor" : "Prediction upload"}
            <span className="editor-badge">
              {problem.kind === "code" ? "Python 3" : "CSV"}
            </span>
          </div>
          {problem.kind === "code" ? (
            <div className="monaco-code"><MonacoEditor height="430px" language="python" theme="vs-dark" value={code} onChange={value => setCode(value ?? "")} options={{minimap:{enabled:false},fontSize:14,automaticLayout:true,scrollBeyondLastLine:false,tabSize:4,wordWrap:"on"}} /></div>
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
          {error && <p className="error-msg pad">{error}</p>}
        </article>
      </div>
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
              <th>Status</th>
              <th>Passed</th>
              <th>Date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={"/submissions/" + s.id} className="problem-title">
                    {s.problem_slug}
                  </Link>
                </td>
                <td>{s.kind}</td>
                <td>
                  <span className={"status " + s.status}>{s.status}</span>
                </td>
                <td>
                  {s.passed}/{s.total}
                </td>
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
  // The API determines rank and tie-breaks; only change the visual presentation.
  const podiumOrder = [1, 0, 2].filter((index) => index < users.length);
  const medals = ["🥇", "🥈", "🥉"];
  const places = ["1st place", "2nd place", "3rd place"];
  return (
    <div className="shell page ranklist-page">
      <div className="page-heading">
        <span className="section-kicker">COMMUNITY</span>
        <h1>Ranklist</h1>
        <p>Members ranked by accepted solutions.</p>
      </div>
      {error && <p className="error-msg" role="alert">{error}</p>}
      {users.length > 0 && (
        <section className="rank-podium" aria-label="Top three on the leaderboard">
          {podiumOrder.map((index) => {
            const user = users[index];
            return (
              <article key={user.username} className={`rank-podium-card rank-position-${index + 1}`}>
                <div className="rank-medal" aria-hidden="true">{medals[index]}</div>
                <div className="rank-avatar" aria-hidden="true">
                  {(user.username || "?").slice(0, 2).toUpperCase()}
                </div>
                <div className="rank-place">{places[index]}</div>
                <strong className="rank-name">{user.username}</strong>
                <div className="rank-score"><b>{user.accepted}</b><span>accepted</span></div>
                <div className="rank-attempts">{user.attempts} attempts</div>
                <div className="rank-stand" aria-hidden="true">{index + 1}</div>
              </article>
            );
          })}
        </section>
      )}
      <div className="panel table-wrap">
        <table>
          <thead><tr><th>Rank</th><th>User</th><th>Accepted submissions</th><th>Attempts</th></tr></thead>
          <tbody>
            {users.map((user, index) => (
              <tr key={user.username} className={index < 3 ? `rank-row rank-row-${index + 1}` : undefined}>
                <td>{index < 3 ? <span className="rank-table-medal">{medals[index]} <b>#{index + 1}</b></span> : <b>#{index + 1}</b>}</td>
                <td><span className="problem-title">{user.username}</span></td>
                <td>{user.accepted}</td>
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
    [importFile, setImportFile] = useState(null),
    [importing, setImporting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const load = () =>
    request("/admin/problems")
      .then((d) => setItems(d.problems))
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (user?.role === "admin") load();
  }, [user?.role]);
  const start = (problem) => {
    setEditing(problem?.slug || null);
    setTruth(null);
    setSample(null);
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
          <div className="admin-list">
            {items.map((p) => (
              <div key={p.slug} className="admin-item">
                <div>
                  <b>{p.title}</b>
                  <small>
                    {p.slug} ·{" "}
                    {p.kind === "csv" ? "CSV scoring" : "Python tests"} ·{" "}
                    {p.active ? "Active" : "Archived"}
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
                </div>
              </div>
            ))}
            {!items.length && <p className="empty">No exercises yet</p>}
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
                </label>
                <label>
                  Sample submission CSV (optional)
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => setSample(e.target.files?.[0] || null)}
                  />
                </label>
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
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
