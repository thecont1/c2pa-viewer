// Port of packages/core/src/dst.js — digital-source-type heuristics.

use serde_json::Value;

fn label_for(code: &str) -> &str {
    match code {
        "digitalCapture" => "Digital Camera",
        "negativeFilm" => "Negative Film Scan",
        "positiveFilm" => "Slide Film Scan",
        "print" => "Print Scan",
        "screenCapture" => "Screen Capture",
        "trainedAlgorithmicMedia" => "Generative AI",
        "algorithmicMedia" => "Algorithmic Media",
        "algorithmicallyEnhanced" => "AI Enhanced",
        "minorHumanEdits" => "Lightly Edited",
        "compositeCapture" => "Composite (Camera)",
        "compositeDigital" => "Composite (Digital)",
        "compositeSynthetic" => "Composite (Synthetic)",
        "compositeWithTrainedAlgorithmicMedia" => "Composite (AI + Camera)",
        "multiFrameComputationalCapture" => "Computational Photography",
        "virtualRecording" => "Virtual Recording",
        "digitalArt" => "Digital Art",
        "dataDrivenMedia" => "Data-Driven Media",
        _other => return "",
    }
}

fn normalize_source_type(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let segment = trimmed.split('/').last().unwrap_or("").trim();
    if segment.is_empty() {
        None
    } else {
        Some(segment.to_string())
    }
}

fn source_type_result(value: &Value) -> Option<(String, String)> {
    let code = normalize_source_type(value)?;
    let label = label_for(&code);
    let label = if label.is_empty() { code.clone() } else { label.to_string() };
    Some((code, label))
}

// Declared digitalSourceType lookup for assertion data. The flat c2pa form
// is `digitalSourceType`; XMP-serialized IPTC extension metadata carries the
// same field namespaced as `Iptc4xmpExt:DigitalSourceType`. The exact flat
// key wins when both are present; otherwise the first key whose local name
// (after an optional `ns:` prefix) case-insensitively matches is honored.
fn declared_source_type<'a>(data: &'a Value) -> Option<&'a Value> {
    if let Some(dst) = data.get("digitalSourceType") {
        return Some(dst);
    }
    let obj = data.as_object()?;
    for (key, value) in obj {
        let lower = key.to_lowercase();
        let local = lower.rsplit(':').next().unwrap_or("");
        if local == "digitalsourcetype" {
            return Some(value);
        }
    }
    None
}

const AI_TOOLS: [&str; 7] = [
    "firefly", "dall-e", "dalle", "midjourney", "stable diffusion",
    "generative fill", "generative remove",
];

fn agent_name(software_agent: &Value) -> String {
    if let Some(s) = software_agent.as_str() {
        return s.to_string();
    }
    if let Some(name) = software_agent.get("name").and_then(|v| v.as_str()) {
        return name.to_string();
    }
    String::new()
}

fn generative_hit() -> Option<(String, String)> {
    Some(("trainedAlgorithmicMedia".to_string(), "Generative AI".to_string()))
}

fn scan_explicit_source_type(actions: Option<&Vec<Value>>) -> Option<(String, String)> {
    for action in actions? {
        if let Some(dst) = action.get("digitalSourceType") {
            if let Some(hit) = source_type_result(dst) {
                return Some(hit);
            }
        }
    }
    None
}

// `ai` is evidence only as a complete token — substring matching convicts
// unrelated words ("thumbnailWidth", "detail", "repair") of being AI markers.
fn contains_ai_token(s: &str) -> bool {
    let bytes = s.as_bytes();
    for i in 0..bytes.len().saturating_sub(1) {
        if bytes[i] == b'a' && bytes[i + 1] == b'i' {
            let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let after_ok = i + 2 >= bytes.len() || !bytes[i + 2].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

fn scan_actions(actions: Option<&Vec<Value>>) -> Option<(String, String)> {
    for action in actions? {
        let action_name = action.get("action").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let software_agent = agent_name(action.get("softwareAgent").unwrap_or(&Value::Null)).to_lowercase();
        if action_name.contains("generative") || contains_ai_token(&action_name) {
            return generative_hit();
        }
        let mut ai_all = AI_TOOLS.to_vec();
        ai_all.push("generative");
        if ai_all.iter().any(|t| software_agent.contains(t)) {
            return generative_hit();
        }
        if let Some(params) = action.get("parameters").and_then(|v| v.as_object()) {
            for (key, value) in params {
                let key_lower = key.to_lowercase();
                let value_lower = match value {
                    Value::String(s) => s.to_lowercase(),
                    other => other.to_string().to_lowercase(),
                };
                if ["firefly", "generative", "text_to_image"].iter().any(|kw| key_lower.contains(kw)) || contains_ai_token(&key_lower) {
                    return generative_hit();
                }
                if ["text_to_image", "generative", "firefly"].iter().any(|kw| value_lower.contains(kw)) {
                    return generative_hit();
                }
            }
        }
    }
    None
}

pub fn get_digital_source_type(c2pa_data: &Value) -> (Option<String>, Option<String>) {
    if !c2pa_data.is_object() {
        return (None, None);
    }
    let none: (Option<String>, Option<String>) = (None, None);
    let claim_generator = c2pa_data
        .get("basic_info")
        .and_then(|b| b.get("claim_generator"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    // Declared source types win over every heuristic: the signer states what
    // the media is, and a generator with an AI-flavored name must not override
    // an explicit digitalCapture declaration. Two passes — declarations first,
    // action/parameter heuristics only when nothing is declared.
    if let Some(Value::Array(assertions)) = c2pa_data.get("assertions") {
        for assertion in assertions {
            let label = assertion.get("label").and_then(|v| v.as_str()).unwrap_or("");
            let data = assertion.get("data").unwrap_or(&Value::Null);
            let label_lower = label.to_lowercase();
            if label_lower.contains("iptc") || label_lower.contains("photo-metadata") || label.contains("CreativeWork") {
                if let Some(dst) = declared_source_type(data) {
                    if let Some(hit) = source_type_result(dst) {
                        return (Some(hit.0), Some(hit.1));
                    }
                }
            }
        }
        // The same selected Actions assertion backs both scans — the one the
        // response itself reports: c2pa.actions.v2 supersedes v1, which is
        // consulted only when no v2 exists. Scanning every actions-ish
        // assertion in array order could convict or clear based on a v1
        // assertion the response does not even surface.
        fn assertion_label(a: &Value) -> &str {
            a.get("label").and_then(|v| v.as_str()).unwrap_or("")
        }
        let label_of = assertion_label;
        let selected = assertions
            .iter()
            .find(|a| label_of(a) == "c2pa.actions.v2")
            .or_else(|| assertions.iter().find(|a| label_of(a) == "c2pa.actions"));
        if let Some(assertion) = selected {
            let data = assertion.get("data").unwrap_or(&Value::Null);
            let actions = data.get("actions").and_then(|v| v.as_array());
            if let Some(hit) = scan_explicit_source_type(actions) {
                return (Some(hit.0), Some(hit.1));
            }
            // Declaration passes are exhausted — heuristic scan of the same
            // selected assertion only.
            if let Some(hit) = scan_actions(actions) {
                return (Some(hit.0), Some(hit.1));
            }
        }
    }

    let mut ai_all = AI_TOOLS.to_vec();
    ai_all.push("generative");
    if ai_all.iter().any(|t| claim_generator.contains(t)) {
        let hit = generative_hit().unwrap();
        return (Some(hit.0), Some(hit.1));
    }

    let legacy_actions = c2pa_data.get("actions").and_then(|v| v.as_array());
    if let Some(hit) = scan_actions(legacy_actions) {
        return (Some(hit.0), Some(hit.1));
    }

    if let Some(Value::Array(ingredients)) = c2pa_data.get("ingredients") {
        for ingredient in ingredients {
            let fmt = ingredient.get("format").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let title = ingredient.get("title").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if fmt.contains("dng") || fmt.contains("raw") || title.ends_with(".dng") || title.ends_with(".raw") {
                return (Some("digitalCapture".into()), Some("Digital Camera (RAW)".into()));
            }
            if fmt.contains("jpeg") || fmt.contains("jpg") || fmt.contains("tiff") {
                return (Some("digitalCapture".into()), Some("Digital Camera".into()));
            }
        }
    }

    let has_actions = c2pa_data.get("actions").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    let has_ingredients = c2pa_data.get("ingredients").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    if has_actions || has_ingredients {
        return (Some("digitalCapture".into()), Some("Digital Camera".into()));
    }
    none
}
