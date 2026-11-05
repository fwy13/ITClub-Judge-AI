use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCase {
    #[serde(default)] pub args: Vec<Value>,
    #[serde(default)] pub kwargs: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub expected: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitRequest {
    pub code: String,
    pub function: String,
    #[serde(default)] pub class_name: Option<String>,
    pub tests: Vec<TestCase>,
    #[serde(default)] pub time_limit_ms: Option<u64>,
    #[serde(default)] pub memory_limit_mb: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub index: usize,
    pub status: String,
    #[serde(skip_serializing_if="Option::is_none")] pub actual: Option<Value>,
    #[serde(skip_serializing_if="Option::is_none")] pub expected: Option<Value>,
    #[serde(skip_serializing_if="Option::is_none")] pub error: Option<String>,
    #[serde(default)] pub stdout: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitResponse {
    pub status: String,
    pub passed: usize,
    pub total: usize,
    pub tests: Vec<TestResult>,
    pub exit_code: Option<i32>,
    pub cpu_time_s: f64,
    pub wall_time_s: f64,
    pub memory_kb: u64,
    pub stderr: String,
}
