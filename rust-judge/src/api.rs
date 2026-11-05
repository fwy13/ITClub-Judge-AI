use axum::{extract::{DefaultBodyLimit, State}, http::StatusCode, routing::{get, post}, Json, Router};
use crate::protocol::{SubmitRequest, SubmitResponse};
use serde_json::{json, Value};
use std::{env, sync::Arc, time::Duration};

struct AppState { client: reqwest::Client, worker_url: String }

pub async fn run() -> anyhow::Result<()> {
    let worker_url=env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:3001".into());
    let state=Arc::new(AppState { client: reqwest::Client::builder().timeout(Duration::from_secs(180)).build()?, worker_url });
    let app=Router::new().route("/health",get(|| async { Json(json!({"status":"ok"})) }))
        .route("/api/v1/execute",post(execute))
        .route("/api/v1/submit",post(execute))
        .layer(DefaultBodyLimit::max(1024*1024)).with_state(state);
    let addr=env::var("API_BIND").unwrap_or_else(|_| "0.0.0.0:3000".into());
    tracing::info!(%addr,"API listening");
    let listener=tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener,app).await?;
    Ok(())
}
async fn execute(State(state):State<Arc<AppState>>, Json(req):Json<SubmitRequest>) -> Result<Json<SubmitResponse>, (StatusCode,Json<Value>)> {
    if req.code.trim().is_empty() || req.code.len()>200_000 || req.tests.is_empty() || req.tests.len()>50
        || req.function.is_empty() || !identifier(&req.function)
        || req.class_name.as_deref().is_some_and(|s| !identifier(s))
        || req.time_limit_ms.is_some_and(|n| !(100..=30_000).contains(&n))
        || req.memory_limit_mb.is_some_and(|n| !(128..=8192).contains(&n)) {
        return Err(err(StatusCode::BAD_REQUEST,"invalid request: code/function/tests/limits"));
    }
    let response=state.client.post(format!("{}/internal/execute",state.worker_url.trim_end_matches('/'))).json(&req).send().await
        .map_err(|_|err(StatusCode::BAD_GATEWAY,"execution worker unavailable"))?;
    let status=response.status();
    if !status.is_success() {
        let body=response.text().await.unwrap_or_default();
        return Err(err(StatusCode::BAD_GATEWAY,&format!("worker error: {}",truncate(&body,512))));
    }
    let body=response.json::<SubmitResponse>().await.map_err(|_|err(StatusCode::BAD_GATEWAY,"invalid worker response"))?;
    Ok(Json(body))
}
fn identifier(s:&str)->bool { let mut c=s.chars(); c.next().is_some_and(|x|x=='_'||x.is_ascii_alphabetic()) && c.all(|x|x=='_'||x.is_ascii_alphanumeric()) }
fn truncate(s:&str,n:usize)->String{s.chars().take(n).collect()}
fn err(status:StatusCode,message:&str)->(StatusCode,Json<Value>){(status,Json(json!({"error":message})))}
