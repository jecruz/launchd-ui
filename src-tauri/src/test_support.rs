//! Thread-local discovery fixtures for native IPC tests; excluded from app builds.
use std::cell::RefCell;
use std::path::PathBuf;

thread_local! {
    static PATHS: RefCell<Option<(PathBuf, PathBuf)>> = const { RefCell::new(None) };
}

/// Return this test thread's catalog and state roots, if a fixture is active.
pub(crate) fn paths() -> Option<(PathBuf, PathBuf)> {
    PATHS.with(|paths| paths.borrow().clone())
}

/// Scope native discovery to isolated paths and restore it even if a test panics.
pub(crate) fn with_paths<T>(catalog: PathBuf, state: PathBuf, test: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            PATHS.with(|paths| *paths.borrow_mut() = None);
        }
    }
    PATHS.with(|paths| {
        assert!(paths.borrow().is_none(), "nested native fixture");
        *paths.borrow_mut() = Some((catalog, state));
    });
    let _reset = Reset;
    test()
}
