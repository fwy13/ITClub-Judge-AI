mod api;
mod protocol;
mod sandbox;
mod worker;

pub use sandbox::{DirectoryRule, EnvRule, IsolateSandbox, ResourceLimits};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "online_judge=info,oj_api=info,oj_worker=info".into()),
        )
        .init();

    match std::env::args().nth(1).as_deref() {
        None | Some("all") => {
            // Run both HTTP servers concurrently in one Tokio runtime.
            // If either server fails, propagate the error and stop the process.
            tokio::try_join!(worker::run(), api::run())?;
            Ok(())
        }
        Some("api") => api::run().await,
        Some("worker") => worker::run().await,
        _ => anyhow::bail!("Usage: online-judge [all|api|worker]"),
    }
}
