//! One transaction per mutation. A mutation that reads, decides and writes in
//! several steps either commits all of them or none, and takes the write lock
//! up front so a render worker's connection cannot slip a commit in between.

use crate::{internal, CoreResult};
use omenflow_storage::ProjectHandle;
use rusqlite::Connection;

struct Scope<'a> {
    db: &'a Connection,
    nested: bool,
    open: bool,
}

impl<'a> Scope<'a> {
    fn begin(db: &'a Connection) -> CoreResult<Self> {
        let nested = !db.is_autocommit();
        db.execute_batch(if nested {
            "SAVEPOINT omenflow_step"
        } else {
            "BEGIN IMMEDIATE"
        })
        .map_err(internal)?;
        Ok(Self {
            db,
            nested,
            open: true,
        })
    }

    fn commit(mut self) -> CoreResult<()> {
        self.db
            .execute_batch(if self.nested {
                "RELEASE omenflow_step"
            } else {
                "COMMIT"
            })
            .map_err(internal)?;
        self.open = false;
        Ok(())
    }
}

impl Drop for Scope<'_> {
    fn drop(&mut self) {
        if self.open {
            let _ = self.db.execute_batch(if self.nested {
                "ROLLBACK TO omenflow_step; RELEASE omenflow_step"
            } else {
                "ROLLBACK"
            });
        }
    }
}

/// Runs `work` as one unit on the project's connection. The outermost call is
/// an IMMEDIATE transaction; a call made inside another is a savepoint, so a
/// failed step undoes only itself and the caller decides what happens to the
/// rest. An error or a panic rolls the unit back.
pub(crate) fn atomically<T>(
    handle: &ProjectHandle,
    work: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
    let scope = Scope::begin(&handle.db)?;
    let value = work()?;
    scope.commit()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omenflow_contracts::ContractError;

    fn project() -> (tempfile::TempDir, ProjectHandle) {
        let temp = tempfile::tempdir().unwrap();
        let handle = ProjectHandle::create(temp.path().join("project"), "Txn", "test").unwrap();
        (temp, handle)
    }

    fn set_intent(handle: &ProjectHandle, intent: &str) -> CoreResult<()> {
        handle
            .db
            .execute("UPDATE project SET intent=?1", [intent])
            .map(|_| ())
            .map_err(internal)
    }

    fn intent(handle: &ProjectHandle) -> String {
        handle.project().unwrap().unwrap()["intent"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn a_failed_unit_leaves_nothing_behind_and_the_connection_usable() {
        let (_temp, handle) = project();
        let failed: CoreResult<()> = atomically(&handle, || {
            set_intent(&handle, "half done")?;
            Err(ContractError::validation("stop"))
        });
        assert_eq!(failed.unwrap_err().code, "VALIDATION");
        assert_eq!(intent(&handle), "test");
        assert!(handle.db.is_autocommit());
        atomically(&handle, || set_intent(&handle, "done")).unwrap();
        assert_eq!(intent(&handle), "done");
    }

    #[test]
    fn a_failed_inner_step_undoes_only_itself() {
        let (_temp, handle) = project();
        atomically(&handle, || {
            set_intent(&handle, "outer")?;
            let inner: CoreResult<()> = atomically(&handle, || {
                set_intent(&handle, "inner")?;
                Err(ContractError::validation("inner step failed"))
            });
            assert!(inner.is_err());
            assert!(!handle.db.is_autocommit());
            Ok(())
        })
        .unwrap();
        assert_eq!(intent(&handle), "outer");
    }

    #[test]
    fn a_panic_inside_a_unit_rolls_it_back() {
        let (_temp, handle) = project();
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: CoreResult<()> = atomically(&handle, || {
                set_intent(&handle, "before panic")?;
                panic!("mid-mutation");
            });
        }));
        assert!(unwound.is_err());
        assert!(handle.db.is_autocommit());
        assert_eq!(intent(&handle), "test");
    }
}
