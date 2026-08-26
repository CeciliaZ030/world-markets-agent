//! World Markets speech ontology: universe, Deepgram keyterm seed, slot repair.
//!
//! Checked-in vocabulary is `assets/speech_ontology.json`. Size-frame repair and
//! exact instrument aliases still rewrite the transcript. `kind: confusable`
//! surfaces (beef/these) are proposed, not silently mapped — the intent layer asks.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

const ONTOLOGY_JSON: &str = include_str!("../assets/speech_ontology.json");
const ONTOLOGY_VERSION: u32 = 1;
const EXTRA_KEYTERM_BUDGET: usize = 40;
const MAX_EDIT_DISTANCE: usize = 1;

#[derive(Debug, Deserialize)]
struct OntologyFile {
    version: u32,
    entries: Vec<OntologyEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OntologyEntry {
    pub surface_form: String,
    pub normalized_target: String,
    pub kind: String,
    #[serde(default)]
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexiconHit {
    pub surface_form: String,
    pub normalized_target: String,
    pub kind: String,
    pub source: String,
}

impl LexiconHit {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "surface_form": self.surface_form,
            "normalized_target": self.normalized_target,
            "kind": self.kind,
            "source": self.source,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedConfusable {
    pub surface: String,
    pub target: String,
}

impl ProposedConfusable {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "surface": self.surface,
            "target": self.target,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repair {
    pub text: String,
    pub hits: Vec<LexiconHit>,
    pub repaired_from: Option<String>,
    pub proposed_confusables: Vec<ProposedConfusable>,
}

impl Repair {
    fn blank(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            hits: Vec::new(),
            repaired_from: None,
            proposed_confusables: Vec::new(),
        }
    }
}

enum SlotHit {
    Canonical(String),
    Confusable { surface: String, target: String },
}

struct Ontology {
    entries: Vec<OntologyEntry>,
    kind_by_surface: HashMap<String, String>,
    instrument_by_surface: HashMap<String, String>,
    confusable_by_surface: HashMap<String, String>,
    size_words: HashSet<String>,
    units: HashSet<String>,
}

fn ontology() -> &'static Ontology {
    static ONTOLOGY: OnceLock<Ontology> = OnceLock::new();
    ONTOLOGY.get_or_init(load_ontology)
}

fn load_ontology() -> Ontology {
    let file: OntologyFile =
        serde_json::from_str(ONTOLOGY_JSON).expect("assets/speech_ontology.json must parse");
    assert_eq!(
        file.version, ONTOLOGY_VERSION,
        "assets/speech_ontology.json version"
    );
    let mut kind_by_surface = HashMap::new();
    let mut instrument_by_surface = HashMap::new();
    let mut confusable_by_surface = HashMap::new();
    let mut size_words = HashSet::new();
    let mut units = HashSet::new();
    for entry in &file.entries {
        let key = normalize_key(&entry.surface_form);
        if key.is_empty() {
            continue;
        }
        kind_by_surface.insert(key.clone(), entry.kind.clone());
        match entry.kind.as_str() {
            "instrument" => {
                instrument_by_surface.insert(key, entry.normalized_target.clone());
            }
            "confusable" => {
                confusable_by_surface.insert(key, entry.normalized_target.clone());
            }
            "size" => {
                size_words.insert(key);
            }
            "unit" | "size_frame" => {
                if entry.surface_form.eq_ignore_ascii_case("dollars")
                    || entry.surface_form.eq_ignore_ascii_case("bucks")
                    || entry.kind == "unit"
                {
                    units.insert(normalize_key(&entry.surface_form));
                }
            }
            _ => {}
        }
    }
    units.insert("dollars".to_string());
    units.insert("bucks".to_string());
    Ontology {
        entries: file.entries,
        kind_by_surface,
        instrument_by_surface,
        confusable_by_surface,
        size_words,
        units,
    }
}

fn normalize_key(surface: &str) -> String {
    surface
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// nova-2 `keywords` intensifier (roughly 1–10). Instruments are strongest;
/// acts/frames/sizes are moderate; nicknames and unknown terms stay weak.
/// Confusable surfaces are never boosted (see `boostable_keyterms`).
pub fn intensifier_for(term: &str) -> u8 {
    match kind_for(term).as_deref() {
        Some("instrument") => 5,
        Some("act" | "size_frame" | "size" | "unit" | "product") => 3,
        _ => 2,
    }
}

pub fn kind_for(term: &str) -> Option<String> {
    let key = normalize_key(term);
    ontology().kind_by_surface.get(&key).cloned()
}

/// Single-token, non-confusable surfaces for Deepgram `keywords`.
pub fn boostable_keyterms() -> Vec<String> {
    let ont = ontology();
    let mut ranked: Vec<&OntologyEntry> = ont
        .entries
        .iter()
        .filter(|row| row.kind != "confusable")
        .collect();
    ranked.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then(
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(
                a.surface_form
                    .to_ascii_lowercase()
                    .cmp(&b.surface_form.to_ascii_lowercase()),
            )
    });
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in ranked {
        let term = row.surface_form.trim();
        if !is_boost_token(term) {
            continue;
        }
        if term.eq_ignore_ascii_case("if") {
            continue;
        }
        let key = term.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }
        out.push(term.to_string());
    }
    out
}

fn is_boost_token(term: &str) -> bool {
    let trimmed = term.trim();
    trimmed.len() >= 2 && !trimmed.contains(char::is_whitespace)
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "instrument" => 0,
        "act" => 1,
        "size_frame" => 2,
        "size" | "unit" => 3,
        "product" => 4,
        "level" => 5,
        "phrase" => 6,
        _ => 9,
    }
}

/// Ontology tokens + live catalog symbols + holdings. Caps extras so brain
/// nicknames still fit under STT `MAX_KEYTERMS` (50).
pub fn seed_keyterms(catalog: &[String], holdings: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let push = |seen: &mut HashSet<String>, out: &mut Vec<String>, term: &str| {
        if out.len() >= EXTRA_KEYTERM_BUDGET {
            return;
        }
        let trimmed = term.trim();
        if !is_boost_token(trimmed) {
            return;
        }
        let key = trimmed.to_ascii_lowercase();
        if !seen.insert(key) {
            return;
        }
        out.push(trimmed.to_string());
    };
    for term in boostable_keyterms() {
        push(&mut seen, &mut out, &term);
    }
    for symbol in catalog {
        push(&mut seen, &mut out, symbol);
    }
    for symbol in holdings {
        push(&mut seen, &mut out, symbol);
    }
    out
}

/// Repair STT text using the ontology plus extra catalog symbols.
pub fn repair_transcript(raw: &str, catalog: &[String]) -> Repair {
    let original = raw.trim();
    if original.is_empty() {
        return Repair::blank("");
    }
    let mut tokens = tokenize(original);
    if tokens.is_empty() {
        return Repair::blank(original);
    }

    let universe = InstrumentUniverse::new(catalog);
    repair_size_mishear(&mut tokens);
    let mut slots = instrument_slots(&tokens);
    slots.sort_by_key(|slot| slot.index);
    slots.dedup_by_key(|slot| slot.index);
    let mut hits: Vec<LexiconHit> = Vec::new();
    let mut hit_seen = HashSet::new();
    let mut proposed_confusables: Vec<ProposedConfusable> = Vec::new();
    let mut proposed_seen = HashSet::new();

    for slot in slots.into_iter().rev() {
        let Some((consumed, hit)) = resolve_instrument(&tokens, slot.index, slot.fuzzy, &universe)
        else {
            continue;
        };
        match hit {
            SlotHit::Confusable { surface, target } => {
                if proposed_seen.insert(surface.to_ascii_lowercase()) {
                    proposed_confusables.push(ProposedConfusable { surface, target });
                }
            }
            SlotHit::Canonical(canonical) => {
                tokens[slot.index] = canonical.clone();
                for _ in 1..consumed {
                    if slot.index + 1 < tokens.len() {
                        tokens.remove(slot.index + 1);
                    }
                }
                if hit_seen.insert(canonical.to_ascii_lowercase()) {
                    hits.push(LexiconHit {
                        surface_form: canonical.clone(),
                        normalized_target: canonical,
                        kind: "instrument".to_string(),
                        source: "auto".to_string(),
                    });
                }
            }
        }
    }

    // Instruments already in-domain (said ETH, not repaired from a slot miss).
    for token in &tokens {
        if let Some(canonical) = universe.canonical_instrument(token) {
            if hit_seen.insert(canonical.to_ascii_lowercase()) {
                hits.push(LexiconHit {
                    surface_form: canonical.clone(),
                    normalized_target: canonical,
                    kind: "instrument".to_string(),
                    source: "auto".to_string(),
                });
            }
        }
    }

    let text = tokens.join(" ");
    let repaired_from = if text != original {
        Some(original.to_string())
    } else {
        None
    };
    Repair {
        text,
        hits,
        repaired_from,
        proposed_confusables,
    }
}

struct InstrumentUniverse {
    by_surface: HashMap<String, String>,
    confusable: HashMap<String, String>,
    alias_surfaces: Vec<(String, String)>,
}

impl InstrumentUniverse {
    fn new(catalog: &[String]) -> Self {
        let ont = ontology();
        let mut by_surface = ont.instrument_by_surface.clone();
        for symbol in catalog {
            let trimmed = symbol.trim();
            if trimmed.len() < 2 {
                continue;
            }
            by_surface
                .entry(trimmed.to_ascii_lowercase())
                .or_insert_with(|| trimmed.to_string());
        }
        let alias_surfaces: Vec<(String, String)> = by_surface
            .iter()
            .filter(|(surface, _)| !surface.contains(' ') && surface.len() >= 3)
            .map(|(surface, target)| (surface.clone(), target.clone()))
            .collect();
        Self {
            by_surface,
            confusable: ont.confusable_by_surface.clone(),
            alias_surfaces,
        }
    }

    fn canonical_instrument(&self, token: &str) -> Option<String> {
        self.by_surface.get(&token.to_ascii_lowercase()).cloned()
    }

    fn resolve_slot(&self, surface: &str, fuzzy: bool) -> Option<SlotHit> {
        let key = normalize_key(surface);
        if key.is_empty() {
            return None;
        }
        if let Some(target) = self.by_surface.get(&key) {
            return Some(SlotHit::Canonical(target.clone()));
        }
        if !fuzzy {
            return None;
        }
        if let Some(target) = self.confusable.get(&key) {
            return Some(SlotHit::Confusable {
                surface: surface.to_string(),
                target: target.clone(),
            });
        }
        if key.contains(' ') {
            return None;
        }
        if key.len() < 3 {
            return None;
        }
        nearest_alias(&key, &self.alias_surfaces).map(SlotHit::Canonical)
    }
}

fn nearest_alias(token: &str, aliases: &[(String, String)]) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for (surface, target) in aliases {
        let dist = levenshtein(token, surface);
        if dist == 0 {
            return Some(target.clone());
        }
        if dist > MAX_EDIT_DISTANCE {
            continue;
        }
        match &best {
            None => best = Some((dist, target.clone())),
            Some((best_dist, best_target)) => {
                if dist < *best_dist {
                    best = Some((dist, target.clone()));
                } else if dist == *best_dist && best_target != target {
                    return None;
                }
            }
        }
    }
    best.map(|(_, target)| target)
}

fn tokenize(raw: &str) -> Vec<String> {
    let lower = raw.to_ascii_lowercase();
    let mut out = String::new();
    for ch in lower.chars() {
        if ch == '$' {
            continue;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace()
        .map(str::to_string)
        .filter(|tok| !tok.is_empty())
        .collect()
}

fn is_number_token(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|c| c.is_ascii_digit())
}

fn is_buy_or_sell(token: &str) -> bool {
    token == "buy" || token == "sell"
}

fn is_instrument_act(token: &str) -> bool {
    matches!(
        token,
        "buy" | "sell" | "long" | "short" | "lend" | "borrow" | "watch" | "if"
    )
}

fn is_size_filler(token: &str, ont: &Ontology) -> bool {
    is_number_token(token)
        || ont.size_words.contains(token)
        || ont.units.contains(token)
        || token == "a"
        || token == "the"
        || token == "open"
}

/// `$550` / `550` → `fifty` only in a buy/sell + (dollars) worth of frame.
fn repair_size_mishear(tokens: &mut Vec<String>) {
    if !tokens.iter().any(|t| is_buy_or_sell(t)) {
        return;
    }
    let worth_of = tokens.windows(2).any(|w| w[0] == "worth" && w[1] == "of");
    if !worth_of {
        return;
    }
    let Some(idx) = tokens.iter().position(|t| t == "550") else {
        return;
    };
    if !tokens[..idx].iter().any(|t| is_buy_or_sell(t)) {
        return;
    }
    tokens[idx] = "fifty".to_string();
    let after = idx + 1;
    if after < tokens.len() && tokens[after] == "worth" {
        tokens.insert(after, "dollars".to_string());
    }
}

struct Slot {
    index: usize,
    fuzzy: bool,
}

fn instrument_slots(tokens: &[String]) -> Vec<Slot> {
    let ont = ontology();
    let mut slots = Vec::new();
    let mut marked = HashSet::new();

    let frames: &[&[&str]] = &[
        &["dollars", "worth", "of"],
        &["bucks", "worth", "of"],
        &["worth", "of"],
        &["dollars", "of"],
        &["bucks", "of"],
    ];
    for frame in frames {
        let mut i = 0;
        while i + frame.len() <= tokens.len() {
            if tokens[i..i + frame.len()] == **frame {
                let index = i + frame.len();
                if index < tokens.len() && marked.insert(index) {
                    slots.push(Slot { index, fuzzy: true });
                }
                i += frame.len();
            } else {
                i += 1;
            }
        }
    }

    let mut i = 0;
    while i < tokens.len() {
        if is_instrument_act(&tokens[i]) {
            let fuzzy = is_buy_or_sell(&tokens[i]);
            let mut j = i + 1;
            while j < tokens.len() && is_size_filler(&tokens[j], ont) {
                j += 1;
            }
            if j < tokens.len() && tokens[j] != "worth" && tokens[j] != "of" && marked.insert(j) {
                slots.push(Slot { index: j, fuzzy });
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    slots
}

fn resolve_instrument(
    tokens: &[String],
    start: usize,
    fuzzy: bool,
    universe: &InstrumentUniverse,
) -> Option<(usize, SlotHit)> {
    if start >= tokens.len() {
        return None;
    }
    if start + 1 < tokens.len() {
        let phrase = format!("{} {}", tokens[start], tokens[start + 1]);
        if let Some(hit) = universe.resolve_slot(&phrase, fuzzy) {
            return Some((2, hit));
        }
    }
    universe
        .resolve_slot(&tokens[start], fuzzy)
        .map(|hit| (1, hit))
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(raw: &str) -> Repair {
        repair_transcript(raw, &[])
    }

    fn text(raw: &str) -> String {
        repair(raw).text
    }

    #[test]
    fn ontology_version_is_one() {
        assert_eq!(ONTOLOGY_VERSION, 1);
        assert!(!boostable_keyterms().is_empty());
    }

    #[test]
    fn beef_in_worth_of_frame_proposes_eth_not_rewrite() {
        let out = repair("buy fifty dollars worth of beef");
        assert_eq!(out.text, "buy fifty dollars worth of beef");
        assert!(out.repaired_from.is_none());
        assert!(out.hits.is_empty());
        assert_eq!(out.proposed_confusables.len(), 1);
        assert_eq!(out.proposed_confusables[0].surface, "beef");
        assert_eq!(out.proposed_confusables[0].target, "ETH");
    }

    #[test]
    fn these_in_worth_of_frame_proposes_eth_not_rewrite() {
        let out = repair("buy fifty dollars worth of these");
        assert_eq!(out.text, "buy fifty dollars worth of these");
        assert_eq!(out.proposed_confusables[0].target, "ETH");
        assert!(out.hits.is_empty());
    }

    #[test]
    fn eth_in_worth_of_frame_stays_eth() {
        let out = repair("buy fifty dollars worth of ETH");
        assert_eq!(out.text, "buy fifty dollars worth of ETH");
        assert!(out.hits.iter().any(|h| h.normalized_target == "ETH"));
        assert_eq!(out.hits.len(), 1);
    }

    #[test]
    fn cancel_these_watches_is_not_rewritten() {
        assert_eq!(text("cancel these watches"), "cancel these watches");
        let out = repair("cancel these watches");
        assert!(out.hits.is_empty());
    }

    #[test]
    fn dollar_550_in_worth_of_frame_becomes_fifty() {
        assert_eq!(
            text("buy $550 worth of ETH"),
            "buy fifty dollars worth of ETH"
        );
        assert_eq!(
            text("buy 550 dollars worth of ETH"),
            "buy fifty dollars worth of ETH"
        );
    }

    #[test]
    fn fifteen_is_not_rewritten() {
        assert_eq!(
            text("buy 15 dollars worth of ETH"),
            "buy 15 dollars worth of ETH"
        );
    }

    #[test]
    fn empty_portfolio_keyterms_include_core_tokens() {
        let terms = seed_keyterms(&[], &[]);
        let lower: Vec<String> = terms.iter().map(|t| t.to_ascii_lowercase()).collect();
        assert!(lower.iter().any(|t| t == "eth"));
        assert!(lower.iter().any(|t| t == "buy"));
        assert!(lower.iter().any(|t| t == "worth"));
        assert!(!lower.iter().any(|t| t == "beef" || t == "these"));
        assert!(terms.len() <= EXTRA_KEYTERM_BUDGET);
    }

    #[test]
    fn catalog_symbols_join_the_universe() {
        let out = repair_transcript("buy fifty dollars worth of xyz", &["XYZ".to_string()]);
        assert_eq!(out.text, "buy fifty dollars worth of XYZ");
    }

    #[test]
    fn eath_near_miss_proposes_eth() {
        let out = repair("buy fifty dollars worth of eath");
        assert_eq!(out.text, "buy fifty dollars worth of eath");
        assert_eq!(out.proposed_confusables[0].target, "ETH");
    }

    #[test]
    fn buy_it_proposes_eth_cancel_it_does_not() {
        let buy = repair("buy it");
        assert_eq!(buy.text, "buy it");
        assert_eq!(buy.proposed_confusables[0].target, "ETH");
        assert_eq!(text("cancel it"), "cancel it");
        assert_eq!(text("watch these"), "watch these");
        let sell = repair("sell these");
        assert_eq!(sell.text, "sell these");
        assert_eq!(sell.proposed_confusables[0].target, "ETH");
    }

    #[test]
    fn wrapped_ether_maps_to_weth() {
        assert_eq!(
            text("buy fifty dollars worth of wrapped ether"),
            "buy fifty dollars worth of WETH"
        );
    }

    #[test]
    fn intensifier_ranks_instruments_above_acts() {
        assert_eq!(intensifier_for("ETH"), 5);
        assert_eq!(intensifier_for("buy"), 3);
        assert_eq!(intensifier_for("worth"), 3);
        assert_eq!(intensifier_for("the loop"), 2);
    }
}
