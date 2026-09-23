//! Comparable source-core latency samples on the disposable release fixture.
use omenflow_core::{CoreApp, Origin};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().collect::<Vec<_>>();
    if args.len() != 3 {
        return Err("Usage: measure_commands PROJECT OUTPUT.json".into());
    }
    let project = &args[1];
    let out = Path::new(&args[2]);
    fs::create_dir_all(out.parent().ok_or("Output parent missing")?)?;
    let mut app = CoreApp::new(out.parent().unwrap().join("command-appdata"))?;
    let opened = app.dispatch("project.open", json!({"path":project}), Origin::User, None)?;
    let id = opened["projectId"].as_str().ok_or("Project ID missing")?;
    let list = app.dispatch(
        "artifact.list",
        json!({"type":"mechanical"}),
        Origin::User,
        Some(id),
    )?;
    let artifact = list["artifacts"]
        .as_array()
        .and_then(|items| items.first())
        .ok_or("Mechanical artifact missing")?;
    let artifact_id = artifact["artifact"]["id"]
        .as_str()
        .ok_or("Artifact ID missing")?;
    let history = app.dispatch(
        "artifact.history",
        json!({"artifactId":artifact_id}),
        Origin::User,
        Some(id),
    )?;
    let revision_id = history["revisions"]
        .as_array()
        .and_then(|items| items.last())
        .and_then(|v| v["id"].as_str())
        .ok_or("Mechanical revision missing")?;
    let operations = [
        ("artifact.read", json!({"artifactId":artifact_id})),
        ("project.search", json!({"query":"Reference","limit":20})),
        (
            "cad.inspect",
            json!({"artifactId":artifact_id,"revisionId":revision_id}),
        ),
    ];
    let mut measurements = Vec::new();
    let mut triangles = Value::Null;
    for (op, payload) in operations {
        let mut samples = Vec::new();
        for _ in 0..30 {
            let start = Instant::now();
            let result = app.dispatch(op, payload.clone(), Origin::User, Some(id))?;
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            if op == "cad.inspect" {
                triangles = result["geometry"]["triangles"].clone();
            }
            samples.push(json!({"ms":ms,"bytes":serde_json::to_vec(&result)?.len()}));
            thread::sleep(Duration::from_millis(10));
        }
        let mut sorted = samples
            .iter()
            .filter_map(|s| s["ms"].as_f64())
            .collect::<Vec<_>>();
        sorted.sort_by(f64::total_cmp);
        measurements.push(json!({"op":op,"samples":30,"p50Ms":sorted[14],"p95Ms":sorted[28],"maxMs":sorted[29],"raw":samples}));
    }
    let result = json!({"project":project,"artifacts":500,"triangles":triangles,
        "method":"Thirty sequential source-core dispatches per operation on the same disposable 500-object fixture; 10 ms between samples. Monotonic Rust Instant, excludes UI transport, provider and network. No JavaScript event-loop timer-gap metric.",
        "measurements":measurements});
    fs::write(out, format!("{}\n", serde_json::to_string_pretty(&result)?))?;
    println!(
        "{}",
        serde_json::to_string(
            &measurements
                .iter()
                .map(|item| json!({"op":item["op"],"p50Ms":item["p50Ms"],"p95Ms":item["p95Ms"]}))
                .collect::<Vec<_>>()
        )?
    );
    Ok(())
}
