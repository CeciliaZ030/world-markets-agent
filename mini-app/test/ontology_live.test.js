import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  correctLiveTranscript,
  annotateLiveTranscript,
  setOntologyEntries,
} = require("../static/ontology_live.js");

test("live transcript rewrites instrument aliases", () => {
  assert.equal(correctLiveTranscript("buy fifty dollars worth of ether"), "buy fifty dollars worth of ETH");
  assert.equal(correctLiveTranscript("sell bitcoin"), "sell WBTC");
  assert.equal(correctLiveTranscript("watch solana"), "watch SOL");
});

test("live transcript maps phonetic ETH/SOL misses only", () => {
  setOntologyEntries([
    { surface_form: "ether", normalized_target: "ETH", kind: "instrument" },
    { surface_form: "east", normalized_target: "ETH", kind: "confusable" },
    { surface_form: "eath", normalized_target: "ETH", kind: "confusable" },
    { surface_form: "soul", normalized_target: "SOL", kind: "confusable" },
    { surface_form: "beef", normalized_target: "ETH", kind: "confusable" },
    { surface_form: "it", normalized_target: "ETH", kind: "confusable" },
    { surface_form: "these", normalized_target: "ETH", kind: "confusable" },
  ]);
  assert.equal(correctLiveTranscript("buy one east"), "buy one ETH");
  assert.equal(correctLiveTranscript("sell soul"), "sell SOL");
  assert.equal(correctLiveTranscript("buy fifty of beef"), "buy fifty of beef");
  assert.equal(correctLiveTranscript("watch it"), "watch it");
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

test("annotateLiveTranscript marks rewritten instrument spans", () => {
  setOntologyEntries([
    { surface_form: "ether", normalized_target: "ETH", kind: "instrument" },
    { surface_form: "bitcoin", normalized_target: "WBTC", kind: "instrument" },
  ]);
  const spans = annotateLiveTranscript("buy fifty dollars worth of ether");
  const ether = spans.find((span) => span.surface.toLowerCase() === "ether");
  assert.equal(ether.display, "ETH");
  assert.equal(ether.rewritten, true);
  const buy = spans.find((span) => span.surface === "buy");
  assert.equal(buy.rewritten, false);
  assert.equal(buy.display, "buy");
});

test("annotateLiveTranscript leaves confusables unmarked", () => {
  setOntologyEntries([
    { surface_form: "ether", normalized_target: "ETH", kind: "instrument" },
    { surface_form: "beef", normalized_target: "ETH", kind: "confusable" },
  ]);
  const spans = annotateLiveTranscript("buy fifty of beef");
  const beef = spans.find((span) => span.surface === "beef");
  assert.equal(beef.display, "beef");
  assert.equal(beef.rewritten, false);
});
