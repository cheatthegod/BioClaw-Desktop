//! In-process tests for the session routes + the SaaS proxy, using a local
//! mock upstream so they're deterministic and need no network.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::{any, get},
    Router,
};
use tower::ServiceExt; // oneshot

use crate::saas::SaasClient;

/// Build a minimal router exposing just the session + proxy routes against a
/// given SaaS base, with a fresh AppState-like wrapper. We can't easily build
/// the full AppState in a unit test (it touches the filesystem), so the proxy
/// handler reads `state.saas` — we construct an `AppState` with a temp dir.
// Serialize the env-var dance: AppState::new reads BIOCLAW_SAAS_BASE, and
// several tests set it to different values — without this they race.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn test_state(base: &str) -> Arc<crate::server::AppState> {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("BIOCLAW_SAAS_BASE", base);
    let tmp = std::env::temp_dir().join(format!(
        "bioclaw-saas-test-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let opts = crate::cli::ServeOptions {
        host: "127.0.0.1".into(),
        port: 0,
        resource_dir: None,
        env_dir: Some(tmp),
        workspace: "saas-test".into(),
    };
    Arc::new(crate::server::AppState::new(&opts).unwrap())
}

fn router(state: Arc<crate::server::AppState>) -> Router {
    Router::new()
        .route(
            "/auth/session",
            get(crate::saas::routes::get_session)
                .post(crate::saas::routes::set_session)
                .delete(crate::saas::routes::clear_session),
        )
        .route("/saas/*path", any(crate::saas::routes::proxy))
        .route("/saas-files/*path", any(crate::saas::routes::proxy_files))
        .with_state(state)
}

async fn body_string(resp: axum::response::Response) -> (StatusCode, String) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn session_set_get_clear_roundtrip() {
    let state = test_state("http://127.0.0.1:1"); // base unused here
    let app = router(state);

    // initially unauthenticated
    let r = app
        .clone()
        .oneshot(Request::get("/auth/session").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (_s, b) = body_string(r).await;
    assert!(b.contains("\"authenticated\":false"), "got {b}");

    // set token
    let r = app
        .clone()
        .oneshot(
            Request::post("/auth/session")
                .header("content-type", "application/json")
                .body(Body::from("{\"token\":\"abc123\"}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    // now authenticated
    let r = app
        .clone()
        .oneshot(Request::get("/auth/session").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (_s, b) = body_string(r).await;
    assert!(b.contains("\"authenticated\":true"), "got {b}");

    // empty token rejected
    let r = app
        .clone()
        .oneshot(
            Request::post("/auth/session")
                .header("content-type", "application/json")
                .body(Body::from("{\"token\":\"\"}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);

    // clear
    let r = app
        .clone()
        .oneshot(
            Request::delete("/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = app
        .oneshot(Request::get("/auth/session").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (_s, b) = body_string(r).await;
    assert!(b.contains("\"authenticated\":false"), "got {b}");
}

#[test]
fn saas_client_cookie_and_base() {
    // Use with_base() (not new()) so this doesn't race other tests on the
    // shared process env var BIOCLAW_SAAS_BASE.
    let c = SaasClient::with_base("http://example.test:3000/");
    assert_eq!(c.base(), "http://example.test:3000"); // trailing slash trimmed
    assert!(c.cookie_header().is_none());
    c.set_token("tok".into());
    assert_eq!(c.cookie_header().unwrap(), "bioclaw_session=tok");
    assert!(c.is_authenticated());
    c.clear_token();
    assert!(!c.is_authenticated());
}

// Proxy forwarding + cookie attach + 401 mapping, against a local mock
// upstream spun up on an ephemeral port.
#[tokio::test]
async fn proxy_forwards_attaches_cookie_and_maps_401() {
    use std::sync::Mutex;

    // shared capture of what the upstream saw
    #[derive(Default)]
    struct Seen {
        cookie: Option<String>,
        path: Option<String>,
    }
    let seen = Arc::new(Mutex::new(Seen::default()));

    // mock upstream: /api/gpu/tools echoes a tool list and records the cookie;
    // /api/secret returns 401.
    let seen_c = seen.clone();
    let upstream = Router::new()
        .route(
            "/api/gpu/tools",
            get(move |headers: axum::http::HeaderMap| {
                let seen = seen_c.clone();
                async move {
                    let mut g = seen.lock().unwrap();
                    g.cookie = headers
                        .get("cookie")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from);
                    g.path = Some("/api/gpu/tools".into());
                    axum::Json(serde_json::json!({"tools":[{"id":"x"}],"count":1}))
                }
            }),
        )
        .route(
            "/api/secret",
            get(|| async { (StatusCode::UNAUTHORIZED, "nope") }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let state = test_state(&base);
    state.saas.set_token("sekret".into());
    let app = router(state);

    // proxied GET /saas/gpu/tools → upstream /api/gpu/tools, cookie attached
    let r = app
        .clone()
        .oneshot(Request::get("/saas/gpu/tools").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (status, body) = body_string(r).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"count\":1"), "got {body}");
    {
        let g = seen.lock().unwrap();
        assert_eq!(g.path.as_deref(), Some("/api/gpu/tools"));
        assert_eq!(g.cookie.as_deref(), Some("bioclaw_session=sekret"));
    }

    // 401 from upstream → typed auth error
    let r = app
        .oneshot(Request::get("/saas/secret").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (status, body) = body_string(r).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.contains("\"error\":\"auth\""), "got {body}");
}

// The `/saas-files` sibling forwards to the top-level `/files/…` route (NOT
// `/api/…`) with the cookie attached — the path GPU output downloads take.
#[tokio::test]
async fn files_proxy_forwards_to_files_prefix_with_cookie() {
    use std::sync::Mutex;

    let seen: Arc<Mutex<(Option<String>, Option<String>)>> = Arc::new(Mutex::new((None, None)));
    let seen_c = seen.clone();
    let upstream = Router::new().route(
        "/files/chat/jid/uploads/gpu-1/output/x.fasta",
        get(move |headers: axum::http::HeaderMap| {
            let seen = seen_c.clone();
            async move {
                let mut g = seen.lock().unwrap();
                g.0 = Some("/files/chat/jid/uploads/gpu-1/output/x.fasta".into());
                g.1 = headers
                    .get("cookie")
                    .and_then(|v| v.to_str().ok())
                    .map(String::from);
                ">seq\nACGU\n"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let state = test_state(&base);
    state.saas.set_token("filetok".into());
    let app = router(state);

    let r = app
        .oneshot(
            Request::get("/saas-files/chat/jid/uploads/gpu-1/output/x.fasta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, body) = body_string(r).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("ACGU"), "got {body}");
    let g = seen.lock().unwrap();
    assert_eq!(
        g.0.as_deref(),
        Some("/files/chat/jid/uploads/gpu-1/output/x.fasta")
    );
    assert_eq!(g.1.as_deref(), Some("bioclaw_session=filetok"));
}
