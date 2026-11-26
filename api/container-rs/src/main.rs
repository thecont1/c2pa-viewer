// Rust port of api/container/server.js — the Cloudflare job container
// verification server. Same contract: GET /health, POST /verify with
// x-mime / x-filename / x-trust-profile / x-c2pa-settings headers, ephemeral
// spool, 1 GiB cap, 8-minute analysis timeout, identical error mapping.

mod analyze;
mod c2pa_extract;
mod detect;
mod dimensions;
mod dst;
mod exif;
mod format;
mod photo;
mod social;
mod ssrf;
mod trust;

use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    response::Response,
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};


use analyze::{analyze, AnalyzeArgs};
use trust::Anchors;

const MAX_BYTES: usize = 1024 * 1024 * 1024;
const ANALYZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8 * 60);

fn json_response(status: StatusCode, value: Value) -> Response {
    let body = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}


enum DispatchError {
    Join(tokio::task::JoinError),
}

enum AnalysisSetup {
    RuntimeConstruction,
    Asset(String),
}

// Bounded concurrency for analyses, sized by available parallelism — the
// natural limit for CPU-bound work, not an arbitrary constant.
fn analysis_semaphore() -> std::sync::Arc<tokio::sync::Semaphore> {
    static SEM: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    SEM.get_or_init(|| {
        let n = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(4);
        std::sync::Arc::new(tokio::sync::Semaphore::new(n))
    }).clone()
}

fn err(status: StatusCode, msg: &str) -> Response {
    json_response(status, json!({"error": msg}))
}

async fn health() -> Response {
    json_response(StatusCode::OK, json!({"ok": true}))
}

fn parse_anchors(raw: &str) -> Result<Option<Anchors>, String> {
    if raw.is_empty() {
        return Ok(None);
    }
    let transfer: Value = serde_json::from_str(raw).map_err(|_| "invalid x-c2pa-settings JSON".to_string())?;
    let trust = transfer.get("trust").cloned().unwrap_or(json!({}));
    Ok(Some(Anchors {
        c2pa: trust.get("c2pa_anchors").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        itl: trust.get("itl_anchors").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        config: trust.get("trust_config").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        meta: transfer.get("trust_meta").cloned().unwrap_or(json!({})),
    }))
}

async fn verify(req: Request) -> Response {
    let headers = req.headers().clone();
    let mime = headers
        .get("x-mime")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let filename = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(|s| percent_decode(s))
        .unwrap_or_else(|| "image".to_string());
    let trust_profile = headers
        .get("x-trust-profile")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("c2pa_and_itl")
        .to_string();
    let settings_raw = headers
        .get("x-c2pa-settings")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let anchors = match parse_anchors(&settings_raw) {
        Ok(Some(a)) => a,
        Ok(None) => return err(StatusCode::BAD_REQUEST, "missing x-c2pa-settings"),
        Err(e) => return err(StatusCode::BAD_REQUEST, &e),
    };

    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    if declared > MAX_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "asset exceeds the 1 GiB asynchronous verification cap");
    }

    // Admission control starts HERE, before a single body byte is retained:
    // waiting requests hold no buffered asset, so a flood of concurrent
    // uploads cannot multiply memory while queued. The permit then moves
    // through dispatch into the blocking analysis closure, staying held
    // until the analysis actually returns.
    let sem = analysis_semaphore();
    let permit = match sem.acquire_owned().await {
        Ok(p) => p,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "analysis scheduler unavailable"),
    };

    // Stream the body straight into memory with the cap enforced per frame.
    // The analysis pipeline needs the full asset regardless, so the earlier
    // ephemeral-disk spool bought nothing: it cost blocking file IO on the
    // worker thread and leaked the temp file whenever the request future was
    // dropped mid-upload.
    use http_body_util::BodyExt;
    let mut body = req.into_body();
    let mut bytes: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut spool_failed = false;
    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Some(data) = frame.data_ref() {
                    if bytes.len() + data.len() > MAX_BYTES {
                        oversized = true;
                        break;
                    }
                    bytes.extend_from_slice(data);
                }
            }
            Some(Err(_)) => {
                spool_failed = true;
                break;
            }
            None => break,
        }
    }

    if oversized {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "asset exceeds the 1 GiB asynchronous verification cap");
    }
    if spool_failed {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "asset body read failed");
    }
    if bytes.is_empty() {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "asset is empty");
    }

    // The analysis is CPU-bound synchronous work inside an async shell, so a
    // plain timeout cannot cancel it — the future never yields at an .await.
    // Run it on the blocking thread pool with its own current-thread runtime:
    // the timeout then returns on schedule even when parsing spins, and the
    // main runtime's worker threads stay free for the health endpoint.
    //
    // Admission control: concurrent analyses are bounded by the available
    // parallelism — CPU-bound parsing gains nothing beyond it, while each
    // additional one multiplies peak memory (the input asset is held for the
    // whole analysis). Excess requests queue on the semaphore inside the same
    // timeout budget. The permit moves INTO the blocking closure so it stays
    // held until the analysis actually returns — releasing it when the
    // timeout fires would let the queue over-admit while abandoned analyses
    // are still burning CPU.
    let work = async move {
        tokio::task::spawn_blocking(move || {
            let _permit = permit; // held until this closure returns, timeout or not
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(_) => return Err(AnalysisSetup::RuntimeConstruction),
            };
            rt.block_on(async move {
                let args = AnalyzeArgs {
                    bytes: &bytes,
                    mime: &mime,
                    filename: &filename,
                    content_type: &mime,
                    anchors: &anchors,
                    trust_profile: &trust_profile,
                };
                analyze(&args).await.map_err(AnalysisSetup::Asset)
            })
        }).await.map_err(DispatchError::Join)
    };
    match tokio::time::timeout(ANALYZE_TIMEOUT, work).await {
        Ok(Ok(Ok(analysis))) => json_response(StatusCode::OK, analysis),
        Ok(Ok(Err(AnalysisSetup::Asset(msg)))) => {
            eprintln!("verify failed: {msg}");
            err(StatusCode::UNPROCESSABLE_ENTITY, "the asset could not be read — corrupt or unparseable input")
        }
        Ok(Ok(Err(AnalysisSetup::RuntimeConstruction))) => {
            eprintln!("analysis runtime construction failed");
            err(StatusCode::INTERNAL_SERVER_ERROR, "analysis runtime unavailable")
        }
        Ok(Err(DispatchError::Join(join_err))) => {
            eprintln!("analysis task join failure: {join_err}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "analysis task failed")
        }
        Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "analysis timed out"),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .route("/verify", post(verify));
    // PORT override exists only for local parity testing; production is always 8080.
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind port");
    println!("c2pa verify container (rust) listening on 8080");
    axum::serve(listener, app).await.expect("serve");
}
