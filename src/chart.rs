//! Compact candlestick PNG rendering and disposable chart-dir retention.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use plotters::prelude::*;
use plotters::style::Color;
use png::{BitDepth, ColorType, Compression, Encoder};

use crate::marketdata::{CandleSeries, ChartRange};

pub(crate) const CHART_WIDTH: u32 = 720;
pub(crate) const CHART_HEIGHT: u32 = 405;
#[cfg(test)]
pub(crate) const CHART_SIZE_CAP_BYTES: u64 = 150_000;
const DEFAULT_KEEP: usize = 3;
const DEFAULT_TTL_SECS: u64 = 3600;

const FONT_BYTES: &[u8] = include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf");

const BG: RGBColor = RGBColor(10, 10, 12);
const UP: RGBColor = RGBColor(34, 197, 94);
const DOWN: RGBColor = RGBColor(239, 68, 68);
const AXIS: RGBColor = RGBColor(160, 160, 172);
const GRID: RGBColor = RGBColor(36, 36, 44);
const TITLE: RGBColor = RGBColor(179, 136, 255);
const LABEL: RGBColor = RGBColor(210, 210, 220);

static FONT: OnceLock<()> = OnceLock::new();

fn ensure_font() {
    FONT.get_or_init(|| {
        let _ = plotters::style::register_font("sans-serif", FontStyle::Normal, FONT_BYTES);
        let _ = plotters::style::register_font("sans-serif", FontStyle::Bold, FONT_BYTES);
    });
}

pub(crate) fn chart_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("WORLD_CHART_DIR")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(xdg).join("aomi/world-markets/charts");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/aomi/world-markets/charts");
    }
    std::env::temp_dir().join("aomi-world-markets/charts")
}

pub(crate) fn chart_keep() -> usize {
    std::env::var("WORLD_CHART_KEEP")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(DEFAULT_KEEP)
}

pub(crate) fn chart_ttl_secs() -> u64 {
    std::env::var("WORLD_CHART_TTL_SECS")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(DEFAULT_TTL_SECS)
}

pub(crate) fn chart_open_enabled() -> bool {
    matches!(
        std::env::var("WORLD_CHART_OPEN")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    )
}

pub(crate) fn render_png(
    series: &CandleSeries,
    range: ChartRange,
    title_symbol: &str,
) -> Result<Vec<u8>, String> {
    ensure_font();
    if series.candles.is_empty() {
        return Err("[world-markets] no candles to chart".to_string());
    }
    let mut buf = vec![0u8; (CHART_WIDTH * CHART_HEIGHT * 3) as usize];
    {
        let root =
            BitMapBackend::with_buffer(&mut buf, (CHART_WIDTH, CHART_HEIGHT)).into_drawing_area();
        root.fill(&BG)
            .map_err(|e| format!("[world-markets] chart fill: {e}"))?;
        draw_candles(&root, series, range, title_symbol)?;
        root.present()
            .map_err(|e| format!("[world-markets] chart present: {e}"))?;
    }
    encode_png(&buf)
}

fn draw_candles<DB: DrawingBackend>(
    root: &DrawingArea<DB, plotters::coord::Shift>,
    series: &CandleSeries,
    range: ChartRange,
    title_symbol: &str,
) -> Result<(), String>
where
    DB::ErrorType: std::error::Error,
{
    let n = series.candles.len();
    let mut y_min = series
        .candles
        .iter()
        .map(|c| c.low)
        .fold(f64::INFINITY, f64::min);
    let mut y_max = series
        .candles
        .iter()
        .map(|c| c.high)
        .fold(f64::NEG_INFINITY, f64::max);
    if !y_min.is_finite() || !y_max.is_finite() || y_max <= y_min {
        y_min = 0.0;
        y_max = 1.0;
    }
    let pad = (y_max - y_min).max(y_max.abs() * 0.002).max(0.0001);
    y_min -= pad;
    y_max += pad;

    let title = format!("{} {}", title_symbol, range.label());
    let mut chart = ChartBuilder::on(root)
        .caption(title, ("sans-serif", 16).into_font().color(&TITLE))
        .margin(6)
        .x_label_area_size(22)
        .y_label_area_size(52)
        .build_cartesian_2d(-1..(n as i32), y_min..y_max)
        .map_err(|e| format!("[world-markets] chart axes: {e}"))?;

    let timestamps: Vec<i64> = series.candles.iter().map(|c| c.ts).collect();
    chart
        .configure_mesh()
        .disable_mesh()
        .light_line_style(GRID)
        .bold_line_style(GRID)
        .axis_style(AXIS)
        .label_style(("sans-serif", 11).into_font().color(&LABEL))
        .x_labels(6)
        .y_labels(5)
        .x_label_formatter(&|idx| {
            let i = (*idx).clamp(0, (n as i32) - 1) as usize;
            fmt_ts(timestamps.get(i).copied().unwrap_or(0), range)
        })
        .y_label_formatter(&|v| format_axis_price(*v))
        .draw()
        .map_err(|e| format!("[world-markets] chart mesh: {e}"))?;

    let width = ((CHART_WIDTH as f64 / n as f64) * 0.35).clamp(1.0, 6.0) as u32;
    chart
        .draw_series(series.candles.iter().enumerate().map(|(i, c)| {
            CandleStick::new(
                i as i32,
                c.open,
                c.high,
                c.low,
                c.close,
                UP.filled(),
                DOWN.filled(),
                width,
            )
        }))
        .map_err(|e| format!("[world-markets] chart candles: {e}"))?;
    Ok(())
}

fn encode_png(rgb: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, CHART_WIDTH, CHART_HEIGHT);
    encoder.set_color(ColorType::Rgb);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(Compression::Best);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("[world-markets] png header: {e}"))?;
    writer
        .write_image_data(rgb)
        .map_err(|e| format!("[world-markets] png data: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("[world-markets] png finish: {e}"))?;
    Ok(out)
}

pub(crate) fn write_chart(
    dir: &Path,
    series: &CandleSeries,
    range: ChartRange,
    title_symbol: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(dir)
        .map_err(|e| format!("[world-markets] create chart dir {}: {e}", dir.display()))?;
    let png = render_png(series, range, title_symbol)?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let safe = sanitize_symbol(title_symbol);
    let path = dir.join(format!("{safe}_{}_{nanos}.png", range.as_token()));
    fs::write(&path, png)
        .map_err(|e| format!("[world-markets] write chart {}: {e}", path.display()))?;
    Ok(path)
}

pub(crate) fn prune_charts(
    dir: &Path,
    keep: usize,
    ttl_secs: u64,
    now: SystemTime,
) -> Result<u64, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut files = list_pngs(dir)?;
    let mut deleted = 0u64;
    if ttl_secs > 0 {
        let mut kept = Vec::new();
        for file in files {
            let age_ok = match now.duration_since(file.modified) {
                Ok(age) => ttl_secs == 0 || age.as_secs() < ttl_secs,
                Err(_) => true,
            };
            if age_ok {
                kept.push(file);
            } else if remove_png(&file.path)? {
                deleted += 1;
            }
        }
        files = kept;
    }
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    let drop = if keep == 0 {
        files.as_slice()
    } else if files.len() > keep {
        &files[keep..]
    } else {
        &[]
    };
    for file in drop {
        if remove_png(&file.path)? {
            deleted += 1;
        }
    }
    Ok(deleted)
}

pub(crate) fn clear_charts(dir: &Path) -> Result<(u64, PathBuf), String> {
    let mut deleted = 0u64;
    if dir.exists() {
        for file in list_pngs(dir)? {
            if remove_png(&file.path)? {
                deleted += 1;
            }
        }
    }
    Ok((deleted, dir.to_path_buf()))
}

pub(crate) fn clear_charts_tool() -> Result<serde_json::Value, String> {
    let dir = chart_dir();
    let (deleted, directory) = clear_charts(&dir)?;
    Ok(serde_json::json!({
        "ok": true,
        "deleted": deleted,
        "directory": directory.to_string_lossy(),
        "caption": format!("Cleared `{deleted}` chart image(s)."),
        "executable": false,
    }))
}

pub(crate) fn maybe_open(path: &Path) -> bool {
    if !chart_open_enabled() {
        return false;
    }
    let mut cmd = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(target_os = "linux") {
        Command::new("xdg-open")
    } else {
        return false;
    };
    cmd.arg(path).status().map(|s| s.success()).unwrap_or(false)
}

fn list_pngs(dir: &Path) -> Result<Vec<ChartFile>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("[world-markets] read chart dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("[world-markets] chart dir entry: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| format!("[world-markets] chart metadata {}: {e}", path.display()))?;
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        out.push(ChartFile { path, modified });
    }
    Ok(out)
}

fn remove_png(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("[world-markets] delete {}: {e}", path.display())),
    }
}

fn sanitize_symbol(symbol: &str) -> String {
    symbol
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn format_axis_price(value: f64) -> String {
    if value.abs() >= 1000.0 {
        format!("{value:.0}")
    } else if value.abs() >= 1.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.4}")
    }
}

fn fmt_ts(ts: i64, range: ChartRange) -> String {
    let secs = ts.max(0) as u64;
    let days = (secs / 86400) as i64;
    let of_day = secs % 86400;
    let hour = of_day / 3600;
    let min = (of_day % 3600) / 60;
    match range {
        ChartRange::Day | ChartRange::Week => format!("{hour:02}:{min:02}"),
        ChartRange::Month => {
            let (_y, m, d) = civil_from_unix_days(days);
            format!("{m:02}-{d:02}")
        }
    }
}

/// Unix epoch day number → UTC month/day (Howard Hinnant civil_from_days).
fn civil_from_unix_days(unix_days: i64) -> (i32, u32, u32) {
    let z = unix_days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

struct ChartFile {
    path: PathBuf,
    modified: SystemTime,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::marketdata::Candle;
    use std::fs::File;
    use std::time::Duration;

    fn fixture_series() -> CandleSeries {
        let mut candles = Vec::new();
        let mut price = 100.0;
        for i in 0..24 {
            let open: f64 = price;
            let close: f64 = price + if i % 3 == 0 { 1.2 } else { -0.8 };
            let high = open.max(close) + 0.4;
            let low = open.min(close) - 0.3;
            candles.push(Candle {
                ts: 1_700_000_000 + i * 300,
                open,
                high,
                low,
                close,
            });
            price = close;
        }
        CandleSeries {
            feed_symbol: "AAPL".into(),
            name: Some("Apple".into()),
            source: "fixture".into(),
            candles,
        }
    }

    fn unique_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("aomi-chart-test-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn renders_compact_png() {
        let png = render_png(&fixture_series(), ChartRange::Day, "AAPL").unwrap();
        assert!(
            png.starts_with(&[0x89, b'P', b'N', b'G']),
            "missing PNG magic"
        );
        assert!(
            (png.len() as u64) < CHART_SIZE_CAP_BYTES,
            "chart too large: {} bytes",
            png.len()
        );
        assert!(png.len() > 32, "chart too small to be a real image");
    }

    #[test]
    fn prune_keeps_n_newest() {
        let dir = unique_dir();
        fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now();
        for i in 0..5 {
            let path = dir.join(format!("c{i}.png"));
            fs::write(&path, b"\x89PNG").unwrap();
            let mtime = now - Duration::from_secs(10 + i as u64);
            let file = File::options().write(true).open(&path).unwrap();
            let _ = file.set_modified(mtime);
        }
        let deleted = prune_charts(&dir, 3, 3600, now).unwrap();
        assert_eq!(deleted, 2);
        let left = fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_ttl_deletes_old() {
        let dir = unique_dir();
        fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now();
        let fresh = dir.join("fresh.png");
        let stale = dir.join("stale.png");
        fs::write(&fresh, b"\x89PNG").unwrap();
        fs::write(&stale, b"\x89PNG").unwrap();
        File::options()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_modified(now)
            .unwrap();
        File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(now - Duration::from_secs(7200))
            .unwrap();
        let deleted = prune_charts(&dir, 10, 3600, now).unwrap();
        assert_eq!(deleted, 1);
        assert!(fresh.exists());
        assert!(!stale.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keep_zero_deletes_all() {
        let dir = unique_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("b.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("notes.txt"), b"leave me").unwrap();
        let deleted = prune_charts(&dir, 0, 3600, SystemTime::now()).unwrap();
        assert_eq!(deleted, 2);
        assert!(dir.join("notes.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_wipes_pngs_only() {
        let dir = unique_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("b.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("keep.json"), b"{}").unwrap();
        let (deleted, path) = clear_charts(&dir).unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(path, dir);
        assert!(dir.join("keep.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_then_prune_respects_keep() {
        let dir = unique_dir();
        let series = fixture_series();
        for _ in 0..4 {
            write_chart(&dir, &series, ChartRange::Day, "AAPL").unwrap();
        }
        prune_charts(&dir, 2, 3600, SystemTime::now()).unwrap();
        let pngs = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .ok()
                    .and_then(|e| e.path().extension().map(|x| x == "png"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(pngs, 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
