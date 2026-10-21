//! HTTP client for the `http` code blocks: the request is built by the frontend (variables already
//! resolved) and sent from here, because the WebView's CSP and CORS rules would block most calls.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_http::reqwest;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_HEADERS: usize = 100;
const MAX_HEADER_VALUE_CHARS: usize = 8 * 1024;
/// Set by the HTTP stack from the URL and the body: a document must not override them.
const FORBIDDEN_HEADERS: [&str; 4] = ["host", "content-length", "transfer-encoding", "connection"];
const MAX_REDIRECTS: usize = 10;
/// Only variables with this prefix are readable from a document: `{{$processEnv SNIB_TOKEN}}`, `{{$dotenv SNIB_TOKEN}}`.
const ENV_PREFIX: &str = "SNIB_";
/// Folders searched upwards for a `.env` file, the document folder included.
const DOTENV_LEVELS: usize = 6;
const ENV_FILE: &str = "http-env.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    binary: bool,
    truncated: bool,
    size: usize,
    millis: u64,
}

fn parse_request_url(input: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(input.trim()).map_err(|e| format!("{input}: {e}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        _ => Err(format!("{input}: only http and https addresses are allowed")),
    }
}

/// A redirect is followed only within the same host and port, and never from https down to http: otherwise a
/// server could steer the request to another machine (the confirmation covered only the first address).
fn redirect_allowed(first: &reqwest::Url, next: &reqwest::Url) -> bool {
    let same_origin = first.scheme() == next.scheme() && first.port_or_known_default() == next.port_or_known_default();
    // the usual http to https upgrade, both on default ports
    let upgrade = first.scheme() == "http" && next.scheme() == "https" && first.port().is_none() && next.port().is_none();
    first.host_str() == next.host_str() && (same_origin || upgrade)
}

/// Sends one request and returns status, headers and body (text; binary bodies are reported, not returned).
#[tauri::command]
pub async fn http_send(request: HttpRequest) -> Result<HttpResponse, String> {
    let url = parse_request_url(&request.url)?;
    let method = reqwest::Method::from_bytes(request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("invalid method: {}", request.method))?;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &request.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| format!("invalid header name: {name}"))?;
        if FORBIDDEN_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let value = reqwest::header::HeaderValue::from_str(value.trim())
            .map_err(|_| format!("invalid value for header {name}"))?;
        headers.append(name, value);
    }
    if !headers.contains_key(reqwest::header::USER_AGENT) {
        headers.insert(reqwest::header::USER_AGENT, reqwest::header::HeaderValue::from_static("s-nib"));
    }
    let timeout = request.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.previous().first().is_some_and(|first| redirect_allowed(first, attempt.url()));
            if allowed && attempt.previous().len() < MAX_REDIRECTS {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = request.body.filter(|body| !body.is_empty()) {
        builder = builder.body(body);
    }
    let started = Instant::now();
    let mut response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let response_headers = response
        .headers()
        .iter()
        .take(MAX_RESPONSE_HEADERS)
        .map(|(name, value)| {
            let value = String::from_utf8_lossy(value.as_bytes());
            (name.to_string(), value.chars().take(MAX_HEADER_VALUE_CHARS).collect())
        })
        .collect();

    let mut bytes = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            bytes.extend_from_slice(&chunk[..MAX_RESPONSE_BYTES - bytes.len()]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    let size = bytes.len();
    // a truncated body may end inside a character: that is not a binary file
    let (body, binary) = match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(e) if truncated && e.utf8_error().error_len().is_none() => {
            let valid = e.utf8_error().valid_up_to();
            (String::from_utf8_lossy(&e.as_bytes()[..valid]).into_owned(), false)
        }
        Err(_) => (String::new(), true),
    };
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: response_headers,
        body,
        binary,
        truncated,
        size,
        millis: started.elapsed().as_millis() as u64,
    })
}

/// Environments file (`http-env.json` in the app config folder), as raw JSON text; `{}` when absent.
#[tauri::command]
pub fn http_env(app: AppHandle) -> Result<String, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join(ENV_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Value of a process environment variable named `SNIB_*`; other names are refused.
#[tauri::command]
pub fn http_process_env(name: String) -> Result<String, String> {
    if !name.starts_with(ENV_PREFIX) {
        return Err(format!("only variables starting with {ENV_PREFIX} can be read"));
    }
    std::env::var(&name).map_err(|_| format!("environment variable {name} is not set"))
}

/// Parses `.env` text: `KEY=value`, optional `export `, quotes around the value, `#` comment lines.
fn dotenv_value(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        let (key, value) = line.split_once('=')?;
        if key.trim() != name {
            return None;
        }
        let value = value.trim();
        let quoted = value.len() >= 2
            && (value.starts_with('"') && value.ends_with('"') || value.starts_with('\'') && value.ends_with('\''));
        Some(if quoted { value[1..value.len() - 1].to_string() } else { value.to_string() })
    })
}

/// Value of `name` from the nearest `.env` file, looking in `folder` and then in its parents.
/// Only the requested key leaves Rust.
#[tauri::command]
pub fn http_dotenv(folder: String, name: String) -> Result<String, String> {
    if !name.starts_with(ENV_PREFIX) {
        return Err(format!("only keys starting with {ENV_PREFIX} can be read"));
    }
    let start = std::path::Path::new(&folder);
    if !start.is_absolute() {
        return Err("save the document first: .env is looked up next to it".to_string());
    }
    // the parents of an allowed folder are never sensitive folders, so checking the start is enough
    crate::check_folder(&folder)?;
    for dir in start.ancestors().take(DOTENV_LEVELS) {
        if let Ok(text) = std::fs::read_to_string(dir.join(".env")) {
            if let Some(value) = dotenv_value(&text, &name) {
                return Ok(value);
            }
        }
    }
    Err(format!("{name} not found in any .env from {folder} upwards"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_url_accepts_only_http_and_https() {
        assert!(parse_request_url("https://example.com/a?b=1").is_ok());
        assert!(parse_request_url(" http://127.0.0.1:8080 ").is_ok());
        assert!(parse_request_url("file:///etc/passwd").is_err());
        assert!(parse_request_url("ftp://example.com").is_err());
        assert!(parse_request_url("example.com").is_err());
    }

    #[test]
    fn dotenv_reads_plain_quoted_and_exported_values() {
        let text = "# comment\nA=1\nexport B = \"two words\"\nC='x'\nD=a=b\n";
        assert_eq!(dotenv_value(text, "A").as_deref(), Some("1"));
        assert_eq!(dotenv_value(text, "B").as_deref(), Some("two words"));
        assert_eq!(dotenv_value(text, "C").as_deref(), Some("x"));
        assert_eq!(dotenv_value(text, "D").as_deref(), Some("a=b"));
        assert_eq!(dotenv_value(text, "E"), None);
    }

    #[test]
    fn redirects_stay_on_the_same_host_and_scheme() {
        let url = |text: &str| reqwest::Url::parse(text).unwrap();
        let first = url("https://example.com/a");
        assert!(redirect_allowed(&first, &url("https://example.com/b")));
        assert!(!redirect_allowed(&first, &url("https://evil.example/b")));
        assert!(!redirect_allowed(&first, &url("http://example.com/b")));
        assert!(!redirect_allowed(&first, &url("https://example.com:8443/b")));
        assert!(redirect_allowed(&url("http://example.com/a"), &url("https://example.com/b")));
        assert!(!redirect_allowed(&url("http://example.com:8080/a"), &url("https://example.com/b")));
    }

    #[test]
    fn dotenv_is_limited_to_the_prefix() {
        assert!(http_dotenv("/".into(), "DB_PASSWORD".into()).is_err());
        assert!(http_dotenv("/".into(), "APP_KEY".into()).unwrap_err().contains("SNIB_"));
    }

    #[test]
    fn process_env_is_limited_to_the_prefix() {
        assert!(http_process_env("HOME".into()).is_err());
        assert!(http_process_env("SNIB_SURELY_NOT_SET_12345".into()).is_err());
    }
}
