use omenflow_headless::{Config, Server, Stopper};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
usage: omenflow-host --app-data <dir> [--port <n>] [--token <t>] [--cli <path>] [--exit-on-stdin-close]

  --app-data <dir>        application state directory (settings, agent bridge socket)
  --port <n>              loopback port to listen on; 0 picks a free one (default 0)
  --token <t>             token every request must carry; generated when absent
  --cli <path>            the omenflow helper that agent sessions call back through
  --exit-on-stdin-close   stop when standard input closes, so the host never outlives its parent

Prints one JSON line { port, token, socketPath } to standard output once it is listening.";

struct Args {
    config: Config,
    exit_on_stdin_close: bool,
}

enum Parsed {
    Run(Box<Args>),
    Help,
    Version,
}

fn parse(argv: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let mut app_data_dir = None;
    let mut cli_path = None;
    let mut port = 0;
    let mut token = None;
    let mut exit_on_stdin_close = false;
    let mut argv = argv.into_iter();
    while let Some(flag) = argv.next() {
        let mut value = || argv.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--app-data" => app_data_dir = Some(PathBuf::from(value()?)),
            "--cli" => cli_path = Some(PathBuf::from(value()?)),
            "--port" => {
                let text = value()?;
                port = text
                    .parse()
                    .map_err(|_| format!("--port must be a number from 0 to 65535, got {text}"))?;
            }
            "--token" => token = Some(value()?),
            "--exit-on-stdin-close" => exit_on_stdin_close = true,
            "--help" | "-h" => return Ok(Parsed::Help),
            "--version" | "-V" => return Ok(Parsed::Version),
            other => return Err(format!("unexpected argument: {other}")),
        }
    }
    let app_data_dir = app_data_dir.ok_or("--app-data <dir> is required")?;
    Ok(Parsed::Run(Box::new(Args {
        config: Config {
            app_data_dir,
            cli_path: cli_path.unwrap_or_else(default_cli_path),
            port,
            token,
        },
        exit_on_stdin_close,
    })))
}

/// The helper beside this executable when installed that way, else the
/// development build inside the repository.
fn default_cli_path() -> PathBuf {
    let name = if cfg!(windows) {
        "omenflow.exe"
    } else {
        "omenflow"
    };
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(name)))
        .filter(|path| path.is_file());
    beside.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/omenflow-bridge/target/release")
            .join(name)
    })
}

fn stop_when_stdin_closes(stopper: Stopper) {
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
        stopper.stop();
    });
}

#[cfg(unix)]
mod signals {
    use super::Stopper;
    use std::fs::File;
    use std::io::Read;
    use std::os::fd::FromRawFd;
    use std::sync::atomic::{AtomicI32, Ordering};

    static WAKE: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(_signal: libc::c_int) {
        let fd = WAKE.load(Ordering::Relaxed);
        if fd >= 0 {
            // Only async-signal-safe work here: one byte into a pipe.
            unsafe { libc::write(fd, [1_u8].as_ptr().cast(), 1) };
        }
    }

    /// Stop cleanly on SIGINT, SIGTERM and SIGHUP. The handler only wakes a
    /// thread; children still start with default signal behaviour.
    pub fn stop_on_termination(stopper: Stopper) -> std::io::Result<()> {
        let mut fds = [0; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        for fd in fds {
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        WAKE.store(fds[1], Ordering::Relaxed);
        let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            unsafe { libc::signal(signal, handler) };
        }
        let mut wake = unsafe { File::from_raw_fd(fds[0]) };
        std::thread::spawn(move || {
            let mut byte = [0_u8; 1];
            if wake.read_exact(&mut byte).is_ok() {
                stopper.stop();
            }
        });
        Ok(())
    }
}

fn run(args: Args) -> Result<(), String> {
    let server = Server::bind(args.config).map_err(|error| match &error.repair {
        Some(repair) => format!("{} — {repair}", error.message),
        None => error.message.clone(),
    })?;
    #[cfg(unix)]
    signals::stop_on_termination(server.stopper())
        .map_err(|error| format!("could not install signal handling: {error}"))?;
    if args.exit_on_stdin_close {
        stop_when_stdin_closes(server.stopper());
    }
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", server.announcement())
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("could not announce the port: {error}"))?;
    drop(stdout);
    server
        .serve()
        .map_err(|error| format!("the server stopped: {error}"))
}

fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Parsed::Version) => {
            println!("omenflow-host {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Parsed::Run(args)) => match run(*args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("omenflow-host: {message}");
                ExitCode::FAILURE
            }
        },
        Err(message) => {
            eprintln!("omenflow-host: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Parsed, String> {
        parse(list.iter().map(|text| (*text).to_owned()))
    }

    #[test]
    fn flags_are_parsed_into_a_config() {
        let Ok(Parsed::Run(parsed)) = args(&[
            "--app-data",
            "/tmp/state",
            "--port",
            "4810",
            "--token",
            "0123456789abcdef",
            "--cli",
            "/opt/omenflow",
            "--exit-on-stdin-close",
        ]) else {
            panic!("expected a run");
        };
        assert_eq!(parsed.config.app_data_dir, PathBuf::from("/tmp/state"));
        assert_eq!(parsed.config.port, 4810);
        assert_eq!(parsed.config.token.as_deref(), Some("0123456789abcdef"));
        assert_eq!(parsed.config.cli_path, PathBuf::from("/opt/omenflow"));
        assert!(parsed.exit_on_stdin_close);
    }

    #[test]
    fn defaults_pick_a_free_port_and_generate_the_token() {
        let Ok(Parsed::Run(parsed)) = args(&["--app-data", "state"]) else {
            panic!("expected a run");
        };
        assert_eq!(parsed.config.port, 0);
        assert!(parsed.config.token.is_none());
        assert!(!parsed.exit_on_stdin_close);
        assert!(parsed.config.cli_path.ends_with(if cfg!(windows) {
            "omenflow.exe"
        } else {
            "omenflow"
        }));
    }

    #[test]
    fn bad_invocations_say_what_is_wrong() {
        let message = |list: &[&str]| args(list).err().expect("an error");
        assert_eq!(message(&[]), "--app-data <dir> is required");
        assert_eq!(message(&["--app-data"]), "--app-data needs a value");
        assert_eq!(
            message(&["--app-data", "x", "--port", "70000"]),
            "--port must be a number from 0 to 65535, got 70000"
        );
        assert_eq!(
            message(&["--app-data", "x", "--verbose"]),
            "unexpected argument: --verbose"
        );
        assert!(matches!(args(&["--help"]), Ok(Parsed::Help)));
        assert!(matches!(args(&["-V"]), Ok(Parsed::Version)));
    }
}
