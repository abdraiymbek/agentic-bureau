#![cfg(unix)]

use std::sync::Arc;

use simple_directory_engine::api::types::{GetVaultInfoRequest, OpenVaultRequest, ScanStatus};
use simple_directory_engine::commands::vault;
use simple_directory_engine::events::NoopEventSink;
use simple_directory_engine::state::AppState;
use simple_directory_ipc::{client_send, handle_connection, Command, Request, Response};
use tokio::net::UnixListener;

static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

async fn open_scanned(dir: &std::path::Path) -> (AppState, String) {
    let state = AppState::new();
    let opened = simple_directory_engine::compose::open_vault(
        &state,
        Arc::new(NoopEventSink),
        OpenVaultRequest {
            path: dir.to_path_buf(),
        },
        None,
    )
    .await
    .unwrap();
    loop {
        let info = vault::get_vault_info(
            &state,
            GetVaultInfoRequest {
                vault_id: opened.vault_id.clone(),
            },
        )
        .await
        .unwrap();
        if matches!(info.scan_status, ScanStatus::Complete) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    (state, opened.vault_id)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn socket_new_note_creates_a_file_via_dispatch() {
    let _env = ENV_GUARD.lock().unwrap();
    let rt = tempfile::tempdir().unwrap();
    std::env::set_var("SIMPLE_DIRECTORY_RUNTIME_DIR", rt.path());
    let vault_dir = tempfile::tempdir().unwrap();
    let (state, _vault_id) = open_scanned(vault_dir.path()).await;

    let sock = rt.path().join("test.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        handle_connection(stream, &state, &NoopEventSink)
            .await
            .unwrap();
    });

    let canonical = std::fs::canonicalize(vault_dir.path()).unwrap();
    let resp = client_send(
        &sock,
        &Request {
            vault_path: canonical,
            command: Command::NewNote {
                at: Some("FromSocket.md".into()),
                parent: None,
            },
        },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert_eq!(
        resp,
        Response::Ok(simple_directory_ipc::Outcome::Created(
            "FromSocket.md".into()
        ))
    );
    assert!(vault_dir.path().join("FromSocket.md").exists());
    std::env::remove_var("SIMPLE_DIRECTORY_RUNTIME_DIR");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn socket_unknown_vault_returns_err() {
    let _env = ENV_GUARD.lock().unwrap();
    let rt = tempfile::tempdir().unwrap();
    std::env::set_var("SIMPLE_DIRECTORY_RUNTIME_DIR", rt.path());
    let state = AppState::new();

    let sock = rt.path().join("test2.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        handle_connection(stream, &state, &NoopEventSink)
            .await
            .unwrap();
    });

    let resp = client_send(
        &sock,
        &Request {
            vault_path: "/nope".into(),
            command: Command::List,
        },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert!(matches!(resp, Response::Err(_)));
    std::env::remove_var("SIMPLE_DIRECTORY_RUNTIME_DIR");
}

#[tokio::test]
async fn socket_declines_while_the_vault_is_still_scanning() {
    use simple_directory_engine::state::{OpenVault, ScanStatusBackend};

    let vault_dir = tempfile::tempdir().unwrap();
    let vault = simple_directory_core::Vault::open(vault_dir.path())
        .await
        .unwrap();
    let state = AppState::new();
    state.vaults().write().await.insert(
        "scanning".to_string(),
        OpenVault::new(
            vault.clone(),
            simple_directory_engine::search_handle::SearchHandle::open(&vault).await,
            tokio_util::sync::CancellationToken::new(),
            ScanStatusBackend::InProgress,
            None,
            simple_directory_core::vault::settings::SettingsMap::new(),
        ),
    );

    let sock_dir = tempfile::tempdir().unwrap();
    let sock = sock_dir.path().join("scanning.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        handle_connection(stream, &state, &NoopEventSink)
            .await
            .unwrap();
    });

    let canonical = std::fs::canonicalize(vault_dir.path()).unwrap();
    let resp = client_send(
        &sock,
        &Request {
            vault_path: canonical,
            command: Command::List,
        },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert_eq!(resp, Response::Err("vault is still scanning".to_string()));
}
