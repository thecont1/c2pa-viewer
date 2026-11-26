// Port of packages/core/src/social.js — social-link extraction.

use serde_json::{Map, Value};

// Classify by parsed hostname: the exact social domain or a subdomain of it
// (dot boundary). Substring matching classified evilinstagram.com and
// instagram.com.evil.test as genuine social links.
fn host_matches(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|pre| pre.ends_with('.'))
}

fn insert_link(out: &mut Map<String, Value>, id: &str) {
    let host = match url::Url::parse(id) {
        Ok(u) => u.host_str().unwrap_or("").to_lowercase(),
        Err(_) => return,
    };
    if host_matches(&host, "instagram.com") {
        out.entry("instagram").or_insert_with(|| Value::String(id.to_string()));
    } else if host_matches(&host, "twitter.com") || host_matches(&host, "x.com") {
        out.entry("twitter").or_insert_with(|| Value::String(id.to_string()));
    } else if host_matches(&host, "linkedin.com") {
        out.entry("linkedin").or_insert_with(|| Value::String(id.to_string()));
    }
}

pub fn extract_social_links(assertion_data: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if !assertion_data.is_object() {
        return out;
    }
    if let Some(Value::Array(authors)) = assertion_data.get("author") {
        for author in authors {
            if let Some(id) = author.get("@id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    insert_link(&mut out, id);
                }
            }
        }
    }
    let mappings: [(&str, &[&str]); 3] = [
        ("instagram", &["instagram", "instagram_url"]),
        ("twitter", &["twitter", "twitter_url", "x_url"]),
        ("linkedin", &["linkedin", "linkedin_url"]),
    ];
    for (social_type, keys) in mappings {
        if out.contains_key(social_type) {
            continue;
        }
        for key in keys {
            if let Some(value) = assertion_data.get(key) {
                let mut s = match value {
                    Value::String(s) => s.clone(),
                    other => value_to_js_string(other),
                };
                if s.is_empty() {
                    continue;
                }
                if !s.starts_with("http://") && !s.starts_with("https://") {
                    s = format!("https://{}", s);
                }
                out.insert(social_type.to_string(), Value::String(s));
                break;
            }
        }
    }
    if let Some(Value::String(url)) = assertion_data.get("url") {
        insert_link(&mut out, url);
    }
    if let Some(Value::Array(urls)) = assertion_data.get("url") {
        for url in urls {
            if let Some(u) = url.as_str() {
                insert_link(&mut out, u);
            }
        }
    }
    out
}

// JS String(value) semantics for the small set of JSON types.
pub fn value_to_js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}
