use bashkit::{
    Bash, ExecutionLimits, FileSystem, FsLimits, InMemoryFs, MountableFs, OverlayFs, PosixFs,
    RealFs, RealFsMode,
};
use napi_derive::napi;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const OUTPUT_LIMIT: usize = 1_000_000;

async fn filesystem(directory: &str) -> napi::Result<Arc<dyn FileSystem>> {
    let root = tokio::fs::canonicalize(directory)
        .await
        .map_err(native_error)?;
    if root != Path::new(directory) || !root.is_dir() || root.parent().is_none() {
        return Err(native_error(
            "mount root must be a canonical project directory",
        ));
    }
    // Compose explicitly: the 0.17.1 mount-at-path builder does not add OverlayFs.
    let lower = RealFs::open(&root, RealFsMode::ReadOnly)
        .await
        .map_err(native_error)?;
    if lower.root() != root {
        return Err(native_error("mount root changed during initialization"));
    }
    let overlay = Arc::new(OverlayFs::with_limits(
        Arc::new(PosixFs::new(lower)),
        FsLimits::default(),
    ));
    let mount = Arc::new(MountableFs::new(Arc::new(InMemoryFs::new())));
    mount
        .mount(Path::new("/workspace"), overlay)
        .map_err(native_error)?;
    mount
        .stat(Path::new("/workspace"))
        .await
        .map_err(native_error)?;
    Ok(mount)
}

fn native_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

fn shell(fs: Arc<dyn FileSystem>, cwd: &str, timeout: u32) -> Bash {
    Bash::builder()
        .fs(fs)
        .cwd(cwd)
        .env("HOME", "/workspace")
        .env("TMPDIR", "/tmp")
        .limits(
            ExecutionLimits::new()
                .timeout(Duration::from_millis(timeout.into()))
                .max_stdout_bytes(OUTPUT_LIMIT)
                .max_stderr_bytes(OUTPUT_LIMIT)
                .max_input_bytes(1_000_000)
                .max_commands(10_000)
                .max_loop_iterations(10_000),
        )
        .build()
}

#[napi(object)]
#[derive(Default)]
pub struct ExecutionResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub runtime_error: Option<String>,
}

#[napi]
pub struct Cancellation {
    cancelled: AtomicBool,
    token: Mutex<Option<Arc<AtomicBool>>>,
}

#[napi]
impl Cancellation {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            token: Mutex::new(None),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        let token = self.token.lock().expect("cancellation lock");
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(token) = token.as_ref() {
            token.store(true, Ordering::SeqCst);
        }
    }
}

#[napi]
pub struct Runtime {
    fs: tokio::sync::Mutex<Option<Arc<dyn FileSystem>>>,
    active: Mutex<Option<Arc<AtomicBool>>>,
    closed: AtomicBool,
}

#[napi]
impl Runtime {
    #[napi(factory)]
    pub async fn create(directory: String) -> napi::Result<Self> {
        Ok(Self {
            fs: tokio::sync::Mutex::new(Some(filesystem(&directory).await?)),
            active: Mutex::new(None),
            closed: AtomicBool::new(false),
        })
    }

    #[napi]
    pub async fn execute(
        &self,
        command: String,
        cwd: String,
        timeout: u32,
        cancellation: Option<&Cancellation>,
    ) -> napi::Result<ExecutionResult> {
        if timeout == 0 || timeout > 120_000 || !Path::new(&cwd).is_absolute() {
            return Err(native_error(
                "absolute virtual cwd and timeout of 1..120000ms required",
            ));
        }
        // This is the only execution queue. Disposal rejects queued calls.
        let fs = self.fs.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(native_error("runtime disposed"));
        }
        let shared = fs
            .as_ref()
            .ok_or_else(|| native_error("runtime disposed"))?;
        if !shared
            .stat(Path::new(&cwd))
            .await
            .map_err(native_error)?
            .file_type
            .is_dir()
        {
            return Err(native_error("workdir is not a directory"));
        }
        let mut bash = shell(Arc::clone(shared), &cwd, timeout);
        if let Some(cancellation) = cancellation {
            let mut token = cancellation.token.lock().map_err(native_error)?;
            if cancellation.cancelled.load(Ordering::SeqCst) {
                return Ok(ExecutionResult {
                    runtime_error: Some("execution cancelled".into()),
                    ..Default::default()
                });
            }
            *token = Some(bash.cancellation_token());
        }
        {
            let mut active = self.active.lock().map_err(native_error)?;
            if self.closed.load(Ordering::SeqCst) {
                return Err(native_error("runtime disposed"));
            }
            *active = Some(bash.cancellation_token());
        }
        let output = Arc::new(Mutex::new(ExecutionResult::default()));
        let capture = Arc::clone(&output);
        let result = bash
            .exec_streaming(
                &command,
                Box::new(move |stdout, stderr| {
                    let mut captured = capture.lock().expect("output lock");
                    for (text, is_stderr) in
                        [(stdout.to_string(), false), (stderr.to_string(), true)]
                    {
                        let (target, truncated) = if is_stderr {
                            let ExecutionResult {
                                stderr,
                                stderr_truncated,
                                ..
                            } = &mut *captured;
                            (stderr, stderr_truncated)
                        } else {
                            let ExecutionResult {
                                stdout,
                                stdout_truncated,
                                ..
                            } = &mut *captured;
                            (stdout, stdout_truncated)
                        };
                        let mut length = text.len().min(OUTPUT_LIMIT.saturating_sub(target.len()));
                        while !text.is_char_boundary(length) {
                            length -= 1;
                        }
                        target.push_str(&text[..length]);
                        *truncated |= length < text.len();
                    }
                }),
            )
            .await;
        *self.active.lock().map_err(native_error)? = None;
        let mut captured = output.lock().map_err(native_error)?;
        match result {
            Ok(result) => {
                captured.stdout = result.stdout.to_string();
                captured.stderr = result.stderr.to_string();
                captured.exit_code = Some(result.exit_code);
                captured.stdout_truncated |= result.stdout_truncated;
                captured.stderr_truncated |= result.stderr_truncated;
            }
            Err(error) => {
                if matches!(error, bashkit::Error::Internal(_)) {
                    self.closed.store(true, Ordering::SeqCst);
                }
                captured.runtime_error = Some(error.to_string());
            }
        }
        Ok(std::mem::take(&mut *captured))
    }

    #[napi]
    pub fn cancel(&self) {
        if let Some(token) = self.active.lock().expect("active lock").as_ref() {
            token.store(true, Ordering::SeqCst);
        }
    }

    #[napi]
    pub async fn dispose(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.cancel();
        self.fs.lock().await.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn overlay_persists_without_host_mutation() {
        let host = tempfile::tempdir().unwrap();
        std::fs::write(host.path().join("fixture"), b"original\n").unwrap();
        let mut bash = shell(
            filesystem(host.path().to_str().unwrap()).await.unwrap(),
            "/workspace",
            1000,
        );
        assert_eq!(
            bash.exec("cat fixture").await.unwrap().stdout.to_string(),
            "original\n"
        );
        assert_eq!(
            bash.exec("echo changed > fixture; echo created > new; cat fixture")
                .await
                .unwrap()
                .stdout
                .to_string(),
            "changed\n"
        );
        assert_eq!(
            bash.exec("cat new; rm fixture; test ! -e fixture")
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            std::fs::read(host.path().join("fixture")).unwrap(),
            b"original\n"
        );
        assert!(!host.path().join("new").exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn confines_host_reads() {
        let host = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"outside-secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), host.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), host.path().join("leaf"))
            .unwrap();
        assert!(
            filesystem(host.path().join("escape").to_str().unwrap())
                .await
                .is_err()
        );
        let mut bash = shell(
            filesystem(host.path().to_str().unwrap()).await.unwrap(),
            "/workspace",
            1000,
        );
        for command in [
            "cat escape/secret",
            "cat leaf",
            "cat escape/missing/../secret",
            "cat /workspace/../secret",
            "cat /etc/passwd",
        ] {
            let result = bash.exec(command).await.unwrap();
            assert_ne!(result.exit_code, 0, "{command}");
            assert!(!result.stdout.contains("outside-secret"), "{command}");
        }
    }
}
