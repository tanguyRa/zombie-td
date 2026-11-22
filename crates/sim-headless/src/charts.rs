//! Standalone SVG charts for the HTML report. Colours are CSS variables
//! defined by the report page (light and dark steps). Each chart embeds its
//! data as JSON so a small script can draw a crosshair + tooltip on hover.

use std::fmt::Write;

pub struct Series {
    pub name: String,
    /// CSS variable holding the series colour, e.g. "--series-1".
    pub color_var: &'static str,
    pub points: Vec<(f64, f64)>,
}

const W: f64 = 720.0;
const H: f64 = 300.0;
const ML: f64 = 64.0;
const MR: f64 = 96.0; // room for direct labels
const MT: f64 = 16.0;
const MB: f64 = 40.0;

fn nice_max(v: f64) -> f64 {
    if v <= 0.0 {
        return 1.0;
    }
    let mag = 10f64.powf(v.log10().floor());
    for m in [1.0, 2.0, 2.5, 5.0, 10.0] {
        if v <= m * mag {
            return m * mag;
        }
    }
    10.0 * mag
}

/// Round axis maximum: a multiple of a 1/2/2.5/5 step giving about 5 ticks.
fn nice_axis(v: f64) -> f64 {
    let step = nice_max(v / 5.0);
    (v / step).ceil().max(1.0) * step
}

fn fmt_tick(v: f64) -> String {
    if v >= 1000.0 {
        format!("{}k", (v / 1000.0 * 10.0).round() / 10.0)
    } else if v.fract().abs() < 1e-9 {
        format!("{v:.0}")
    } else {
        format!("{v:.1}")
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn axes(out: &mut String, x_max: f64, y_max: f64, x_label: &str, y_label: &str) {
    let pw = W - ML - MR;
    let ph = H - MT - MB;
    for k in 0..=4 {
        let v = y_max * k as f64 / 4.0;
        let y = MT + ph - ph * k as f64 / 4.0;
        let _ = write!(out, r#"<line x1="{ML}" x2="{:.1}" y1="{y:.1}" y2="{y:.1}" class="grid"/>"#, ML + pw);
        let _ = write!(out, r#"<text x="{:.1}" y="{:.1}" class="tick" text-anchor="end">{}</text>"#, ML - 8.0, y + 4.0, fmt_tick(v));
    }
    let xs = nice_max(x_max / 5.0);
    let nx = (x_max / xs).round() as usize;
    for k in 0..=nx {
        let v = xs * k as f64;
        let x = ML + pw * v / x_max;
        let _ = write!(out, r#"<text x="{x:.1}" y="{:.1}" class="tick" text-anchor="middle">{}</text>"#, MT + ph + 18.0, fmt_tick(v));
    }
    let _ = write!(out, r#"<line x1="{ML}" x2="{:.1}" y1="{:.1}" y2="{:.1}" class="axis"/>"#, ML + pw, MT + ph, MT + ph);
    let _ = write!(out, r#"<text x="{:.1}" y="{:.1}" class="label" text-anchor="middle">{}</text>"#, ML + pw / 2.0, H - 4.0, esc(x_label));
    let _ = write!(out, r#"<text x="14" y="{:.1}" class="label" text-anchor="middle" transform="rotate(-90 14 {:.1})">{}</text>"#, MT + ph / 2.0, MT + ph / 2.0, esc(y_label));
}

fn legend(series: &[Series]) -> String {
    let mut s = String::from(r#"<div class="legend">"#);
    for se in series {
        let _ = write!(s, r#"<span><i style="background:var({})"></i>{}</span>"#, se.color_var, esc(&se.name));
    }
    s.push_str("</div>");
    s
}

fn data_json(series: &[Series], x_label: &str, sx: f64, sy: f64, x_max: f64, y_max: f64, stacked: bool) -> String {
    let xs: Vec<f64> = series.first().map(|s| s.points.iter().map(|p| p.0).collect()).unwrap_or_default();
    let ser: Vec<serde_json::Value> = series
        .iter()
        .map(|s| serde_json::json!({"name": s.name, "color": s.color_var, "y": s.points.iter().map(|p| (p.1 * 1000.0).round() / 1000.0).collect::<Vec<_>>()}))
        .collect();
    serde_json::json!({"x": xs, "xLabel": x_label, "series": ser, "ml": ML, "mt": MT, "pw": W - ML - MR, "ph": H - MT - MB, "xMax": x_max, "yMax": y_max, "sx": sx, "sy": sy, "stacked": stacked}).to_string()
}

/// Multi-series line chart with direct end labels (≤ 4 series) and a legend.
pub fn line_chart(id: &str, title: &str, x_label: &str, y_label: &str, series: &[Series]) -> String {
    let x_max = nice_axis(series.iter().flat_map(|s| s.points.iter().map(|p| p.0)).fold(0.0, f64::max).max(1.0));
    let y_max = nice_max(series.iter().flat_map(|s| s.points.iter().map(|p| p.1)).fold(0.0, f64::max));
    let pw = W - ML - MR;
    let ph = H - MT - MB;
    let sx = pw / x_max;
    let sy = ph / y_max;
    let mut svg = String::new();
    let _ = write!(svg, r#"<svg viewBox="0 0 {W} {H}" role="img" aria-label="{}" class="chart" data-chart="{id}">"#, esc(title));
    axes(&mut svg, x_max, y_max, x_label, y_label);
    let mut label_ys: Vec<f64> = Vec::new();
    for s in series {
        let mut d = String::new();
        for (k, &(x, y)) in s.points.iter().enumerate() {
            let _ = write!(d, "{}{:.1},{:.1}", if k == 0 { "M" } else { "L" }, ML + x * sx, MT + ph - y * sy);
        }
        let _ = write!(svg, r#"<path d="{d}" class="line" style="stroke:var({})"/>"#, s.color_var);
        if series.len() <= 4 {
            if let Some(&(x, y)) = s.points.last() {
                let mut ly = MT + ph - y * sy + 4.0;
                while label_ys.iter().any(|&o| (o - ly).abs() < 13.0) {
                    ly -= 13.0;
                }
                label_ys.push(ly);
                let _ = write!(svg, r#"<text x="{:.1}" y="{ly:.1}" class="dlabel">{}</text>"#, ML + x * sx + 6.0, esc(&s.name));
            }
        }
    }
    let _ = write!(svg, r#"<g class="hover"></g></svg>"#);
    format!(
        r#"<figure class="viz"><figcaption>{}</figcaption>{}{}<script type="application/json" data-for="{id}">{}</script></figure>"#,
        esc(title),
        legend(series),
        svg,
        data_json(series, x_label, sx, sy, x_max, y_max, false)
    )
}

/// Stacked area chart; series share the same x values. 2 px surface gaps between bands.
pub fn stacked_area(id: &str, title: &str, x_label: &str, y_label: &str, series: &[Series]) -> String {
    let n = series.first().map(|s| s.points.len()).unwrap_or(0);
    let x_max = nice_axis(series.first().and_then(|s| s.points.last()).map(|p| p.0).unwrap_or(1.0).max(1.0));
    let totals: Vec<f64> = (0..n).map(|k| series.iter().map(|s| s.points[k].1).sum()).collect();
    let y_max = nice_max(totals.iter().copied().fold(0.0, f64::max));
    let pw = W - ML - MR;
    let ph = H - MT - MB;
    let sx = pw / x_max;
    let sy = ph / y_max;
    let mut svg = String::new();
    let _ = write!(svg, r#"<svg viewBox="0 0 {W} {H}" role="img" aria-label="{}" class="chart" data-chart="{id}">"#, esc(title));
    axes(&mut svg, x_max, y_max, x_label, y_label);
    let mut base = vec![0.0f64; n];
    for s in series {
        let top: Vec<f64> = (0..n).map(|k| base[k] + s.points[k].1).collect();
        let mut d = String::new();
        for k in 0..n {
            let _ = write!(d, "{}{:.1},{:.1}", if k == 0 { "M" } else { "L" }, ML + s.points[k].0 * sx, MT + ph - top[k] * sy);
        }
        for k in (0..n).rev() {
            let _ = write!(d, "L{:.1},{:.1}", ML + s.points[k].0 * sx, MT + ph - base[k] * sy);
        }
        d.push('Z');
        let _ = write!(svg, r#"<path d="{d}" class="band" style="fill:var({})"/>"#, s.color_var);
        base = top;
    }
    let _ = write!(svg, r#"<g class="hover"></g></svg>"#);
    format!(
        r#"<figure class="viz"><figcaption>{}</figcaption>{}{}<script type="application/json" data-for="{id}">{}</script></figure>"#,
        esc(title),
        legend(series),
        svg,
        data_json(series, x_label, sx, sy, x_max, y_max, true)
    )
}

/// CSS + hover script shared by every chart on the page.
pub const CHART_ASSETS: &str = r##"
<script>
document.querySelectorAll("svg.chart").forEach(function (svg) {
  var id = svg.getAttribute("data-chart");
  var data = JSON.parse(document.querySelector('script[data-for="' + id + '"]').textContent);
  var g = svg.querySelector("g.hover");
  var tip = document.createElement("div");
  tip.className = "tip";
  svg.parentNode.appendChild(tip);
  var NS = "http://www.w3.org/2000/svg";
  var line = document.createElementNS(NS, "line");
  line.setAttribute("class", "cross");
  g.appendChild(line);
  var hit = document.createElementNS(NS, "rect");
  hit.setAttribute("x", data.ml); hit.setAttribute("y", data.mt);
  hit.setAttribute("width", data.pw); hit.setAttribute("height", data.ph);
  hit.setAttribute("fill", "transparent");
  svg.appendChild(hit);
  function fmt(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toString(); }
  function show(ev) {
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var p = pt.matrixTransform(svg.getScreenCTM().inverse());
    var xv = (p.x - data.ml) / data.sx;
    var best = 0, bd = Infinity;
    for (var k = 0; k < data.x.length; k++) { var d = Math.abs(data.x[k] - xv); if (d < bd) { bd = d; best = k; } }
    var X = data.ml + data.x[best] * data.sx;
    line.setAttribute("x1", X); line.setAttribute("x2", X);
    line.setAttribute("y1", data.mt); line.setAttribute("y2", data.mt + data.ph);
    line.style.display = "";
    var rows = data.series.map(function (s) {
      return '<div><i style="background:var(' + s.color + ')"></i>' + s.name + '<b>' + fmt(s.y[best]) + '</b></div>';
    });
    if (data.stacked) {
      var tot = data.series.reduce(function (a, s) { return a + s.y[best]; }, 0);
      rows.push('<div class="tot">total<b>' + fmt(tot) + '</b></div>');
    }
    tip.innerHTML = '<div class="th">' + data.xLabel + ' ' + fmt(data.x[best]) + '</div>' + rows.join("");
    var r = svg.getBoundingClientRect(), fr = svg.parentNode.getBoundingClientRect();
    var left = (X / 720) * r.width + (r.left - fr.left) + 12;
    if (left + 190 > fr.width) left -= 214;
    tip.style.left = left + "px"; tip.style.top = (r.top - fr.top + 20) + "px";
    tip.style.display = "block";
  }
  hit.addEventListener("mousemove", show);
  hit.addEventListener("mouseleave", function () { tip.style.display = "none"; line.style.display = "none"; });
});
</script>
"##;
