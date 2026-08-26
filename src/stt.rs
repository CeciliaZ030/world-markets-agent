//! Speech-to-text for Mini App / chat voice ingest.
//!
//! Deepgram is required for F11 keyterm boost. Whisper is a fallback that
//! transcribes but cannot apply the lexicon to the recognizer.

use serde_json::Value;

const DEEPGRAM_URL: &str = "https://api.deepgram.com/v1/listen";
const WHISPER_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const MAX_KEYTERMS: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    pub words: Vec<Word>,
    pub lang: String,
    pub stt_version: String,
    pub keyterm_applied: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub w: String,
    pub conf: f64,
    pub t0: f64,
    pub t1: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SttError {
    pub kind: SttErrorKind,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SttErrorKind {
    Empty,
    Unconfigured,
    Provider,
}

impl SttError {
    fn empty() -> Self {
        Self {
            kind: SttErrorKind::Empty,
            detail: "didn't catch any speech".to_string(),
        }
    }

    fn unconfigured() -> Self {
        Self {
            kind: SttErrorKind::Unconfigured,
            detail: "speech recognition is not configured — set DEEPGRAM_API_KEY or OPENAI_API_KEY"
                .to_string(),
        }
    }

    fn provider(detail: impl Into<String>) -> Self {
        Self {
            kind: SttErrorKind::Provider,
            detail: detail.into(),
        }
    }
}

pub fn transcribe(audio: &[u8], mime: &str, keyterms: &[String]) -> Result<Transcript, SttError> {
    if audio.is_empty() {
        return Err(SttError::empty());
    }
    let content_type = if mime.is_empty() { "audio/webm" } else { mime };
    if let Ok(key) = std::env::var("DEEPGRAM_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return deepgram(audio, content_type, &key, keyterms);
        }
    }
    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return whisper(audio, content_type, &key);
        }
    }
    Err(SttError::unconfigured())
}

fn deepgram(
    audio: &[u8],
    content_type: &str,
    key: &str,
    keyterms: &[String],
) -> Result<Transcript, SttError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| SttError::provider(err.to_string()))?;
    let mut request = client
        .post(DEEPGRAM_URL)
        .query(&[
            ("model", "nova-2"),
            ("smart_format", "true"),
            ("punctuate", "true"),
        ])
        .header("Authorization", format!("Token {key}"))
        .header("Content-Type", content_type)
        .body(audio.to_vec());
    for term in keyterms.iter().take(MAX_KEYTERMS) {
        let trimmed = term.trim();
        if trimmed.len() < 2 {
            continue;
        }
        request = request.query(&[("keywords", format!("{trimmed}:2"))]);
    }
    let keyterm_applied = !keyterms.is_empty();
    let response = request
        .send()
        .map_err(|err| SttError::provider(format!("deepgram is not reachable ({err})")))?;
    if !response.status().is_success() {
        return Err(SttError::provider(format!(
            "deepgram rejected the audio (HTTP {})",
            response.status()
        )));
    }
    let value: Value = response
        .json()
        .map_err(|err| SttError::provider(format!("deepgram returned invalid JSON ({err})")))?;
    parse_deepgram(value, keyterm_applied)
}

fn parse_deepgram(value: Value, keyterm_applied: bool) -> Result<Transcript, SttError> {
    let alt = value
        .pointer("/results/channels/0/alternatives/0")
        .cloned()
        .unwrap_or(Value::Null);
    let text = alt
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(SttError::empty());
    }
    let words = alt
        .get("words")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let w = row
                        .get("word")
                        .or_else(|| row.get("punctuated_word"))
                        .and_then(Value::as_str)?
                        .to_string();
                    Some(Word {
                        w,
                        conf: row.get("confidence").and_then(Value::as_f64).unwrap_or(0.0),
                        t0: row.get("start").and_then(Value::as_f64).unwrap_or(0.0),
                        t1: row.get("end").and_then(Value::as_f64).unwrap_or(0.0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Transcript {
        text,
        words,
        lang: "en".to_string(),
        stt_version: "deepgram:nova-2".to_string(),
        keyterm_applied,
    })
}

fn whisper(audio: &[u8], content_type: &str, key: &str) -> Result<Transcript, SttError> {
    let ext = extension_for(content_type);
    let part = reqwest::blocking::multipart::Part::bytes(audio.to_vec())
        .file_name(format!("note.{ext}"))
        .mime_str(content_type)
        .map_err(|err| SttError::provider(err.to_string()))?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("model", "whisper-1")
        .part("file", part);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|err| SttError::provider(err.to_string()))?;
    let response = client
        .post(WHISPER_URL)
        .header("Authorization", format!("Bearer {key}"))
        .multipart(form)
        .send()
        .map_err(|err| SttError::provider(format!("whisper is not reachable ({err})")))?;
    if !response.status().is_success() {
        return Err(SttError::provider(format!(
            "whisper rejected the audio (HTTP {})",
            response.status()
        )));
    }
    let value: Value = response
        .json()
        .map_err(|err| SttError::provider(format!("whisper returned invalid JSON ({err})")))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(SttError::empty());
    }
    Ok(Transcript {
        text,
        words: Vec::new(),
        lang: value
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("en")
            .to_string(),
        stt_version: "openai:whisper-1".to_string(),
        keyterm_applied: false,
    })
}

fn extension_for(content_type: &str) -> &'static str {
    if content_type.contains("ogg") {
        "ogg"
    } else if content_type.contains("mp4") || content_type.contains("m4a") {
        "m4a"
    } else if content_type.contains("mpeg") || content_type.contains("mp3") {
        "mp3"
    } else if content_type.contains("wav") {
        "wav"
    } else {
        "webm"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_audio_fails_closed() {
        let err = transcribe(&[], "audio/webm", &[]).unwrap_err();
        assert_eq!(err.kind, SttErrorKind::Empty);
    }

    #[test]
    fn deepgram_parse_reads_words() {
        let parsed = parse_deepgram(
            json!({
                "results": {
                    "channels": [{
                        "alternatives": [{
                            "transcript": "buy weth",
                            "words": [
                                { "word": "buy", "confidence": 0.99, "start": 0.0, "end": 0.2 },
                                { "word": "weth", "confidence": 0.8, "start": 0.2, "end": 0.5 }
                            ]
                        }]
                    }]
                }
            }),
            true,
        )
        .unwrap();
        assert_eq!(parsed.text, "buy weth");
        assert_eq!(parsed.words.len(), 2);
        assert_eq!(parsed.words[1].w, "weth");
        assert!(parsed.keyterm_applied);
    }
}
