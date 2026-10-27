//! Quit cleanly when the system or a terminal asks the process to end.
//!
//! SIGTERM (a session logging out, `kill`, a service manager), SIGINT (Ctrl-C
//! in the terminal that started the app) and SIGHUP (that terminal closing)
//! would otherwise end the process at once and skip the exit path in `main`:
//! the agent sessions' process groups and engine renders would keep running
//! and the window's place would not be saved. The first of them asks the app
//! to quit normally instead; a second one, while that is under way, ends the
//! process the default way, so a stuck shutdown can still be interrupted.

use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::io;

/// The signals that quit the app through its exit path.
pub const HANDLED: [i32; 3] = [SIGTERM, SIGINT, SIGHUP];

/// From now on, call `quit` with the first of [`HANDLED`] to arrive. A
/// thread of its own waits for it (signal-hook's self-pipe; no polling).
pub fn on_termination(quit: impl FnOnce(i32) + Send + 'static) -> io::Result<()> {
    let mut signals = Signals::new(HANDLED)?;
    std::thread::Builder::new()
        .name("bureau-signals".into())
        .spawn(move || {
            let mut received = signals.forever();
            if let Some(signal) = received.next() {
                quit(signal);
            }
            if let Some(signal) = received.next() {
                // Restores the default action and raises the signal again.
                let _ = signal_hook::low_level::emulate_default_handler(signal);
            }
        })?;
    Ok(())
}

pub fn name(signal: i32) -> &'static str {
    signal_hook::low_level::signal_name(signal).unwrap_or("a termination signal")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Set when the test binary runs itself as the process that is signalled.
    const CHILD: &str = "BUREAU_SIGNAL_TEST_CHILD";

    /// The signalled process: registers the handler, says READY, and once
    /// asked to quit says so and exits 0 ("quit"), or never finishes
    /// quitting ("stuck"). Without the variable it is an ordinary, empty test.
    #[test]
    fn signalled_child() {
        let Ok(mode) = std::env::var(CHILD) else {
            return;
        };
        let (sender, receiver) = mpsc::channel();
        on_termination(move |signal| {
            let _ = sender.send(signal);
        })
        .unwrap();
        println!("READY");
        let signal = receiver.recv().unwrap();
        println!("QUIT {}", name(signal));
        if mode == "stuck" {
            std::thread::sleep(Duration::from_secs(60));
        }
        std::process::exit(0);
    }

    struct Signalled {
        child: Child,
        lines: mpsc::Receiver<String>,
    }

    impl Signalled {
        fn start(mode: &str) -> Self {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "signals::tests::signalled_child",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD, mode)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let (sender, lines) = mpsc::channel();
            let stdout = child.stdout.take().unwrap();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = sender.send(line);
                }
            });
            let mut signalled = Self { child, lines };
            signalled.expect("READY");
            signalled
        }

        fn expect(&mut self, wanted: &str) {
            loop {
                match self.lines.recv_timeout(Duration::from_secs(20)) {
                    // libtest prints its "test … ..." prefix on the same line.
                    Ok(line) if line.trim_end().ends_with(wanted) => return,
                    Ok(_) => continue,
                    Err(_) => {
                        let _ = self.child.kill();
                        panic!("the child never said {wanted:?}");
                    }
                }
            }
        }

        fn send(&self, signal: i32) {
            // SAFETY: plain kill(2) on the child this test started.
            assert_eq!(unsafe { libc::kill(self.child.id() as i32, signal) }, 0);
        }

        fn status(mut self) -> std::process::ExitStatus {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    return status;
                }
                if std::time::Instant::now() > deadline {
                    let _ = self.child.kill();
                    panic!("the child did not end");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    #[test]
    fn each_termination_signal_quits_through_the_exit_path_with_status_0() {
        for signal in HANDLED {
            let mut child = Signalled::start("quit");
            child.send(signal);
            child.expect(&format!("QUIT {}", name(signal)));
            let status = child.status();
            assert_eq!(
                (status.code(), status.signal()),
                (Some(0), None),
                "{}",
                name(signal)
            );
        }
    }

    #[test]
    fn a_second_signal_ends_a_shutdown_that_does_not_finish() {
        let mut child = Signalled::start("stuck");
        child.send(SIGTERM);
        child.expect("QUIT SIGTERM");
        child.send(SIGTERM);
        assert_eq!(child.status().signal(), Some(SIGTERM));
    }

    #[test]
    fn signals_have_their_names() {
        assert_eq!(HANDLED.map(name), ["SIGTERM", "SIGINT", "SIGHUP"]);
    }
}
