#![forbid(unsafe_code)]

mod agent_instructions;
mod agents;
mod graph;
mod recent_vaults;
mod tab_sessions;
mod tauri_sink;
mod terminal;

use simple_directory_engine::api::types::{
    CancelVaultScanRequest, CloseVaultRequest, CreateFileAtPathRequest, CreateFileAtPathResponse,
    CreateFileRequest, CreateFileResponse, CreateFolderRequest, CreateFolderResponse,
    DeletePathRequest, FlushPendingRewritesForTargetRequest, FlushPendingRewritesRequest,
    FlushPendingRewritesResponse, GetBacklinksRequest, GetBacklinksResponse,
    GetCanonicalAstRequest, GetCanonicalAstResponse, GetFrontmatterRequest, GetFrontmatterResponse,
    GetPendingRewritesBreakdownRequest, GetPendingRewritesBreakdownResponse,
    GetPendingRewritesCountRequest, GetPendingRewritesCountResponse, GetSettingRequest,
    GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse, ListFilesRequest,
    ListFilesResponse, ListRecentRenameOpsRequest, ListRecentRenameOpsResponse,
    ListTagAssignmentsRequest, ListTagAssignmentsResponse, ListTagsRequest, ListTagsResponse,
    OpenVaultRequest, OpenVaultResponse, QueryTagPageRequest, QueryTagPageResponse,
    ReadFileBytesRequest, ReadFileBytesResponse, ReadFileTextRequest, ReadFileTextResponse,
    ReloadSettingsRequest, ReloadSettingsResponse, RenameBlockIdRequest, RenameBlockIdResponse,
    RenameFileRequest, RenameFileResponse, RenameFolderRequest, RenameFolderResponse,
    RenameTagRequest, RenameTagResponse, ResolveLinkRequest, ResolveLinkResponse,
    SetSettingRequest, SetSettingResponse, UndoRenameRequest, UndoRenameResponse,
    WriteFileTextRequest, WriteFileTextResponse,
};
use simple_directory_engine::commands;
use simple_directory_engine::commands::{
    autocomplete::{
        BlockIdAutocompleteRequest, BlockIdAutocompleteResponse, LinkAutocompleteRequest,
        LinkAutocompleteResponse, TagAutocompleteRequest, TagAutocompleteResponse,
    },
    blocks::{
        CreateBlockRefRequest, CreateBlockRefResponse, GetBrokenBlockRefsRequest,
        GetBrokenBlockRefsResponse,
    },
    dataview::{DataviewQueryRequest, DataviewResult},
    embeds::{GetEmbedRequest, GetEmbedResponse},
    integrity::{
        ListDanglingLinksRequest, ListDanglingLinksResponse, RepairDanglingLinkRequest,
        RepairDanglingLinkResponse,
    },
    property_ref::{GetPropertyRequest, GetPropertyResponse},
    search::{
        SearchHealthDto, SearchIndexStatusDto, SearchRequest, SearchResponse, SearchVaultRequest,
    },
};
use simple_directory_engine::error::SimpleDirectoryError;
use simple_directory_engine::state::AppState;
use tauri::Manager;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

fn init_logging() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    tracing::info!("simple.directory starting (Layer 0 bedrock)");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .manage(terminal::TerminalRegistry::default())
        .manage(agents::AgentRegistry::default())
        .manage(simple_directory_engine::commands::graph::LayoutRegistry::new())
        .setup(|_app| {
            #[cfg(unix)]
            {
                let handle = _app.handle().clone();
                let sock = simple_directory_ipc::app_socket_path(std::process::id());
                match bind_socket(&sock) {
                    Ok(listener) => {
                        let _ = BOUND_SOCKET.set(sock.clone());
                        tracing::info!("simple-directory-ipc socket listening at {}", sock.display());
                        tauri::async_runtime::spawn(async move {
                            serve_socket(handle, listener).await;
                        });
                    }
                    Err(e) => {
                        tracing::warn!(
                            "simple-directory-ipc socket unavailable at {}: {e} — the CLI will not attach",
                            sock.display()
                        );
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            list_recent_vaults,
            remove_recent_vault,
            load_tab_session,
            save_tab_session,
            cancel_vault_scan,
            get_vault_info,
            list_files,
            create_file,
            create_file_at_path,
            create_folder,
            delete_path,
            get_frontmatter,
            read_file_text,
            read_file_bytes,
            write_file_text,
            get_setting,
            set_setting,
            get_canonical_ast,
            resolve_link,
            get_embed,
            get_property,
            get_unlinked_mentions,
            link_mention,
            get_backlinks,
            query_tag_page,
            list_tag_assignments,
            link_autocomplete,
            tag_autocomplete,
            list_tags,
            block_id_autocomplete,
            create_block_ref,
            get_broken_block_refs,
            rename_file,
            rename_folder,
            rename_tag,
            rename_block_id,
            flush_pending_rewrites,
            flush_pending_rewrites_for_target,
            get_pending_rewrites_count,
            get_pending_rewrites_breakdown,
            list_recent_rename_ops,
            undo_rename,
            list_dangling_links,
            repair_dangling_link,
            search,
            search_index_status,
            search_rebuild_index,
            search_get_health,
            dataview_query,
            reload_settings,
            close_vault,
            projects_list,
            project_overview,
            project_create,
            project_update,
            project_set_task,
            project_add_task,
            calendar_items,
            event_create,
            event_update,
            event_delete,
            graph::graph_snapshot,
            graph::graph_layout,
            graph::graph_layout_cancel,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_busy,
            terminal::terminal_close,
            terminal::terminal_reap_all,
            agents::agents_detect,
            agents::agent_open,
            agents::agent_changes,
            agents::agent_diff,
            agents::agent_close,
            agent_instructions::agent_instructions_status,
            agent_instructions::agent_instructions_accept,
            agent_instructions::agent_instructions_decline,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            if matches!(_event, tauri::RunEvent::Exit) {
                terminal::reap_all_blocking(&_app.state::<terminal::TerminalRegistry>());
                _app.state::<simple_directory_engine::commands::graph::LayoutRegistry>()
                    .cancel_all();
                #[cfg(unix)]
                remove_bound_socket();
            }
        });
}

#[cfg(unix)]
static BOUND_SOCKET: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[cfg(unix)]
fn advertised_socket_path() -> Option<String> {
    BOUND_SOCKET.get().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn advertised_socket_path() -> Option<String> {
    None
}

#[cfg(unix)]
fn remove_bound_socket() {
    if let Some(sock) = BOUND_SOCKET.get() {
        if let Err(e) = std::fs::remove_file(sock) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("could not remove {}: {e}", sock.display());
            }
        }
    }
}

#[cfg(unix)]
fn bind_socket(sock: &std::path::Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(parent) = sock.parent() {
        std::fs::create_dir_all(parent)?;
        if let Err(e) = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)) {
            tracing::warn!("could not restrict {}: {e}", parent.display());
        }
    }
    if let Err(e) = std::fs::remove_file(sock) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("could not clear stale socket {}: {e}", sock.display());
        }
    }
    let listener = std::os::unix::net::UnixListener::bind(sock)?;
    std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

#[cfg(unix)]
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

#[cfg(unix)]
async fn serve_socket(app: tauri::AppHandle, listener: std::os::unix::net::UnixListener) {
    use tauri::Manager;

    let listener = match tokio::net::UnixListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("simple-directory-ipc socket could not join the runtime: {e}");
            return;
        }
    };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                tracing::warn!("simple-directory-ipc accept failed: {e}");
                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                continue;
            }
        };
        let state = app.state::<AppState>();
        let sink = crate::tauri_sink::TauriEventSink::new(app.clone());
        let served = std::panic::AssertUnwindSafe(simple_directory_ipc::handle_connection(
            stream,
            state.inner(),
            &sink,
        ));
        match futures_util::FutureExt::catch_unwind(served).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("simple-directory-ipc connection error: {e}"),
            Err(_) => tracing::error!("simple-directory-ipc connection handler panicked"),
        }
    }
}

#[tauri::command]
async fn open_vault(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, SimpleDirectoryError> {
    let vault_path = req.path.to_string_lossy().to_string();
    let resp = simple_directory_engine::compose::open_vault(
        state.inner(),
        std::sync::Arc::new(crate::tauri_sink::TauriEventSink::new(app.clone())),
        req,
        advertised_socket_path(),
    )
    .await?;
    if let Some(store) = recent_vaults_store(&app) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        recent_vaults::record(&store, &vault_path, now);
    }
    Ok(resp)
}

fn recent_vaults_store(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("recent_vaults.json"))
}

#[tauri::command]
fn list_recent_vaults(app: tauri::AppHandle) -> recent_vaults::ListRecentVaultsResponse {
    let vaults = recent_vaults_store(&app)
        .map(|p| recent_vaults::list_with_existence(&p))
        .unwrap_or_default();
    recent_vaults::ListRecentVaultsResponse { vaults }
}

#[tauri::command]
fn remove_recent_vault(app: tauri::AppHandle, req: recent_vaults::RemoveRecentVaultRequest) {
    if let Some(p) = recent_vaults_store(&app) {
        recent_vaults::remove(&p, &req.path);
    }
}

fn tab_sessions_store(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("tab_sessions.json"))
}

#[tauri::command]
fn load_tab_session(app: tauri::AppHandle, vault_path: String) -> tab_sessions::TabSession {
    tab_sessions_store(&app)
        .map(|p| tab_sessions::load(&p, &vault_path))
        .unwrap_or_default()
}

#[tauri::command]
fn save_tab_session(app: tauri::AppHandle, vault_path: String, session: tab_sessions::TabSession) {
    if let Some(p) = tab_sessions_store(&app) {
        tab_sessions::save(&p, &vault_path, &session);
    }
}

#[tauri::command]
async fn cancel_vault_scan(
    state: tauri::State<'_, AppState>,
    req: CancelVaultScanRequest,
) -> Result<(), SimpleDirectoryError> {
    commands::vault::cancel_vault_scan(state.inner(), req).await
}

#[tauri::command]
async fn get_vault_info(
    state: tauri::State<'_, AppState>,
    req: GetVaultInfoRequest,
) -> Result<GetVaultInfoResponse, SimpleDirectoryError> {
    commands::vault::get_vault_info(state.inner(), req).await
}

#[tauri::command]
async fn list_files(
    state: tauri::State<'_, AppState>,
    req: ListFilesRequest,
) -> Result<ListFilesResponse, SimpleDirectoryError> {
    commands::vault::list_files(state.inner(), req).await
}

#[tauri::command]
async fn create_file(
    state: tauri::State<'_, AppState>,
    req: CreateFileRequest,
) -> Result<CreateFileResponse, SimpleDirectoryError> {
    commands::vault::create_file(state.inner(), req).await
}

#[tauri::command]
async fn create_file_at_path(
    state: tauri::State<'_, AppState>,
    req: CreateFileAtPathRequest,
) -> Result<CreateFileAtPathResponse, SimpleDirectoryError> {
    commands::vault::create_file_at_path(state.inner(), req).await
}

#[tauri::command]
async fn create_folder(
    state: tauri::State<'_, AppState>,
    req: CreateFolderRequest,
) -> Result<CreateFolderResponse, SimpleDirectoryError> {
    commands::vault::create_folder(state.inner(), req).await
}

#[tauri::command]
async fn delete_path(
    state: tauri::State<'_, AppState>,
    req: DeletePathRequest,
) -> Result<(), SimpleDirectoryError> {
    commands::vault::delete_path(state.inner(), req).await
}

#[tauri::command]
async fn get_frontmatter(
    state: tauri::State<'_, AppState>,
    req: GetFrontmatterRequest,
) -> Result<GetFrontmatterResponse, SimpleDirectoryError> {
    commands::vault::get_frontmatter(state.inner(), req).await
}

#[tauri::command]
async fn read_file_text(
    state: tauri::State<'_, AppState>,
    req: ReadFileTextRequest,
) -> Result<ReadFileTextResponse, SimpleDirectoryError> {
    commands::vault::read_file_text(state.inner(), req).await
}

#[tauri::command]
async fn read_file_bytes(
    state: tauri::State<'_, AppState>,
    req: ReadFileBytesRequest,
) -> Result<ReadFileBytesResponse, SimpleDirectoryError> {
    commands::vault::read_file_bytes(state.inner(), req).await
}

#[tauri::command]
async fn write_file_text(
    state: tauri::State<'_, AppState>,
    req: WriteFileTextRequest,
) -> Result<WriteFileTextResponse, SimpleDirectoryError> {
    commands::vault::write_file_text(state.inner(), req).await
}

#[tauri::command]
async fn get_setting(
    state: tauri::State<'_, AppState>,
    req: GetSettingRequest,
) -> Result<GetSettingResponse, SimpleDirectoryError> {
    commands::vault::get_setting(state.inner(), req).await
}

#[tauri::command]
async fn set_setting(
    state: tauri::State<'_, AppState>,
    req: SetSettingRequest,
) -> Result<SetSettingResponse, SimpleDirectoryError> {
    commands::vault::set_setting(state.inner(), req).await
}

#[tauri::command]
async fn get_canonical_ast(
    state: tauri::State<'_, AppState>,
    req: GetCanonicalAstRequest,
) -> Result<GetCanonicalAstResponse, SimpleDirectoryError> {
    commands::vault::get_canonical_ast(state.inner(), req).await
}

#[tauri::command]
async fn resolve_link(
    state: tauri::State<'_, AppState>,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, SimpleDirectoryError> {
    commands::links::resolve_link(state.inner(), req).await
}

#[tauri::command]
async fn get_embed(
    state: tauri::State<'_, AppState>,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, SimpleDirectoryError> {
    commands::embeds::get_embed(state.inner(), req).await
}

#[tauri::command]
async fn get_property(
    state: tauri::State<'_, AppState>,
    req: GetPropertyRequest,
) -> Result<GetPropertyResponse, SimpleDirectoryError> {
    commands::property_ref::get_property(state.inner(), req).await
}

#[tauri::command]
async fn get_unlinked_mentions(
    state: tauri::State<'_, AppState>,
    req: simple_directory_engine::api::types::GetUnlinkedMentionsRequest,
) -> Result<simple_directory_engine::api::types::GetUnlinkedMentionsResponse, SimpleDirectoryError>
{
    commands::mentions::get_unlinked_mentions(state.inner(), req).await
}

#[tauri::command]
async fn link_mention(
    state: tauri::State<'_, AppState>,
    req: simple_directory_engine::api::types::LinkMentionRequest,
) -> Result<simple_directory_engine::api::types::LinkMentionResponse, SimpleDirectoryError> {
    commands::mentions::link_mention(state.inner(), req).await
}

#[tauri::command]
async fn get_backlinks(
    state: tauri::State<'_, AppState>,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, SimpleDirectoryError> {
    commands::backlinks::get_backlinks(state.inner(), req).await
}

#[tauri::command]
async fn query_tag_page(
    state: tauri::State<'_, AppState>,
    req: QueryTagPageRequest,
) -> Result<QueryTagPageResponse, SimpleDirectoryError> {
    commands::tags::query_tag_page(state.inner(), req).await
}

#[tauri::command]
async fn link_autocomplete(
    state: tauri::State<'_, AppState>,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, SimpleDirectoryError> {
    commands::autocomplete::link_autocomplete(state.inner(), req).await
}

#[tauri::command]
async fn tag_autocomplete(
    state: tauri::State<'_, AppState>,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, SimpleDirectoryError> {
    commands::autocomplete::tag_autocomplete(state.inner(), req).await
}

#[tauri::command]
async fn list_tag_assignments(
    state: tauri::State<'_, AppState>,
    req: ListTagAssignmentsRequest,
) -> Result<ListTagAssignmentsResponse, SimpleDirectoryError> {
    commands::tags::list_tag_assignments(state.inner(), req).await
}

#[tauri::command]
async fn list_tags(
    state: tauri::State<'_, AppState>,
    req: ListTagsRequest,
) -> Result<ListTagsResponse, SimpleDirectoryError> {
    commands::tags::list_tags(state.inner(), req).await
}

#[tauri::command]
async fn block_id_autocomplete(
    state: tauri::State<'_, AppState>,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, SimpleDirectoryError> {
    commands::autocomplete::block_id_autocomplete(state.inner(), req).await
}

#[tauri::command]
async fn create_block_ref(
    state: tauri::State<'_, AppState>,
    req: CreateBlockRefRequest,
) -> Result<CreateBlockRefResponse, SimpleDirectoryError> {
    commands::blocks::create_block_ref(state.inner(), req).await
}

#[tauri::command]
async fn get_broken_block_refs(
    state: tauri::State<'_, AppState>,
    req: GetBrokenBlockRefsRequest,
) -> Result<GetBrokenBlockRefsResponse, SimpleDirectoryError> {
    commands::blocks::get_broken_block_refs(state.inner(), req).await
}

#[tauri::command]
async fn rename_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameFileRequest,
) -> Result<RenameFileResponse, SimpleDirectoryError> {
    commands::rename::rename_file(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn rename_folder(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameFolderRequest,
) -> Result<RenameFolderResponse, SimpleDirectoryError> {
    commands::rename::rename_folder(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn rename_tag(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameTagRequest,
) -> Result<RenameTagResponse, SimpleDirectoryError> {
    commands::rename::rename_tag(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn rename_block_id(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameBlockIdRequest,
) -> Result<RenameBlockIdResponse, SimpleDirectoryError> {
    commands::rename::rename_block_id(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn flush_pending_rewrites(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: FlushPendingRewritesRequest,
) -> Result<FlushPendingRewritesResponse, SimpleDirectoryError> {
    commands::rename::flush_pending_rewrites(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn flush_pending_rewrites_for_target(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: FlushPendingRewritesForTargetRequest,
) -> Result<FlushPendingRewritesResponse, SimpleDirectoryError> {
    commands::rename::flush_pending_rewrites_for_target(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn get_pending_rewrites_count(
    state: tauri::State<'_, AppState>,
    req: GetPendingRewritesCountRequest,
) -> Result<GetPendingRewritesCountResponse, SimpleDirectoryError> {
    commands::rename::get_pending_rewrites_count(state.inner(), req).await
}

#[tauri::command]
async fn get_pending_rewrites_breakdown(
    state: tauri::State<'_, AppState>,
    req: GetPendingRewritesBreakdownRequest,
) -> Result<GetPendingRewritesBreakdownResponse, SimpleDirectoryError> {
    commands::rename::get_pending_rewrites_breakdown(state.inner(), req).await
}

#[tauri::command]
async fn list_recent_rename_ops(
    state: tauri::State<'_, AppState>,
    req: ListRecentRenameOpsRequest,
) -> Result<ListRecentRenameOpsResponse, SimpleDirectoryError> {
    commands::rename::list_recent_rename_ops(state.inner(), req).await
}

#[tauri::command]
async fn undo_rename(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: UndoRenameRequest,
) -> Result<UndoRenameResponse, SimpleDirectoryError> {
    commands::rename::undo_rename(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn list_dangling_links(
    state: tauri::State<'_, AppState>,
    req: ListDanglingLinksRequest,
) -> Result<ListDanglingLinksResponse, SimpleDirectoryError> {
    commands::integrity::list_dangling_links(state.inner(), req).await
}

#[tauri::command]
async fn repair_dangling_link(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RepairDanglingLinkRequest,
) -> Result<RepairDanglingLinkResponse, SimpleDirectoryError> {
    commands::integrity::repair_dangling_link(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn search(
    state: tauri::State<'_, AppState>,
    req: SearchRequest,
) -> Result<SearchResponse, SimpleDirectoryError> {
    commands::search::search(state.inner(), req).await
}

#[tauri::command]
async fn search_index_status(
    state: tauri::State<'_, AppState>,
    req: SearchVaultRequest,
) -> Result<SearchIndexStatusDto, SimpleDirectoryError> {
    commands::search::search_index_status(state.inner(), req).await
}

#[tauri::command]
async fn search_rebuild_index(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: SearchVaultRequest,
) -> Result<(), SimpleDirectoryError> {
    commands::search::search_rebuild_index(
        state.inner(),
        std::sync::Arc::new(crate::tauri_sink::TauriEventSink::new(app)),
        req,
    )
    .await
}

#[tauri::command]
async fn search_get_health(
    state: tauri::State<'_, AppState>,
    req: SearchVaultRequest,
) -> Result<SearchHealthDto, SimpleDirectoryError> {
    commands::search::search_get_health(state.inner(), req).await
}

#[tauri::command]
async fn dataview_query(
    state: tauri::State<'_, AppState>,
    req: DataviewQueryRequest,
) -> Result<DataviewResult, SimpleDirectoryError> {
    commands::dataview::dataview_query(state.inner(), req).await
}

#[tauri::command]
async fn reload_settings(
    state: tauri::State<'_, AppState>,
    req: ReloadSettingsRequest,
) -> Result<ReloadSettingsResponse, SimpleDirectoryError> {
    commands::vault::reload_settings(state.inner(), req).await
}

#[tauri::command]
async fn close_vault(
    state: tauri::State<'_, AppState>,
    registry: tauri::State<'_, terminal::TerminalRegistry>,
    agents: tauri::State<'_, agents::AgentRegistry>,
    layouts: tauri::State<'_, simple_directory_engine::commands::graph::LayoutRegistry>,
    app: tauri::AppHandle,
    req: CloseVaultRequest,
) -> Result<(), SimpleDirectoryError> {
    layouts.cancel(&req.vault_id);
    agents.drain_vault(&req.vault_id);
    terminal::reap_vault(registry.inner(), &req.vault_id).await;
    commands::vault::close_vault(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn projects_list(
    state: tauri::State<'_, AppState>,
    req: commands::projects::ProjectsListRequest,
) -> Result<commands::projects::ProjectsListResponse, SimpleDirectoryError> {
    commands::projects::projects_list(state.inner(), req).await
}

#[tauri::command]
async fn project_overview(
    state: tauri::State<'_, AppState>,
    req: commands::projects::ProjectOverviewRequest,
) -> Result<commands::projects::ProjectOverviewResponse, SimpleDirectoryError> {
    commands::projects::project_overview(state.inner(), req).await
}

#[tauri::command]
async fn project_create(
    state: tauri::State<'_, AppState>,
    req: commands::projects::ProjectCreateRequest,
) -> Result<commands::projects::ProjectCreateResponse, SimpleDirectoryError> {
    commands::projects::project_create(state.inner(), req).await
}

#[tauri::command]
async fn project_update(
    state: tauri::State<'_, AppState>,
    req: commands::projects::ProjectUpdateRequest,
) -> Result<commands::projects::ProjectUpdateResponse, SimpleDirectoryError> {
    commands::projects::project_update(state.inner(), req).await
}

#[tauri::command]
async fn project_add_task(
    state: tauri::State<'_, AppState>,
    req: commands::projects::ProjectAddTaskRequest,
) -> Result<commands::projects::ProjectAddTaskResponse, SimpleDirectoryError> {
    commands::projects::project_add_task(state.inner(), req).await
}

#[tauri::command]
async fn project_set_task(
    state: tauri::State<'_, AppState>,
    req: commands::projects::ProjectSetTaskRequest,
) -> Result<commands::projects::ProjectSetTaskResponse, SimpleDirectoryError> {
    commands::projects::project_set_task(state.inner(), req).await
}

#[tauri::command]
async fn calendar_items(
    state: tauri::State<'_, AppState>,
    req: commands::calendar::CalendarItemsRequest,
) -> Result<commands::calendar::CalendarItemsResponse, SimpleDirectoryError> {
    commands::calendar::calendar_items(state.inner(), req).await
}

#[tauri::command]
async fn event_create(
    state: tauri::State<'_, AppState>,
    req: commands::calendar::EventCreateRequest,
) -> Result<commands::calendar::EventCreateResponse, SimpleDirectoryError> {
    commands::calendar::event_create(state.inner(), req).await
}

#[tauri::command]
async fn event_update(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: commands::calendar::EventUpdateRequest,
) -> Result<commands::calendar::EventUpdateResponse, SimpleDirectoryError> {
    commands::calendar::event_update(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn event_delete(
    state: tauri::State<'_, AppState>,
    req: commands::calendar::EventDeleteRequest,
) -> Result<(), SimpleDirectoryError> {
    commands::calendar::event_delete(state.inner(), req).await
}
