import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { readThreadAddress, withThreadAddress } from "../src/app/thread-address";

test("adds one bounded thread to note and diagram addresses and the follow page's destinations", () => {
  expect(withThreadAddress("https://127.0.0.1/projects/demo/system.mmd?x=1#node", "thread_7")).toBe(
    "https://127.0.0.1/projects/demo/system.mmd?x=1&thread=thread_7#node",
  );
  expect(withThreadAddress("https://127.0.0.1/projects/demo/docs/readme.md", "A-1")).toBe(
    "https://127.0.0.1/projects/demo/docs/readme.md?thread=A-1",
  );
  expect(withThreadAddress("https://127.0.0.1/projects/demo/?follow&view=system", "A-1")).toBe(
    "https://127.0.0.1/projects/demo/?follow&view=system&thread=A-1",
  );
  expect(withThreadAddress("https://127.0.0.1/projects/demo/?follow&note=docs%2Freadme.md", "A-1")).toBe(
    "https://127.0.0.1/projects/demo/?follow&note=docs%2Freadme.md&thread=A-1",
  );
  // A token-prefixed address (retired in 0.15.0) is no page: it takes no thread.
  expect(withThreadAddress("https://127.0.0.1/token/p/demo/notes/docs/readme.md", "A-1")).toBeNull();
});

test("reads exactly one valid thread id", () => {
  expect(readThreadAddress("?thread=a_B-9")).toBe("a_B-9");
  for (const search of [
    "",
    "?thread=",
    "?thread=a&thread=b",
    `?thread=${"a".repeat(65)}`,
    "?thread=a.b",
    "?thread=%00",
  ]) {
    expect(readThreadAddress(search)).toBeNull();
  }
});

test("refuses non-thread destinations, invalid ids and an existing thread parameter", () => {
  for (const href of [
    "https://127.0.0.1/projects/",
    "https://127.0.0.1/projects/demo/?follow",
    "https://127.0.0.1/projects/demo/-/repo/readme.md",
    "https://127.0.0.1/p/demo/",
    "not a URL",
  ])
    expect(withThreadAddress(href, "a")).toBeNull();
  expect(withThreadAddress("https://127.0.0.1/projects/demo/system.mmd?thread=old", "new")).toBeNull();
  expect(withThreadAddress("https://127.0.0.1/projects/demo/?follow&view=a&note=b", "new")).toBeNull();
  expect(withThreadAddress("https://127.0.0.1/projects/demo/?follow&view=a&overview=1", "new")).toBeNull();
  expect(withThreadAddress("https://127.0.0.1/projects/demo/system.mmd", "bad.id")).toBeNull();
  // A project's own page takes a thread of its conversation (the bell's link); a folder of it does not.
  expect(withThreadAddress("https://127.0.0.1/projects/demo-a1234567/", "a")).toBe(
    "https://127.0.0.1/projects/demo-a1234567/?thread=a",
  );
  expect(withThreadAddress("https://127.0.0.1/projects/demo-a1234567/notes/", "a")).toBeNull();
});

test("the URL boundary never throws on a small stack against a deadline", () => {
  const source = new URL("../src/app/thread-address.ts", import.meta.url).href;
  const script = `
    import {readThreadAddress,withThreadAddress} from ${JSON.stringify(source)};
    let seed=0x71EA;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const vocabulary=[null,undefined,true,false,0,1,"","?thread=a","?thread=a&thread=b","%","a".repeat(65),{},[]];
    const chars=["a","Z","0","_","-","%","&","=","?","/",".","\\0","é","😀","\\ud800"];
    const arbitrary=()=>{let value="";const length=Math.floor(random()*100);for(let at=0;at<length;at++)value+=chars[Math.floor(random()*chars.length)];return value;};
    const edit=(value)=>{const at=Math.floor(random()*(value.length+1));const replacement=chars[Math.floor(random()*chars.length)];return value.slice(0,at)+replacement+value.slice(Math.min(value.length,at+1));};
    const validSearch="?thread=thread_7";
    const validHref="https://127.0.0.1/p/demo-a1234567/views/v/?x=1";
    for(let i=0;i<5000;i++){
      const atom=i%3===0?arbitrary():i%3===1?vocabulary[Math.floor(random()*vocabulary.length)]:edit(validSearch);
      const search=typeof atom==="string"?atom:String(atom);
      const id=i%3===2?edit("thread_7"):String(i%3===0?arbitrary():vocabulary[Math.floor(random()*vocabulary.length)]);
      const href=i%3===2?edit(validHref):random()<0.5?search:"https://127.0.0.1/p/demo-a1234567/views/v/?q="+search;
      const read=readThreadAddress(search);
      const written=withThreadAddress(href,id);
      if(read!==null&&!/^[A-Za-z0-9_-]{1,64}$/.test(read))throw new Error("invalid read");
      if(written!==null&&readThreadAddress(new URL(written).search)!==id)throw new Error("invalid write");
    }
  `;
  expect(() =>
    execFileSync(process.execPath, ["--stack-size=256", "--import", "tsx", "--input-type=module", "-e", script], {
      timeout: 5_000,
      stdio: "pipe",
    }),
  ).not.toThrow();
}, 10_000);
