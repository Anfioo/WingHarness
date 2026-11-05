//! Validation coverage for bounded, failure-only permanent-delete volume diagnostics.

use std::{fs, io::Write, sync::Mutex};

struct DiagnosticLogger(Mutex<Option<std::io::BufWriter<fs::File>>>);

impl log::Log for DiagnosticLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            if let Some(file) = self.0.lock().unwrap().as_mut() {
                writeln!(file, "{} {}", record.level(), record.args()).unwrap();
            }
        }
    }

    fn flush(&self) {
        if let Some(file) = self.0.lock().unwrap().as_mut() {
            file.flush().unwrap();
        }
    }
}

static LOGGER: DiagnosticLogger = DiagnosticLogger(Mutex::new(None));

/// Run alone with `--ignored --exact --nocapture --test-threads=1`.
///
/// The explicit probe targets an unavailable volume so native query failures are
/// exercised without touching any user data.
#[test]
#[ignore = "isolated production volume-diagnostics logging"]
fn validate_failed_volume_sample_diagnostics() {
    let log_path = std::env::var_os("MANGODISK_VOLUME_DIAGNOSTICS_LOG")
        .expect("provide a diagnostic output path");
    *LOGGER.0.lock().unwrap() = Some(std::io::BufWriter::new(
        fs::File::create(&log_path).unwrap(),
    ));
    log::set_logger(&LOGGER).expect("run in an isolated test process");
    log::set_max_level(log::LevelFilter::Info);

    super::log_failed_volume_samples(
        "duplicates",
        0,
        0,
        &[crate::filesystem::PermanentDeleteFailure {
            path: "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\missing.bin".into(),
            details: crate::filesystem::models::PermanentDeleteFailureDetails {
                message: "synthetic unavailable-volume probe".into(),
                ..Default::default()
            },
        }],
    );
    super::wait_for_volume_diagnostics();
    log::logger().flush();

    let diagnostics = fs::read_to_string(&log_path).unwrap();
    assert!(diagnostics.contains("outcome=query_failed"));
    assert!(diagnostics.contains("filesystem=\"unknown\""));
    *LOGGER.0.lock().unwrap() = None;
}
