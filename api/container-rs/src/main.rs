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
use std::io::Write;

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

    // Ephemeral-disk spool first (streaming, counted), then one in-memory read.
    let tmp = format!("/tmp/c2pa-asset-{}", uuid::Uuid::new_v4());
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "temporary file spool failed"),
    };
    let mut size: usize = 0;
    let mut oversized = false;
    let mut spool_failed = false;

    use http_body_util::BodyExt;
    let mut body = req.into_body();
    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Some(data) = frame.data_ref() {
                    size += data.len();
                    if size > MAX_BYTES {
                        oversized = true;
                        break;
                    }
                    if file.write_all(data).is_err() {
                        spool_failed = true;
                        break;
                    }
                }
            }
            Some(Err(_) ) => {
                spool_failed = true;
                break;
            }
            None => break,
        }
    }
    drop(file);

    if oversized {
        let _ = std::fs::remove_file(&tmp);
        return err(StatusCode::PAYLOAD_TOO_LARGE, "asset exceeds the 1 GiB asynchronous verification cap");
    }
    if spool_failed {
        let _ = std::fs::remove_file(&tmp);
        return err(StatusCode::INTERNAL_SERVER_ERROR, "temporary file spool failed");
    }
    if size == 0 {
        let _ = std::fs::remove_file(&tmp);
        return err(StatusCode::UNPROCESSABLE_ENTITY, "asset is empty");
    }

    let bytes = match std::fs::read(&tmp) {
        Ok(b) => b,
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
            return err(StatusCode::INTERNAL_SERVER_ERROR, "temporary file read failed");
        }
    };
    let _ = std::fs::remove_file(&tmp);

    let args = AnalyzeArgs {
        bytes: &bytes,
        mime: &mime,
        filename: &filename,
        content_type: &mime,
        anchors: &anchors,
        trust_profile: &trust_profile,
    };

    let result = tokio::time::timeout(ANALYZE_TIMEOUT, analyze(&args)).await;
    match result {
        Ok(Ok(analysis)) => json_response(StatusCode::OK, analysis),
        Ok(Err(msg)) => {
            eprintln!("verify failed: {msg}");
            err(StatusCode::UNPROCESSABLE_ENTITY, "the asset could not be read — corrupt or unparseable input")
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
