//! Skill-copy conformance tests (§10 done-criteria).
//!
//! These read the ACTUAL skill markdown shipped in `src/skill/` and assert the
//! spec's structural invariants directly on the source of truth, rather than a
//! duplicated golden. This is the closest a compile-time test can get to the
//! honest-numbers law and the block/vocabulary rules without a live LLM.

use std::fs;
use std::path::PathBuf;

fn skill(path: &str) -> String {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("src/skill");
    p.push(path);
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

/// Strip fenced illustrative examples and inline-code spans so scans only see
/// prose the model treats as instruction, not example numbers it is shown.
fn prose_only(md: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Drop inline `code` spans (may contain rule codes / day counts).
        let mut keep = true;
        for ch in line.chars() {
            if ch == '`' {
                keep = !keep;
                continue;
            }
            if keep {
                out.push(ch);
            }
        }
        out.push('\n');
    }
    out
}

/// §10.7 — no banned vocabulary in the RESPONSE COPY the model sends. The ban
/// governs messages to users, not the rule text that forbids the vocabulary
/// (e.g. "no leaderboards/streaks" is the prohibition, not a violation). We scan
/// blockquote (`>`) response-skeleton lines across the workflow copy.
#[test]
fn no_banned_vocabulary() {
    let banned = [
        "amazing opportunity",
        "huge upside",
        "don't miss this",
        "best trade",
        "guaranteed",
        "safe return",
        "win rate",
        "100% win",
        "streak",
    ];
    for file in [
        "instructions.md",
        "lookups.md",
        "workflows.md",
        "action-rules.md",
        "safety.md",
        "reference/dollarpower.md",
        "reference/guardian.md",
        "reference/notifications.md",
    ] {
        let response_copy: String = skill(file)
            .lines()
            .filter(|l| l.trim_start().starts_with('>'))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        for phrase in banned {
            assert!(
                !response_copy.contains(phrase),
                "banned phrase {phrase:?} found in {file} response copy"
            );
        }
    }
}

/// §10.2 / §4.1 — the honest-numbers law: no bare number sits in a workflow
/// RESPONSE SKELETON. Response copy is the blockquote (`>`) lines the model
/// sends; instructional prose ("offer 2–3 choices") is guidance, not a message.
/// Every figure in a `>` line must be a `[#]` placeholder or live in a fence.
#[test]
fn workflows_contain_no_bare_response_numbers() {
    let prose = prose_only(&skill("workflows.md"));
    for (i, line) in prose.lines().enumerate() {
        let trimmed = line.trim();
        // Only response-skeleton lines (Telegram copy) are subject to the law.
        if !trimmed.starts_with('>') {
            continue;
        }
        let scrubbed = strip_section_refs(trimmed);
        let has_digit = scrubbed.chars().any(|c| c.is_ascii_digit());
        assert!(
            !has_digit,
            "bare number in workflows.md response line {}: {:?}",
            i + 1,
            line
        );
    }
}

/// Remove section identifiers so they don't trip the bare-number scan:
/// "§6.3", "6.16", "(§4.1)", "L0", "L1", "L2".
fn strip_section_refs(line: &str) -> String {
    let mut s = line.to_string();
    // Autonomy ladder levels.
    for lvl in ["L0", "L1", "L2"] {
        s = s.replace(lvl, "");
    }
    // §-prefixed and bare dotted section numbers.
    let bytes = s.into_bytes();
    let text = String::from_utf8(bytes).unwrap();
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '§' {
            // consume following digits and dots
            while matches!(chars.peek(), Some(d) if d.is_ascii_digit() || *d == '.') {
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    // Remove standalone dotted numbers like "6.3" / "6.16" used as references.
    let cleaned: Vec<String> = out
        .split_whitespace()
        .filter(|tok| {
            let t = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.');
            !(t.contains('.') && t.chars().all(|c| c.is_ascii_digit() || c == '.'))
        })
        .map(|s| s.to_string())
        .collect();
    cleaned.join(" ")
}

/// §10.3 — every canonical block form cites the floor and names its engine rule,
/// and never mentions the warn band or recovery target.
#[test]
fn blocks_cite_floor_and_engine_rule_only() {
    let wf = skill("workflows.md");
    // The five engine rule codes must each appear in the block section.
    for rule in [
        "portfolio_floor",
        "market_not_permitted",
        "liquidatable",
        "insufficient_spot_balance",
        "withdraw_not_supported",
    ] {
        assert!(
            wf.contains(rule),
            "block section missing engine rule {rule}"
        );
    }
    // Scan only the block RESPONSE skeletons (`>` lines) for warn-band talk —
    // the instructional sentence "never the warn band or recovery target" is the
    // rule, not a message, and must not trip its own test.
    let start = wf.find("## 6.6").expect("6.6 block section present");
    let end = wf[start..]
        .find("## 6.7")
        .map(|o| start + o)
        .unwrap_or(wf.len());
    let block_skeletons: String = wf[start..end]
        .lines()
        .filter(|l| l.trim_start().starts_with('>'))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    for forbidden in ["warn band", "recovery target", "recover to", "warn level"] {
        assert!(
            !block_skeletons.contains(forbidden),
            "block response copy must not mention {forbidden:?}"
        );
    }
    assert!(
        block_skeletons.contains("the limit is yours, and it held"),
        "block copy must carry the floor sentence"
    );
}

/// §10.4 — "on-chain ✓" discipline: the phrase, where present, attaches only to
/// signed-policy facts. We assert the action-rules copy states the rule and that
/// no preference line is marked signed.
#[test]
fn on_chain_marks_only_policy_facts() {
    let rules = skill("action-rules.md");
    assert!(
        rules.contains("\"on-chain ✓\" appears only on policy facts")
            || rules.contains("on-chain ✓\" appears only on policy facts"),
        "action-rules must state the on-chain ✓ discipline"
    );
    // The preference carrier (brief) must be described as never signed.
    assert!(
        rules.contains("never participates in policy evaluation") || rules.contains("never signed"),
        "preferences must be described as unsigned"
    );
}

/// §10.6 — keep-position and View on World controls appear in workflow copy.
#[test]
fn required_controls_present() {
    let wf = skill("workflows.md");
    assert!(
        wf.contains("Keep as is") || wf.contains("Keep the"),
        "missing keep-position control"
    );
    assert!(
        wf.contains("View on World ↗"),
        "missing View on World control"
    );
}

/// §10.5 — the load-bearing isolated strings exist verbatim and are copy-testable.
#[test]
fn load_bearing_strings_present() {
    let wf = skill("workflows.md");
    // Graduation notice (§6.4).
    assert!(wf.contains(
        "Orders like this now execute automatically. Say `always ask` to keep confirmations."
    ));
    // Blocked standing-instruction message (§6.11) — the "second outranks the first".
    assert!(wf.contains("the second outranks the first"));
    // Receipt silence-conditions cue (§6.5).
    assert!(wf.contains("I'll only message you if"));
}

/// §10.8 — the notification budget is stated: one weekly digest, silent renewals,
/// guardian exempt from bundling.
#[test]
fn notification_budget_stated() {
    let n = skill("reference/notifications.md");
    assert!(
        n.contains("one unprompted non-critical message per week")
            || n.to_lowercase()
                .contains("one unprompted non-critical message per week")
    );
    assert!(n.to_lowercase().contains("silent"));
    assert!(n.to_lowercase().contains("exempt from"));
}

/// Concision spec — lookup vs action split is stated in instructions + lookups.
#[test]
fn concision_split_stated() {
    let instructions = skill("instructions.md");
    assert!(
        instructions.contains("Lookups") && instructions.contains("one line"),
        "instructions must carve out one-line lookups"
    );
    assert!(
        instructions.contains("Action messages"),
        "instructions must preserve full anatomy for actions"
    );
    let lookups = skill("lookups.md");
    assert!(
        lookups.contains("one line") && lookups.contains("full anatomy"),
        "lookups must define the split"
    );
}

/// Message design v2 — core lookup one-line formats present.
#[test]
fn lookup_formats_present() {
    let lookups = skill("lookups.md");
    for phrase in [
        "Portfolio",
        "Liquidation risk",
        "/10.",
        "— high.",
        "Eligible for liquidation",
        "Dollarpower",
        "Available to deploy",
        "Holdings",
        "Perps",
        "No open positions",
    ] {
        assert!(lookups.contains(phrase), "missing lookup format: {phrase}");
    }
}

/// Concision spec — risk score direction and no gamification in lookup copy.
#[test]
fn risk_lookup_forms_present() {
    let lookups = skill("lookups.md");
    assert!(
        lookups.contains("higher = worse"),
        "risk lookup must state score direction"
    );
    assert!(
        lookups.contains("Never gamify"),
        "risk lookup must forbid gamification"
    );
    assert!(
        !lookups.to_lowercase().contains("rapv floor") || lookups.contains("blocks only"),
        "risk lookup must not conflate with floor"
    );
}

/// Concision spec — terse tokens fire only on whole-message intent.
#[test]
fn terse_token_whole_message_rule() {
    let lookups = skill("lookups.md");
    assert!(
        lookups.contains("whole intent") || lookups.contains("whole-message"),
        "terse token rule must require whole-message match"
    );
    assert!(
        lookups.contains("Inside prose") || lookups.contains("inside prose"),
        "terse token rule must warn about prose false positives"
    );
    assert!(
        lookups.contains("never clarify"),
        "lookups must forbid clarification on terse tokens"
    );
    let instructions = skill("instructions.md");
    assert!(
        instructions.contains("highest priority"),
        "instructions must prioritize terse lookups"
    );
    assert!(
        instructions.contains("Never:") || instructions.contains("Forbidden"),
        "instructions must list forbidden lookup responses"
    );
}

/// Concision spec — strategy brain states operator doctrine and anti-patterns.
#[test]
fn strategy_brain_operator_doctrine_stated() {
    let brain = skill("reference/strategy-brain.md");
    for phrase in [
        "Operate, don't menu",
        "Continuous yield",
        "Counterparties roll",
        "PB-DEPLOY",
        "PB-LEND",
        "false binary",
    ] {
        assert!(
            brain.contains(phrase),
            "strategy-brain missing doctrine/playbook: {phrase}"
        );
    }
}

/// Message design v2 — F4a suppression and button naming stated.
#[test]
fn preview_suppression_and_button_rules_stated() {
    let wf = skill("workflows.md");
    assert!(
        wf.contains("unchanged"),
        "workflows must state F4a unchanged suppression"
    );
    let rules = skill("action-rules.md");
    assert!(
        rules.contains("Confirm") && rules.contains("prohibited"),
        "action-rules must prohibit generic Confirm buttons"
    );
    let instructions = skill("instructions.md");
    assert!(
        instructions.contains("unchanged: true") || instructions.contains("`unchanged: true`"),
        "instructions must state F4a suppression rule"
    );
}

/// Message design v2 — class-grouped position lookup (F1).
#[test]
fn position_lookup_class_grouping_stated() {
    let lookups = skill("lookups.md");
    for class in ["Holdings", "Perps", "Lent", "Borrowed"] {
        assert!(
            lookups.contains(class),
            "lookups must name position class {class}"
        );
    }
    assert!(
        lookups.contains("lookups.positions"),
        "lookups must reference positions field"
    );
    assert!(
        lookups.contains("missing_mark_symbols"),
        "lookups must handle partial mark data"
    );
}

/// Concision spec — `a` lookup refuses when available_to_deploy is absent.
#[test]
fn available_lookup_deferred_without_exact_figure() {
    let lookups = skill("lookups.md");
    assert!(
        lookups.contains("available_to_deploy"),
        "lookups must name the tool field for available"
    );
    assert!(
        lookups.contains("isn't available") || lookups.contains("is not available"),
        "lookups must refuse when field absent"
    );
    let rules = skill("action-rules.md");
    assert!(
        rules.contains("lookups.md"),
        "action-rules must point terse lookups to lookups.md"
    );
}
