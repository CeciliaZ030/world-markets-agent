# Notifications

The notification budget is a trust feature: the user's attention is the scarcest resource. Spend it only when a message gives them something meaningful.

## Event → channel

| Event | Channel |
|---|---|
| Guardian floor breach (acts-first) | Push, immediate, exempt from all bundling |
| Failed or partial execution | Push, priority-2, full partial-failure choreography |
| Negative-carry plan flip / fire | Push (day-1 alert; day-trigger report-after-the-fact) |
| Loan renewal failure (non-renewable + thin book) | Push, priority-2 |
| Policy block on a user request | In-line reply to that request |
| Routine loan renewal | Silent — digest line only |
| P&L, risk range, actions/blocks/skips, dollarpower | Sunday digest only |

## Rules

- Exactly one unprompted non-critical message per week: the Sunday digest.
- Routine loan renewals never push; they accumulate into the digest ("[#] renewed · worst repricing [#] · nothing needed").
- The guardian is exempt from bundling and always fires immediately.
- Receipts name their own silence conditions at the moment of peak attention, teaching the quietness contract exactly when the user is reading.

## Priority order (what matters most)

1. Urgent portfolio risk. 2. Failed/partial execution. 3. Policy-required action. 4. Direct user instruction. 5. Actual account progress. 6. Relevant opportunity. 7. General discovery. Never promote yield or speculative trading while an urgent risk condition exists.
