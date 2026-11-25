// Port of packages/core/src/c2pa.js — manifest extraction, validation,
// thumbnails, provenance formatting, and trust-profile reads.

use c2pa::{Context, Reader};
use serde_json::{json, Map, Value};
use std::io::Cursor;

use crate::dst::get_digital_source_type;
use crate::format::{format_claim_generator, format_datetime_full};
use crate::social::extract_social_links;
use crate::trust::{build_settings_json, has_blocked_remote_url, signer_trust_label, trust_lists_meta, Anchors};

pub struct EngineRead {
    pub store: Value,
    pub reader: Reader,
}

pub enum ReadOutcome {
    NoManifest,
    Store(EngineRead),
}

/// engine.read equivalent: returns None for no-manifest, or the store + live
/// reader (kept for resource extraction).
pub async fn engine_read(bytes: &[u8], mime: &str, settings_json: &str) -> Result<Option<EngineRead>, String> {
    let context = Context::new()
        .with_settings(settings_json)
        .map_err(|e| format!("settings rejected: {e}"))?;
    let buf = bytes.to_vec();
    let cursor = Cursor::new(buf);
    let result = Reader::from_context(context)
        .with_stream_async(mime, cursor)
        .await;
    match result {
        Ok(reader) => {
            let store_json = reader.json();
            let store: Value = serde_json::from_str(&store_json).map_err(|e| format!("store json parse: {e}"))?;
            let count = store.get("manifests").and_then(|m| m.as_object()).map(|o| o.len()).unwrap_or(0);
            if count == 0 {
                return Ok(None);
            }
            Ok(Some(EngineRead { store, reader }))
        }
        Err(c2pa::Error::JumbfNotFound) => Ok(None),
        Err(e) => Err(format!("reader rejected asset: {e}")),
    }
}

fn validation_state_of(store: &Value) -> Option<String> {
    store.get("validation_state").and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub struct TrustResult {
    pub handle: Option<EngineRead>,
    pub state: Option<String>,
    pub basis: Option<String>,
}

/// readWithTrustProfiles — first read on the C2PA list; conditional ITL
/// fallback for Valid-but-untrusted manifests.
pub async fn read_with_trust_profiles(
    bytes: &[u8],
    mime: &str,
    anchors: &Anchors,
    profile: &str,
) -> Result<TrustResult, String> {
    let remote_fetch = !has_blocked_remote_url(bytes);
    let first_settings = build_settings_json(anchors, "c2pa", remote_fetch);
    let first = engine_read(bytes, mime, &first_settings).await?;
    let first = match first {
        None => return Ok(TrustResult { handle: None, state: None, basis: None }),
        Some(f) => f,
    };
    let state1 = validation_state_of(&first.store);

    if state1.as_deref() == Some("Trusted") {
        return Ok(TrustResult {
            handle: Some(first),
            state: state1,
            basis: Some("c2pa_trust_list".into()),
        });
    }
    if state1.as_deref() == Some("Valid") && profile == "c2pa" {
        return Ok(TrustResult {
            handle: Some(first),
            state: state1,
            basis: Some("none".into()),
        });
    }
    if state1.as_deref() == Some("Valid") {
        let second_settings = build_settings_json(anchors, "c2pa_and_itl", remote_fetch);
        let second = engine_read(bytes, mime, &second_settings).await?;
        let state2 = second.as_ref().and_then(|s| validation_state_of(&s.store));
        if state2.as_deref() == Some("Trusted") {
            return Ok(TrustResult {
                handle: second,
                state: state2,
                basis: Some("interim_trust_list".into()),
            });
        }
        return Ok(TrustResult {
            handle: Some(first),
            state: state1,
            basis: Some("none".into()),
        });
    }
    Ok(TrustResult {
        handle: Some(first),
        state: state1,
        basis: None,
    })
}

// ------------------------------------------------------- manifest transform

fn active_manifest(store: &Value) -> Option<Value> {
    let label = store.get("active_manifest").and_then(|v| v.as_str())?;
    store.get("manifests")?.as_object()?.get(label).cloned()
}

pub fn extract_validation(store: &Value) -> Value {
    let vr = store
        .get("validation_results")
        .and_then(|v| v.get("activeManifest"))
        .cloned()
        .unwrap_or(json!({}));
    let clean = |list: Option<&Value>| -> Vec<Value> {
        let mut out = Vec::new();
        if let Some(Value::Array(items)) = list {
            for entry in items {
                let mut o = Map::new();
                o.insert("code".into(), entry.get("code").cloned().unwrap_or(Value::Null));
                o.insert("explanation".into(), entry.get("explanation").cloned().unwrap_or(Value::Null));
                if let Some(url) = entry.get("url") {
                    if !url.is_null() {
                        o.insert("url".into(), url.clone());
                    }
                }
                out.push(Value::Object(o));
            }
        }
        out
    };
    let mut success = clean(vr.get("success"));
    let mut informational = clean(vr.get("informational"));
    let mut failure = clean(vr.get("failure"));

    let key_of = |e: &Value| -> String {
        format!(
            "{}{}",
            e.get("code").and_then(|c| c.as_str()).unwrap_or(""),
            e.get("url").and_then(|c| c.as_str()).unwrap_or("")
        )
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in success.iter().chain(informational.iter()).chain(failure.iter()) {
        seen.insert(key_of(e));
    }
    if let Some(Value::Array(statuses)) = store.get("validation_status") {
        for st in statuses {
            if st.get("code").is_none() || st.get("code").map(|c| c.is_null()).unwrap_or(true) {
                continue;
            }
            let mut o = Map::new();
            o.insert("code".into(), st.get("code").cloned().unwrap_or(Value::Null));
            o.insert("explanation".into(), st.get("explanation").cloned().unwrap_or(Value::Null));
            if let Some(url) = st.get("url") {
                if !url.is_null() {
                    o.insert("url".into(), url.clone());
                }
            }
            let v = Value::Object(o);
            let key = key_of(&v);
            if seen.insert(key) {
                failure.push(v);
            }
        }
    }
    let mut results = Map::new();
    results.insert("success".into(), Value::Array(std::mem::take(&mut success)));
    results.insert("informational".into(), Value::Array(std::mem::take(&mut informational)));
    results.insert("failure".into(), Value::Array(failure));
    json!({
        "state": store.get("validation_state").cloned().unwrap_or(Value::Null),
        "results": Value::Object(results),
    })
}

fn extract_manifest_data(store: &Value) -> Option<Value> {
    let manifest = active_manifest(store)?;

    let mut basic = Map::new();
    basic.insert("title".into(), manifest.get("title").cloned().unwrap_or(Value::Null));
    basic.insert("format".into(), manifest.get("format").cloned().unwrap_or(Value::Null));
    basic.insert("instance_id".into(), manifest.get("instance_id").cloned().unwrap_or(Value::Null));
    basic.insert("claim_generator".into(), manifest.get("claim_generator").cloned().unwrap_or(Value::Null));

    let mut result = Map::new();
    result.insert("basic_info".into(), Value::Object(basic));
    result.insert(
        "signature_info".into(),
        manifest.get("signature_info").cloned().unwrap_or(json!({})),
    );
    result.insert(
        "validation_state".into(),
        store.get("validation_state").cloned().unwrap_or(Value::Null),
    );

    let mut assertions_out: Vec<Value> = Vec::new();
    let mut actions_out: Vec<Value> = Vec::new();
    let mut author_info = json!({});

    let assertions = manifest.get("assertions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    // v2 actions assertion supersedes v1 when both exist.
    let action_idxs: Vec<usize> = assertions
        .iter()
        .enumerate()
        .filter(|(_, a)| {
            let l = a.get("label").and_then(|v| v.as_str()).unwrap_or("");
            l == "c2pa.actions.v2" || l == "c2pa.actions"
        })
        .map(|(i, _)| i)
        .collect();
    let v2_idx = action_idxs.iter().copied().find(|&i| {
        assertions[i].get("label").and_then(|v| v.as_str()) == Some("c2pa.actions.v2")
    });
    let actions_source = v2_idx.or_else(|| action_idxs.first().copied());

    for (i, assertion) in assertions.iter().enumerate() {
        let label = assertion.get("label").and_then(|v| v.as_str()).unwrap_or("Unknown");
        let mut data = assertion.get("data").cloned().unwrap_or(json!({}));
        // The JS original mutates the CreativeWork assertion data in place
        // (adding social_links) and shares that reference between
        // result.assertions and result.author_info — replicate by mutating
        // BEFORE pushing to the assertions list.
        if label == "stds.schema-org.CreativeWork" && Some(i) != actions_source {
            let links = extract_social_links(&data);
            if let Value::Object(ref mut obj) = data {
                obj.insert("social_links".into(), Value::Object(links));
            }
            author_info = data.clone();
        }
        assertions_out.push(json!({"label": label, "data": data}));

        if Some(i) == actions_source {
            if let Some(Value::Array(actions)) = data.get("actions") {
                for action in actions {
                    actions_out.push(json!({
                        "action": action.get("action").cloned().unwrap_or(Value::Null),
                        "when": action.get("when").cloned().unwrap_or(Value::Null),
                        "softwareAgent": action.get("softwareAgent").cloned().unwrap_or(Value::Null),
                        "parameters": action.get("parameters").cloned().unwrap_or(json!({})),
                    }));
                }
            }
        }
    }

    let mut ingredients_out: Vec<Value> = Vec::new();
    if let Some(Value::Array(ingredients)) = manifest.get("ingredients") {
        for ingredient in ingredients {
            ingredients_out.push(json!({
                "title": ingredient.get("title").cloned().unwrap_or(Value::Null),
                "format": ingredient.get("format").cloned().unwrap_or(Value::Null),
                "relationship": ingredient.get("relationship").cloned().unwrap_or(Value::Null),
                "instance_id": ingredient.get("instance_id").cloned().unwrap_or(Value::Null),
            }));
        }
    }

    result.insert("assertions".into(), Value::Array(assertions_out));
    result.insert("ingredients".into(), Value::Array(ingredients_out));
    result.insert("actions".into(), Value::Array(actions_out));
    result.insert("author_info".into(), author_info);
    result.insert("digital_source_type".into(), Value::Null);

    let result_value = Value::Object(result);
    let (code, label) = get_digital_source_type(&result_value);
    if let Value::Object(mut obj) = result_value {
        obj.insert(
            "digital_source_type".into(),
            json!({"code": code, "label": label}),
        );
        return Some(Value::Object(obj));
    }
    None
}

async fn extract_thumbnails(manifest: &Value, reader: &Reader) -> Map<String, Value> {
    let mut out = Map::new();
    let read_resource = |identifier: &str| -> Option<Vec<u8>> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        reader
            .resource_to_stream(identifier, &mut cursor)
            .ok()
            .map(|_| cursor.into_inner())
    };
    if let Some(id) = manifest.get("thumbnail").and_then(|t| t.get("identifier")).and_then(|v| v.as_str()) {
        if let Some(bytes) = read_resource(id) {
            out.insert("claim_thumbnail".into(), json!(base64_encode(&bytes)));
        }
    }
    if let Some(Value::Array(ingredients)) = manifest.get("ingredients") {
        if let Some(first) = ingredients.first() {
            if let Some(id) = first.get("thumbnail").and_then(|t| t.get("identifier")).and_then(|v| v.as_str()) {
                if let Some(bytes) = read_resource(id) {
                    out.insert("ingredient_thumbnail".into(), json!(base64_encode(&bytes)));
                }
            }
        }
    }
    out
}

pub fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ------------------------------------------------------------- provenance --

fn verification_label(state: Option<&str>) -> &'static str {
    match state {
        Some("Valid") | Some("Trusted") => "Signature Valid",
        Some("Invalid") => "Signature Invalid",
        _ => "Not Verified",
    }
}

pub fn format_provenance(c2pa_data: &Value) -> Vec<Value> {
    let mut provenance: Vec<Value> = Vec::new();
    let basic = c2pa_data.get("basic_info").cloned().unwrap_or(json!({}));
    if let Some(gen) = basic.get("claim_generator").and_then(|v| v.as_str()) {
        if !gen.is_empty() {
            provenance.push(json!({
                "name": "Claim Generator",
                "generator": format_claim_generator(gen),
            }));
        }
    }
    let sig = c2pa_data.get("signature_info").cloned().unwrap_or(json!({}));
    if let Some(issuer) = sig.get("issuer").and_then(|v| v.as_str()) {
        provenance.push(json!({"name": "Issued By", "issuer": issuer}));
    }
    if let Some(time) = sig.get("time").and_then(|v| v.as_str()) {
        provenance.push(json!({
            "name": "Issued On",
            "date": format_datetime_full(time, true),
        }));

        let author_info = c2pa_data.get("author_info").cloned().unwrap_or(json!({}));
        if let Some(name) = author_info.get("name") {
            if !name.is_null() {
                provenance.push(json!({"name": "Title", "title": name}));
            }
        }
        if let Some(desc) = author_info.get("description") {
            if !desc.is_null() {
                provenance.push(json!({"name": "Description", "data": desc}));
            }
        }
        if let Some(keywords) = author_info.get("keywords") {
            let data = match keywords {
                Value::Array(list) => {
                    let parts: Vec<String> = list
                        .iter()
                        .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))
                        .collect();
                    json!(parts.join(", "))
                }
                other => other.clone(),
            };
            provenance.push(json!({"name": "Keywords", "data": data}));
        }
        if let Some(Value::Array(authors)) = author_info.get("author") {
            if let Some(author) = authors.first() {
                let works_for = author.get("worksFor");
                let works_for_value = match works_for {
                    Some(Value::Object(wf)) => wf.get("name").cloned().unwrap_or(Value::Null),
                    Some(other) => other.clone(),
                    None => Value::Null,
                };
                let details = json!({
                    "name": author.get("name").cloned().unwrap_or(json!("Unknown")),
                    "identifier": author.get("identifier").cloned().unwrap_or(Value::Null),
                    "url": author.get("url").cloned().unwrap_or(Value::Null),
                    "sameAs": author.get("sameAs").cloned().unwrap_or(json!([])),
                    "email": author.get("email").cloned().unwrap_or(Value::Null),
                    "telephone": author.get("telephone").cloned().unwrap_or(Value::Null),
                    "address": author.get("address").cloned().unwrap_or(Value::Null),
                    "jobTitle": author.get("jobTitle").cloned().unwrap_or(Value::Null),
                    "worksFor": works_for_value,
                    "social_links": author_info.get("social_links").cloned().unwrap_or(json!({})),
                });
                provenance.push(json!({
                    "name": "Author",
                    "author": details.get("name").cloned().unwrap_or(json!("Unknown")),
                    "author_details": details,
                }));
            }
        }
        if let Some(Value::Array(holders)) = author_info.get("copyrightHolder") {
            if let Some(holder) = holders.first() {
                let name = holder.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                provenance.push(json!({"name": "Copyright", "copyright": name}));
            }
        }
        if let Some(Value::Object(publisher)) = author_info.get("publisher") {
            let name = publisher.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown");
            provenance.push(json!({"name": "Publisher", "publisher": name}));
        }
    }

    if let Some(Value::Array(actions)) = c2pa_data.get("actions") {
        for action in actions {
            let mut item = Map::new();
            item.insert("name".into(), json!("Action"));
            item.insert("action".into(), action.get("action").cloned().unwrap_or(Value::Null));
            item.insert("software".into(), action.get("softwareAgent").cloned().unwrap_or(Value::Null));
            item.insert("parameters".into(), action.get("parameters").cloned().unwrap_or(json!({})));
            if let Some(when) = action.get("when").and_then(|v| v.as_str()) {
                item.insert("when".into(), json!(format_datetime_full(when, true)));
            }
            provenance.push(Value::Object(item));
        }
    }

    let state = c2pa_data.get("validation_state").and_then(|v| v.as_str());
    provenance.push(json!({
        "name": "Verification",
        "verification": verification_label(state),
    }));
    provenance
}

// ------------------------------------------------------------- top level ---

pub fn empty_c2pa_result() -> Value {
    json!({
        "provenance": [],
        "c2pa_data": null,
        "author_info": null,
        "thumbnails": {},
        "digital_source_type": null,
    })
}

pub struct C2paOutcome {
    pub result: Value,
    pub validation: Option<Value>,
    pub manifest_label: Option<String>,
}

/// readC2paAsset — the full c2pa extraction for one asset.
pub async fn read_c2pa_asset(bytes: &[u8], mime: &str, anchors: &Anchors, trust_profile: &str) -> Result<C2paOutcome, String> {
    let res = read_with_trust_profiles(bytes, mime, anchors, trust_profile).await?;
    let trust_info = json!({
        "state": res.state,
        "basis": res.basis,
        "lists": trust_lists_meta(anchors),
    });

    let handle = match res.handle {
        None => {
            let mut empty = empty_c2pa_result();
            empty["trust"] = trust_info;
            return Ok(C2paOutcome { result: empty, validation: None, manifest_label: None });
        }
        Some(h) => h,
    };

    let store = handle.store.clone();
    let manifest_label = store.get("active_manifest").and_then(|v| v.as_str()).map(|s| s.to_string());
    let validation = extract_validation(&store);

    let manifest = active_manifest(&store);
    if manifest.is_none() {
        let mut empty = empty_c2pa_result();
        empty["trust"] = trust_info;
        return Ok(C2paOutcome { result: empty, validation: Some(validation), manifest_label });
    }
    let manifest = manifest.unwrap();

    let c2pa_data = match extract_manifest_data(&store) {
        None => {
            let mut empty = empty_c2pa_result();
            empty["trust"] = trust_info;
            return Ok(C2paOutcome { result: empty, validation: Some(validation), manifest_label });
        }
        Some(d) => d,
    };

    let thumbnails = extract_thumbnails(&manifest, &handle.reader).await;

    let mut provenance = format_provenance(&c2pa_data);
    // Signer Trust row just ahead of the trailing Verification entry.
    let label = signer_trust_label(res.state.as_deref(), res.basis.as_deref());
    if let Some(label) = label {
        let pos = provenance.len().saturating_sub(1);
        provenance.insert(pos, json!({"name": "Signer Trust", "trust": label}));
    }

    let author_info = c2pa_data.get("author_info").cloned().unwrap_or(json!({}));
    let dst = c2pa_data.get("digital_source_type").cloned().unwrap_or(Value::Null);

    let result = json!({
        "provenance": provenance,
        "c2pa_data": c2pa_data,
        "author_info": author_info,
        "thumbnails": Value::Object(thumbnails),
        "digital_source_type": dst,
        "trust": trust_info,
    });
    Ok(C2paOutcome { result, validation: Some(validation), manifest_label })
}
