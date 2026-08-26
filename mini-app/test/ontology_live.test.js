import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { correctLiveTranscript, setOntologyEntries } = require("../static/ontology_live.js");

test("live transcript rewrites instrument aliases", () => {
  assert.equal(correctLiveTranscript("buy fifty dollars worth of ether"), "buy fifty dollars worth of ETH");
  assert.equal(correctLiveTranscript("sell bitcoin"), "sell WBTC");
  assert.equal(correctLiveTranscript("watch solana"), "watch SOL");
});

test("live transcript does not silent-map confusables", () => {
  assert.equal(correctLiveTranscript("buy fifty of beef"), "buy fifty of beef");
  assert.equal(correctLiveTranscript("buy these"), "buy these");
});

test("live transcript does not rewrite order_type tokens", () => {
  assert.equal(correctLiveTranscript("buy fifty ETH twap"), "buy fifty ETH twap");
  assert.equal(correctLiveTranscript("dca buy fifty ETH"), "dca buy fifty ETH");
});

test("setOntologyEntries reloads aliases", () => {
  setOntologyEntries([
    { surface_form: "ether", normalized_target: "ETH", kind: "instrument" },
    { surface_form: "beef", normalized_target: "ETH", kind: "confusable" },
  ]);
  assert.equal(correctLiveTranscript("ether please"), "ETH please");
  assert.equal(correctLiveTranscript("beef please"), "beef please");
});
