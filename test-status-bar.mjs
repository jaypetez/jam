// Status bar regression test: verify no raw tool calls leak into final message or UI.
// Usage: K=$(cat .jam-key) node test-status-bar.mjs  (see run-tests.sh)
// Runs a turn, captures room history, checks that visible items don't contain raw commands.
const host=process.env.JAM_HOST||"jam.nullagency.io", K=process.env.K, room=process.env.ROOM||"test-status-bar", base=`https://${host}`;
const j=(u,o)=>fetch(base+u,o).then(r=>r.json());
const wait=(ws,pred,ms=120000)=>new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("timeout: "+pred)),ms);const h=ev=>{const e=JSON.parse(ev.data);if(pred(e)){clearTimeout(t);ws.removeEventListener("message",h);res(e)}};ws.addEventListener("message",h)});
const ok=(name,cond,extra="")=>{console.log(cond?"PASS":"FAIL",name,extra)};

// Patterns that should NOT appear in visible text (final message, status bar fallback, etc.)
const rawPatterns=[
  /^\s*(?:Bash|Edit|Read|Write|Agent|Bash|grep|sed|find|ls|cat|head|tail|node|python)\s/,  // raw tool names + command starts
  /^\s*\$\s+/,  // shell prompt
  /--settings\s+/,  // flag patterns
  /[\\/]Users[\\/]mike[\\/]/,  // file paths
];
const containsRaw=text=>{if(!text)return false;const lines=text.split('\n');return lines.some(line=>rawPatterns.some(pat=>pat.test(line)))};

// Run the test
const ws=new WebSocket(`wss://${host}/ws?room=${room}&k=${K}&name=Mike`);
await new Promise(r=>ws.onopen=r);
const hello=await wait(ws,e=>e.type==="hello");
ok("connected to test-status-bar room",hello.you.role==="owner");

// Send a multi-tool turn: Bash + Read
ws.send(JSON.stringify({type:"say",text:"Run 'echo test' via Bash, then list files in /tmp/jam-test-status-bar, then tell me the result. Be brief."}));
const done=await wait(ws,e=>e.type==="done",120000);
ok("turn completed",done.type==="done");
ok("final message is not empty",!!done.text&&done.text.trim().length>0,done.text?.slice(0,60).replace(/\n/g," ")||"(empty)");

// Check history for leaks
const hist=await j(`/api/history?k=${K}&room=${room}`);ok("history endpoint works",hist.ok&&hist.items);
if(hist.items){
  let anyLeak=false;
  for(const item of hist.items){
    if(item.type==="done"||item.type==="say"){
      if(item.text&&containsRaw(item.text)){
        console.log("  ⚠ raw tool leak in",item.type,":",item.text.slice(0,80).replace(/\n/g," "));
        anyLeak=true;
      }
    }
  }
  ok("no raw tool calls in visible text",!anyLeak);
}

process.exit(0);
