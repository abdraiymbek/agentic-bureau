use std::sync::Arc;

use simple_directory_core::Vault;

use crate::error::SimpleDirectoryError;
use crate::plugins::{ensure_active, Feature};
use crate::state::{AppState, OpenVault};

pub(crate) async fn with_open_vault<T, F>(
    state: &AppState,
    vault_id: &str,
    take: F,
) -> Result<T, SimpleDirectoryError>
where
    F: FnOnce(&OpenVault) -> T,
{
    let guard = state.vaults().read().await;
    let open = guard
        .get(vault_id)
        .ok_or_else(|| SimpleDirectoryError::VaultNotOpen(vault_id.to_string()))?;
    Ok(take(open))
}

pub(crate) async fn open_vault_cloned(
    state: &AppState,
    vault_id: &str,
) -> Result<Vault, SimpleDirectoryError> {
    with_open_vault(state, vault_id, |open| open.vault.clone()).await
}

pub(crate) async fn open_vault_cloned_for(
    state: &AppState,
    vault_id: &str,
    feature: Feature,
) -> Result<Vault, SimpleDirectoryError> {
    let (vault, settings) = with_open_vault(state, vault_id, |open| {
        (open.vault.clone(), Arc::clone(&open.settings))
    })
    .await?;
    ensure_active(&settings, feature).await?;
    Ok(vault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ScanStatusBackend;
    use tokio_util::sync::CancellationToken;

    async fn state_with_vault(vault_id: &str) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault.clone(),
                crate::search_handle::SearchHandle::open(&vault).await,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                simple_directory_core::vault::settings::SettingsMap::new(),
            ),
        );
        (dir, state)
    }

    #[tokio::test]
    async fn an_unknown_vault_id_is_vault_not_open() {
        let (_dir, state) = state_with_vault("v1").await;
        let err = open_vault_cloned(&state, "ghost")
            .await
            .expect_err("unknown vault");
        assert!(matches!(err, SimpleDirectoryError::VaultNotOpen(v) if v == "ghost"));
    }

    #[tokio::test]
    async fn the_read_guard_is_released_before_the_caller_resumes() {
        let (_dir, state) = state_with_vault("v1").await;
        let vault = open_vault_cloned(&state, "v1").await.expect("cloned");
        state.vaults().write().await.insert(
            "v2".into(),
            OpenVault::new(
                vault.clone(),
                crate::search_handle::SearchHandle::open(&vault).await,
                CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                simple_directory_core::vault::settings::SettingsMap::new(),
            ),
        );
        assert_eq!(state.vaults().read().await.len(), 2);
    }
}
