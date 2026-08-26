//! Mini App / chat voice ingest. STT + brain records + compose into the agent.
//! Does not submit orders. Does not call The Desk.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

use crate::brain::BrainClient;
use crate::speech_ontology::{self, Repair};
use crate::stt::{self, SttErrorKind, Transcript};

const CATALOG_TTL: Duration = Duration::from_secs(60);

pub fn ingest_voice(account_id: u64, body: &Value) -> Result<Value, String> {
    let brain = BrainClient::with_timeout(90);
    let extra = seed_keyterms(account_id);
    let keyterms = brain
        .voice_keyterms(account_id, &extra)
        .unwrap_or_else(|_| extra.clone());
    let typed = body
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let live_text = body
        .get("live_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut transcript = if let Some(text) = typed {
        Transcript {
            text: text.to_string(),
            words: Vec::new(),
            lang: "en".to_string(),
            stt_version: "typed".to_string(),
            keyterm_applied: false,
        }
    } else {
        let audio = decode_audio(body)?;
        let mime = body
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or("audio/webm");
        stt::transcribe(&audio, mime, &keyterms).map_err(stt_message)?
    };
    if typed.is_none() {
        if let Some(live) = live_text {
            transcript.text = choose_transcript(&transcript.text, Some(live));
        }
    }

    let catalog = cached_catalog_symbols();
    let repair = if typed.is_some() {
        Repair {
            text: transcript.text.clone(),
            hits: Vec::new(),
            repaired_from: None,
            proposed_confusables: Vec::new(),
        }
    } else {
        speech_ontology::repair_transcript(&transcript.text, &catalog)
    };
    let raw_text = transcript.text.clone();
    transcript.text = repair.text.clone();
    let proposed_confusables: Vec<Value> = repair
        .proposed_confusables
        .iter()
        .map(|row| row.to_json())
        .collect();
    let lexicon_hits: Vec<Value> = repair.hits.iter().map(|hit| hit.to_json()).collect();
    let repaired_from = repair
        .repaired_from
        .as_deref()
        .filter(|value| *value != transcript.text.as_str())
        .or_else(|| {
            if raw_text != transcript.text {
                Some(raw_text.as_str())
            } else {
                None
            }
        });

    let duration_secs = body
        .get("duration_secs")
        .and_then(Value::as_f64)
        .or_else(|| {
            body.get("duration_ms")
                .and_then(Value::as_f64)
                .map(|ms| ms / 1000.0)
        });

    let words: Vec<Value> = transcript
        .words
        .iter()
        .map(|w| {
            json!({
                "w": w.w,
                "conf": w.conf,
                "t0": w.t0,
                "t1": w.t1,
            })
        })
        .collect();

    let recorded = brain
        .ingest_utterance(&json!({
            "account_id": account_id,
            "transcript": transcript.text,
            "repaired_from": repaired_from,
            "words": words,
            "lang": transcript.lang,
            "stt_version": transcript.stt_version,
            "keyterm_applied": transcript.keyterm_applied,
            "duration_secs": duration_secs,
            "audio_base64": body.get("audio_base64"),
            "source": body.get("source").and_then(Value::as_str).unwrap_or("mini_app"),
            "foreign": false,
            "lexicon_hits": lexicon_hits,
            "proposed_confusables": proposed_confusables,
        }))
        .unwrap_or_else(|_| json!({ "heard_echo": transcript.text }));

    let utterance_id = recorded
        .pointer("/utterance/id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let episode_id = recorded
        .pointer("/episode/id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let correlation_id = if utterance_id.is_empty() {
        format!(
            "voice-{account_id}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        utterance_id.clone()
    };

    let send_payload = json!({
        "kind": "voice",
        "message": transcript.text,
        "utterance_id": utterance_id,
        "correlation_id": correlation_id,
        "episode_id": episode_id,
    });

    Ok(json!({
        "ok": true,
        "transcript": transcript.text,
        "heard_echo": recorded.get("heard_echo").and_then(Value::as_str).unwrap_or(&transcript.text),
        "utterance_id": utterance_id,
        "episode_id": episode_id,
        "correlation_id": correlation_id,
        "stt_version": transcript.stt_version,
        "keyterm_applied": transcript.keyterm_applied,
        "long_note": recorded.get("long_note"),
        "long_note_line": recorded.get("long_note_line"),
        "split_parse": recorded.get("split_parse"),
        "proposed_confusables": proposed_confusables,
        "send_payload": send_payload,
    }))
}

fn decode_audio(body: &Value) -> Result<Vec<u8>, String> {
    let raw = body
        .get("audio_base64")
        .and_then(Value::as_str)
        .ok_or_else(|| "audio is required".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| "audio is not valid base64".to_string())?;
    if bytes.is_empty() {
        return Err("didn't catch any speech".to_string());
    }
    if bytes.len() > 5_000_000 {
        return Err("voice note is too long".to_string());
    }
    Ok(bytes)
}

fn choose_transcript(stt: &str, live_text: Option<&str>) -> String {
    let stt = stt.trim();
    let live = live_text.map(str::trim).filter(|value| !value.is_empty());
    let Some(live) = live else {
        return stt.to_string();
    };
    if stt.is_empty() || is_placeholder_transcript(stt) {
        if live.split_whitespace().count() >= 3 || live.len() > stt.len() {
            return live.to_string();
        }
    }
    stt.to_string()
}

fn is_placeholder_transcript(text: &str) -> bool {
    let normalized = text
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_punctuation())
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "hi" | "hello"
            | "hey"
            | "thanks"
            | "thank you"
            | "thanks for watching"
            | "you"
            | "hmm"
            | "um"
            | "uh"
            | "yes"
            | "yeah"
            | "ok"
            | "okay"
            | "the"
            | "a"
    )
}

fn seed_keyterms(account_id: u64) -> Vec<String> {
    speech_ontology::seed_keyterms(&cached_catalog_symbols(), &holdings(account_id))
}

fn holdings(account_id: u64) -> Vec<String> {
    match crate::mini_app::load_portfolio(account_id) {
        Ok(snap) => snap
            .positions
            .into_iter()
            .map(|row| row.symbol)
            .filter(|symbol| symbol.len() >= 2)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn cached_catalog_symbols() -> Vec<String> {
    struct CatalogCache {
        at: Instant,
        symbols: Vec<String>,
    }
    static CACHE: Mutex<Option<CatalogCache>> = Mutex::new(None);
    let Ok(mut guard) = CACHE.lock() else {
        return catalog_symbols_uncached();
    };
    if let Some(cache) = guard.as_ref() {
        if cache.at.elapsed() < CATALOG_TTL {
            return cache.symbols.clone();
        }
    }
    let symbols = catalog_symbols_uncached();
    *guard = Some(CatalogCache {
        at: Instant::now(),
        symbols: symbols.clone(),
    });
    symbols
}

fn catalog_symbols_uncached() -> Vec<String> {
    match crate::mini_app::load_products() {
        Ok(snap) => {
            let mut seen = std::collections::HashSet::new();
            snap.products
                .into_iter()
                .map(|row| row.symbol)
                .filter(|symbol| symbol.len() >= 2 && seen.insert(symbol.to_ascii_lowercase()))
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

fn stt_message(err: crate::stt::SttError) -> String {
    match err.kind {
        SttErrorKind::Empty => err.detail,
        SttErrorKind::Unconfigured => err.detail,
        SttErrorKind::Provider => err.detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_stt_yields_to_live_words() {
        assert_eq!(
            choose_transcript("Hi", Some("buy fifty dollars of eth")),
            "buy fifty dollars of eth"
        );
        assert_eq!(
            choose_transcript("Thank you.", Some("buy 50 dollars of ether")),
            "buy 50 dollars of ether"
        );
    }

    #[test]
    fn real_stt_wins_over_live_words() {
        assert_eq!(
            choose_transcript("buy fifty dollars of ETH", Some("by 15 of it")),
            "buy fifty dollars of ETH"
        );
    }

    #[test]
    fn empty_stt_uses_live_words() {
        assert_eq!(choose_transcript("", Some("sell all sol")), "sell all sol");
    }

    #[test]
    fn lexicon_hits_do_not_auto_map_confusable_beef() {
        let repair = speech_ontology::repair_transcript("buy fifty dollars worth of beef", &[]);
        assert_eq!(repair.text, "buy fifty dollars worth of beef");
        assert!(repair.hits.is_empty());
        assert_eq!(repair.proposed_confusables.len(), 1);
        assert_eq!(repair.proposed_confusables[0].target, "ETH");
    }
}
