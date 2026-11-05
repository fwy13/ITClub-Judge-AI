use anyhow::{Context, Result};
use axum::{extract::{DefaultBodyLimit, State}, http::StatusCode, routing::{get,post}, Json,Router};
use crate::{DirectoryRule, EnvRule, IsolateSandbox, ResourceLimits};
use crate::protocol::{SubmitRequest,SubmitResponse,TestResult};
use serde_json::{json,Value};
use std::{collections::VecDeque,env,os::unix::fs::PermissionsExt,path::Path,sync::{Arc,Mutex},time::Duration};
use tokio::sync::Semaphore;

const RUNNER: &str=include_str!("runner.py");
struct StateData { limit:Arc<Semaphore>, slots:Arc<Mutex<VecDeque<u32>>>, python:String, cgroups:bool }
struct Slot { id:u32, slots:Arc<Mutex<VecDeque<u32>>> }
impl Drop for Slot { fn drop(&mut self){self.slots.lock().unwrap().push_back(self.id);} }

pub async fn run()->Result<()> {
    let concurrency=env::var("WORKER_CONCURRENCY").ok().and_then(|x|x.parse::<usize>().ok()).unwrap_or(2).clamp(1,32);
    let base=env::var("ISOLATE_BOX_START").ok().and_then(|x|x.parse::<u32>().ok()).unwrap_or(0);
    anyhow::ensure!(base <= 1000-concurrency as u32, "ISOLATE_BOX_START out of range");
    let state=Arc::new(StateData {
        limit:Arc::new(Semaphore::new(concurrency)),
        slots:Arc::new(Mutex::new((base..base+concurrency as u32).collect())),
        python:env::var("PYTHON_BIN").unwrap_or_else(|_| {
            if Path::new("/opt/venv/bin/python").exists() { "/opt/venv/bin/python".into() }
            else { "/usr/bin/python3".into() }
        }),
        cgroups:env::var("USE_CGROUPS").unwrap_or_else(|_|"true".into())=="true",
    });
    let app=Router::new().route("/health",get(||async{Json(json!({"status":"ok"}))}))
        .route("/internal/execute",post(execute)).layer(DefaultBodyLimit::max(1024*1024)).with_state(state);
    let address=env::var("WORKER_BIND").unwrap_or_else(|_|"0.0.0.0:3001".into());
    tracing::info!(%address,"worker listening");
    axum::serve(tokio::net::TcpListener::bind(address).await?,app).await?;
    Ok(())
}
async fn execute(State(state):State<Arc<StateData>>,Json(req):Json<SubmitRequest>)->Result<Json<SubmitResponse>,(StatusCode,Json<Value>)> {
    // Internal endpoint must not be exposed publicly. Validate again, independently of gateway.
    if req.code.len()>200_000 || req.tests.is_empty() || req.tests.len()>50 || req.code.trim().is_empty()
       || !identifier(&req.function) || req.class_name.as_deref().is_some_and(|s|!identifier(s))
       || req.time_limit_ms.is_some_and(|x|!(100..=30_000).contains(&x))
       || req.memory_limit_mb.is_some_and(|x|!(128..=8192).contains(&x)) {
        return Err((StatusCode::BAD_REQUEST,Json(json!({"error":"invalid submission"}))));
    }
    let _permit=state.limit.clone().acquire_owned().await.map_err(internal)?;
    let id=state.slots.lock().unwrap().pop_front().ok_or_else(||internal("no slot"))?;
    let slot=Slot{id,slots:state.slots.clone()};
    let result=run_job(&state,&req,slot.id).await;
    drop(slot);
    match result {
        Ok(res)=>Ok(Json(res)),
        Err(e)=>{tracing::error!(error=%format!("{e:#}"),"worker failed");Err(internal("sandbox execution failed; check worker logs"))}
    }
}
fn identifier(s:&str)->bool{let mut it=s.chars();it.next().is_some_and(|x|x=='_'||x.is_ascii_alphabetic())&&it.all(|x|x=='_'||x.is_ascii_alphanumeric())}
fn internal<E:std::fmt::Display>(_e:E)->(StatusCode,Json<Value>){(StatusCode::INTERNAL_SERVER_ERROR,Json(json!({"error":"worker internal error"})))}

async fn run_job(state:&StateData,req:&SubmitRequest,id:u32)->Result<SubmitResponse>{
    let job=tempfile::Builder::new().prefix("oj-").tempdir_in("/tmp")?;
    std::fs::set_permissions(job.path(),std::fs::Permissions::from_mode(0o777))?;
    std::fs::write(job.path().join("submission.py"),&req.code)?;
    std::fs::write(job.path().join("runner.py"),RUNNER)?;
    std::fs::write(job.path().join("input.json"),serde_json::to_vec(req)?)?;
    // isolate is an external Linux sandbox binary used by the Rust integration crate.
    let mut sandbox=IsolateSandbox::new(id)
        .with_directory_rule(DirectoryRule::bind("/workspace",job.path()).read_write())
        .with_directory_rule(DirectoryRule::bind_same("/usr/local").maybe())
        .with_env_rule(EnvRule::Set("HOME".into(),"/tmp".into()))
        .with_env_rule(EnvRule::Set("TMPDIR".into(),"/tmp".into()))
        .with_env_rule(EnvRule::Set("PYTHONDONTWRITEBYTECODE".into(),"1".into()))
        .with_env_rule(EnvRule::Set("OMP_NUM_THREADS".into(),"1".into()))
        .with_env_rule(EnvRule::Set("OPENBLAS_NUM_THREADS".into(),"1".into()))
        .with_env_rule(EnvRule::Set("MKL_NUM_THREADS".into(),"1".into()))
        .with_meta_file(job.path().join("meta.txt"));
    // Docker uses /opt/venv; native Ubuntu users may choose /usr/bin/python3.
    // An absent Docker-only path must not prevent sandbox initialization.
    if Path::new("/opt/venv").is_dir() {
        sandbox = sandbox.with_directory_rule(DirectoryRule::bind_same("/opt/venv"));
    }
    if state.cgroups {sandbox=sandbox.use_cgroups();}
    let wall_ms=req.time_limit_ms.unwrap_or(10_000);
    let memory_mb=req.memory_limit_mb.unwrap_or(2048);
    let mut limits=ResourceLimits::new().with_time_limit((wall_ms as f64/1000.0).max(0.1))
        .with_wall_time_limit((wall_ms as f64/1000.0)+2.0)
        .with_process_limit(64);
    limits.file_size_limit=Some(8192); // KB
    limits.open_files_limit=Some(128);
    if state.cgroups {limits=limits.with_cg_memory_limit((memory_mb*1024) as u32);}
    // RLIMIT_AS via --mem is intentionally NOT used: PyTorch reserves large virtual address ranges.
    // Therefore USE_CGROUPS=true is required for strict memory isolation.
    let python=state.python.clone();
    let init=sandbox.init(&limits).await;
    if let Err(e)=init { let _=sandbox.cleanup().await; return Err(e).context("isolate init"); }
    let run_result=tokio::time::timeout(Duration::from_millis(wall_ms+10_000),
        sandbox.run(&python,["/workspace/runner.py"],&limits)).await;
    let cleanup=sandbox.cleanup().await;
    if let Err(e)=cleanup {tracing::warn!(%e,"sandbox cleanup failed");}
    let execution=match run_result {Ok(r)=>r.context("isolate run")?,Err(_)=>anyhow::bail!("isolate command timed out")};
    let result_file=job.path().join("result.json");
    let raw=read_limited(&result_file,1024*1024).unwrap_or_default();
    let parsed:Vec<serde_json::Value>=serde_json::from_slice(&raw).unwrap_or_default();
    let timed_out=execution.killed||execution.status=="TO"||execution.status=="SG"&&execution.signal==Some(9);
    let oom=execution.cg_oom_killed||execution.status=="ML";
    let mut results=Vec::new();
    for (index,case) in req.tests.iter().enumerate(){
        let item=parsed.iter().find(|x|x.get("index").and_then(Value::as_u64)==Some(index as u64));
        let actual=item.and_then(|x|x.get("actual")).cloned();
        let error=item.and_then(|x|x.get("error")).and_then(Value::as_str).map(|x|x.chars().take(4000).collect::<String>());
        let stdout=item.and_then(|x|x.get("stdout")).and_then(Value::as_str).unwrap_or("").chars().take(4096).collect();
        let status=if timed_out {"time_limit_exceeded"} else if oom {"memory_limit_exceeded"}
            else if let Some(_)=&error {"runtime_error"}
            else if let Some(value)=&actual {
                if case.expected.as_ref().is_some_and(|expect|expect!=value){"wrong_answer"}else{"accepted"}
            }else{"runtime_error"};
        results.push(TestResult {index,status:status.into(),actual,expected:case.expected.clone(),error,stdout});
    }
    let passed=results.iter().filter(|r|r.status=="accepted").count();
    let status=if passed==req.tests.len(){"accepted"}else if timed_out {"time_limit_exceeded"}
        else if oom {"memory_limit_exceeded"} else if results.iter().any(|r|r.status=="runtime_error") {"runtime_error"}
        else {"wrong_answer"};
    Ok(SubmitResponse {status:status.into(),passed,total:req.tests.len(),tests:results,
        exit_code:execution.exit_code,cpu_time_s:execution.time_used,wall_time_s:execution.wall_time_used,
        memory_kb:execution.cg_memory_used.unwrap_or(execution.memory_used) as u64,
        stderr:execution.stderr.chars().take(8192).collect()})
}
fn read_limited(path:&Path,max:u64)->Result<Vec<u8>>{
    use std::io::Read;
    let f=std::fs::File::open(path)?;
    let mut data=Vec::new();
    f.take(max+1).read_to_end(&mut data)?;
    if data.len() as u64>max{anyhow::bail!("result too large")}
    Ok(data)
}
