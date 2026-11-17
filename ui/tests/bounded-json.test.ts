import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { readBoundedJson, JsonReadRefusal, JSON_RESPONSE_MAX_BYTES } from "../src/app/bounded-json";
it("accepts the exact response byte limit and refuses one byte over before parsing", async () => {
  await expect(
    readBoundedJson(new Response(" ".repeat(JSON_RESPONSE_MAX_BYTES - 1) + "0"), {
      remaining: JSON_RESPONSE_MAX_BYTES,
    }),
  ).resolves.toBe(0);
  await expect(
    readBoundedJson(new Response(" ".repeat(JSON_RESPONSE_MAX_BYTES) + "0"), {
      remaining: JSON_RESPONSE_MAX_BYTES + 1,
    }),
  ).rejects.toBeInstanceOf(JsonReadRefusal);
});
it("shares one byte budget between concurrent reads", async () => {
  const budget = { remaining: 3 };
  const outcomes = await Promise.allSettled([
    readBoundedJson(new Response(" 0"), budget),
    readBoundedJson(new Response(" 1"), budget),
  ]);
  expect(outcomes.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(budget.remaining).toBe(-1);
});
it("refuses invalid UTF-8, invalid JSON and cancelled streams by name", async () => {
  await expect(readBoundedJson(new Response(new Uint8Array([0xff])), { remaining: 10 })).rejects.toBeInstanceOf(
    JsonReadRefusal,
  );
  await expect(readBoundedJson(new Response("{"), { remaining: 10 })).rejects.toBeInstanceOf(JsonReadRefusal);
  const controller = new AbortController();
  controller.abort();
  await expect(readBoundedJson(new Response("0"), { remaining: 10 }, controller.signal)).rejects.toBeInstanceOf(
    JsonReadRefusal,
  );
});
it("the JSON boundary refuses or returns valid arbitrary, vocabulary and edited input on a small stack", () => {
  const source = new URL("../src/app/bounded-json.ts", import.meta.url).href;
  const script = `import {readBoundedJson,JsonReadRefusal} from ${JSON.stringify(source)};
 let seed=17;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const vocabulary=['null','true','0','[]','{}','{"thread":"answer"}','{"capabilities":["heartbeat"]}'];
 for(let i=0;i<1500;i++){
  const arbitrary=Array.from({length:Math.floor(random()*40)},()=>String.fromCharCode(Math.floor(random()*65536))).join('');
  const word=vocabulary[Math.floor(random()*vocabulary.length)];const at=Math.floor(random()*(word.length+1));
  for(const input of [arbitrary,word,word.slice(0,at)+'%'+word.slice(at)]){
   let expected;let valid=true;try{expected=JSON.parse(input);}catch{valid=false;}
   try{const actual=await readBoundedJson(new Response(input),{remaining:10000});if(!valid||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('incorrect accepted JSON');}
   catch(error){if(!(error instanceof JsonReadRefusal))throw error;if(valid)throw new Error('valid input refused');}
  }
 }`;
  expect(() =>
    execFileSync(process.execPath, ["--stack-size=256", "--import", "tsx", "--input-type=module", "-e", script], {
      timeout: 10000,
      stdio: "pipe",
    }),
  ).not.toThrow();
}, 15000);
