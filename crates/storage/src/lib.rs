//! Schema-1 Bureau project storage. The Rust port opens existing project
//! folders and databases; it does not translate them into a new format.

mod db;
mod objects;
mod paths;

pub use db::{adopt_pre_rename_layout, read_project_marker, ProjectFile, ProjectHandle};
pub use objects::{sha256_hex, ObjectStore};
pub use paths::{
    canonicalize, resolve_materialization_path, resolve_project_path, write_materialized_file,
};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{message}")]
    Domain { code: &'static str, message: String },
}

impl StorageError {
    pub fn domain(code: &'static str, message: impl Into<String>) -> Self {
        Self::Domain {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Domain { code, .. } => code,
            Self::Io(_) | Self::Sqlite(_) | Self::Json(_) => "INTERNAL",
        }
    }
}
