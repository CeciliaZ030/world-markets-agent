use aomi_sdk::*;

mod client;
mod liquidation_risk;
mod lookups;
mod mandate;
mod pnl;
mod reporting;
mod tool;

const PREAMBLE: &str = "You are the World Markets Agent on UniFi testnet. \
**Terse lookups (whole message only):** when the user sends exactly one token — \
`b`, `p`, `r`, `a`, `d`, or the words balance, positions, risk, available, dollarpower \
(case-insensitive, nothing else) — it is a read-only lookup, not a typo. \
Call the tool from the lookups skill section immediately and reply with **exactly one line** \
from the format table. Never ask what they meant. Never list capabilities. Never greet. \
`/help` is the host REPL (quit/reset); you do not register slash commands. \
All other behavior is in the Application Skill sections below.";

dyn_aomi_app!(
    app = tool::WorldMarketsApp,
    name = "world-markets",
    version = "0.3.0",
    preamble = PREAMBLE,
    tools = [
        tool::ListWorldAssets,
        tool::GetWorldAccount,
        tool::GetWorldMarket,
        tool::PreviewWorldTrade,
        tool::CheckWorldMandate,
        tool::GetWorldAgentPermission,
        tool::GetWorldOpenOrders,
        tool::GetWorldPnl,
        tool::PreviewAccountEffect,
        tool::ComputeResize,
        tool::PreviewExit,
        tool::PlanLargeOrder,
        tool::GetDollarpower,
        tool::SimulateGuardianUnwind,
        tool::CheckNegativeCarry,
    ],
    namespaces = ["evm-core"],
    skill = {
        id: "world-markets/trading",
        sections: {
            instructions: "skill/instructions.md",
            lookups: "skill/lookups.md",
            workflows: "skill/workflows.md",
            action_rules: "skill/action-rules.md",
            safety: "skill/safety.md",
            atlas: "skill/reference/atlas.md",
            products: "skill/reference/products.md",
            account_model: "skill/reference/account-model.md",
            venue: "skill/reference/venue.md",
            dollarpower: "skill/reference/dollarpower.md",
            guardian: "skill/reference/guardian.md",
            notifications: "skill/reference/notifications.md",
        },
    }
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_skill_is_valid_and_mandate_aware() {
        let skill = tool::WorldMarketsApp::default()
            .skill()
            .expect("World Markets must ship its app-scoped skill");

        assert_eq!(skill.id, "world-markets/trading");
        assert_eq!(
            skill
                .sections
                .iter()
                .map(|section| section.name.as_str())
                .collect::<Vec<_>>(),
            [
                "instructions",
                "lookups",
                "workflows",
                "action_rules",
                "safety",
                "atlas",
                "products",
                "account_model",
                "venue",
                "dollarpower",
                "guardian",
                "notifications",
            ]
        );
        assert!(skill.guard.is_none());
        assert!(skill.hooks.is_empty());
        skill
            .validate("world-markets")
            .expect("embedded app skill must satisfy the SDK contract");
    }
}
