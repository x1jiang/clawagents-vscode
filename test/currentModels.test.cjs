const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-astra-"));
function load(name) {
  const outfile = path.join(dir, `${name}.cjs`);
  buildSync({ entryPoints: [path.join(__dirname, "../webview/src", `${name}.ts`)], outfile, bundle:true, platform:"node", format:"cjs", logLevel:"silent" });
  return require(outfile);
}
const catalog = load("providerCatalog");
const selection = load("modelSelection");
const pricing = load("pricing");
const context = load("contextWindow");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test("Newest tool-capable models appear offline", () => {
 const models = id => catalog.FALLBACK_PROVIDERS.find(p=>p.id===id).models.map(m=>m.id);
 for (const m of ["claude-fable-5-1","claude-opus-5","claude-sonnet-5"]) assert(models("anthropic").includes(m));
 assert(models("xai").includes("grok-4.6"));
});
test("Reasoning controls match current provider capabilities", () => {
 for(const m of ["claude-fable-5-1","claude-opus-5","anthropic.claude-sonnet-5"]){
  assert(selection.modelSupportsEffort(m));
  assert.deepEqual(selection.effortOptionsForModel(m).map(o=>o.value),["low","medium","high","xhigh","max"]);
 }
 assert(selection.modelSupportsEffort("grok-4.6"));
 assert.deepEqual(selection.effortOptionsForModel("grok-4.6").map(o=>o.value),["low","medium","high","xhigh"]);
 assert(selection.modelSupportsEffort("gemini-3.8-flash"));
 assert.deepEqual(selection.effortOptionsForModel("gemini-3.8-flash").map(o=>o.value),["low","medium","high"]);
});
test("Context and price estimates use current cards",()=>{
 assert.equal(context.contextWindowFor("grok-4.6"),500000);
 assert.equal(context.contextWindowFor("gemini-3.8-flash"),1048576);
 for(const m of ["gpt-5.4","gpt-5.5"]) assert.equal(context.contextWindowFor(m),1050000);
 assert.equal(context.contextWindowFor("gpt-5.4-mini"),400000);
 assert.equal(pricing.estimateCostUsd("claude-fable-5-1",100000,10000),1.5);
 assert.equal(pricing.estimateCostUsd("grok-4.6",100000,10000),.26);
 assert.equal(pricing.estimateCostUsd("gpt-5.4",300000,10000),1.725);
 assert(Math.abs(pricing.estimateCostUsd("gemini-3.6-flash",100000,10000)-.1125)<1e-12);
});

test("New Mantle vendors survive picker filtering",()=>{
 const ids=["minimax.minimax-m2.5","mistral.devstral-2-123b","qwen.qwen3-coder-next","nvidia.nemotron-super-3-120b","mistral.mistral-large-3-675b-instruct","moonshotai.kimi-k2.5"];
 const rows=catalog.expandBedrockProviderChoices([{id:"bedrock",name:"AWS",base_url:"https://bedrock-mantle.us-east-1.api.aws/v1",models:ids.map(id=>({id,label:id}))}],{iam:false,mantle:true,bag:false});
 const visible=catalog.modelsForKeys(rows,catalog.BEDROCK_SELECT_MANTLE).map(m=>m.id);
 assert.deepEqual(visible,ids);
 for(const id of ids){assert(!catalog.modelLooksLikeOllamaLocalId(id));assert.equal(catalog.mantleWireApiForModel(id),"chat_completions");}
 assert(!catalog.isMantleCatalogModelId("mistral.mistral-large-2407-v1:0"));
});
test("Unknown AWS Claude prices do not fall back to direct rates",()=>{
 for(const id of ["anthropic.claude-opus-5","anthropic.claude-sonnet-5","us.anthropic.claude-fable-5-1"]) assert.equal(pricing.estimateCostUsd(id,1000,1000),null);
});

test("Switching models maps stale effort to a supported choice",()=>{
 assert.equal(selection.compatibleEffortForModel("gemini-3.8-flash","max"),"high");
 assert.equal(selection.compatibleEffortForModel("grok-4.6","none"),"low");
 assert.equal(selection.compatibleEffortForModel("claude-fable-5-1","minimal"),"low");
 assert.equal(selection.compatibleEffortForModel("gpt-6-astra","max"),"max");
 assert.equal(selection.compatibleEffortForModel("gemini-3.8-flash",""),"");
});

test("Mantle Grok4.6 uses its own endpoint and regional price",()=>{
 assert(catalog.MANTLE_FALLBACK_MODELS.some(m=>m.id==="xai.grok-4.6"));
 assert.equal(catalog.mantleWireApiForModel("xai.grok-4.6"),"responses");
 assert(Math.abs(pricing.estimateCostUsd("xai.grok-4.6",100000,10000)-.286)<1e-12);
 assert.equal(pricing.estimateCostUsd("global.xai.grok-4.6",100000,10000),.26);
});
