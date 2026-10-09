// End-to-end protocol test. Usage: K=$(cat .jam-key) node test.mjs   (see run-tests.sh)
import { httpBase, wsBase, DEFAULT_HOST } from "./jam-url.mjs";
const host=process.env.JAM_HOST||DEFAULT_HOST, K=process.env.K, room=process.env.ROOM||"test-e2e", base=httpBase(host);
const j=(u,o)=>fetch(base+u,o).then(r=>r.json());
const wait=(ws,pred,ms=120000)=>new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("timeout waiting: "+pred)),ms);const h=ev=>{const e=JSON.parse(ev.data);if(pred(e)){clearTimeout(t);ws.removeEventListener("message",h);res(e)}};ws.addEventListener("message",h)});
const open=(url)=>new Promise((res,rej)=>{const ws=new WebSocket(url);ws.onopen=()=>res(ws);ws.onerror=e=>rej(new Error("ws error"))});
const results=[];const ok=(name,cond,extra="")=>{results.push([cond?"PASS":"FAIL",name,extra]);console.log(cond?"PASS":"FAIL",name,extra)};
// 1. invites
const drv=await j(`/api/rooms/${room}/invites?k=${K}`,{method:"POST",body:JSON.stringify({name:"Peter",role:"driver"})});
const vw=await j(`/api/rooms/${room}/invites?k=${K}`,{method:"POST",body:JSON.stringify({role:"viewer"})});
ok("mint driver+viewer tokens",drv.ok&&vw.ok&&drv.token.length===12,drv.token);
const who=await j(`/api/whoami?k=${drv.token}`);ok("whoami via short token",who.ok&&who.role==="driver"&&who.name==="Peter"&&who.room?.name===room);
const bad=await j(`/api/whoami?k=nope`);ok("bad token rejected",!bad.ok);
const scoped=await j(`/api/rooms?k=${drv.token}`);ok("driver token cannot list rooms",scoped.ok===false);
// 2. sockets
const owner=await open(`${wsBase(host)}/ws?room=${room}&k=${K}&name=Mike`);
let lastPresence=null;owner.addEventListener("message",ev=>{const e=JSON.parse(ev.data);if(e.type==="presence")lastPresence=e});
const hello=await wait(owner,e=>e.type==="hello");ok("owner hello",hello.you.role==="owner"&&hello.bridge===true,"bridge="+hello.bridge+" agents="+(hello.agents||[]).length);
const driver=await open(`${wsBase(host)}/ws?k=${drv.token}`);const dh=await wait(driver,e=>e.type==="hello");ok("driver hello (room from token, name locked)",dh.you.role==="driver"&&dh.you.name==="Peter"&&dh.room===room);
const viewer=await open(`${wsBase(host)}/ws?k=${vw.token}&name=Watcher`);const viewerSeen=[];viewer.addEventListener("message",ev=>{const e=JSON.parse(ev.data);if(e.type==="approval")viewerSeen.push(e.id)});const vh=await wait(viewer,e=>e.type==="hello");ok("viewer hello",vh.you.role==="viewer");
await new Promise(r=>setTimeout(r,1500));const pres=lastPresence;ok("presence lists 3 with roles",pres&&pres.users.length>=3&&pres.users.some(u=>u.role==="viewer")&&pres.users.some(u=>u.name==="Peter"),JSON.stringify(pres&&pres.users));
// 3. typing relay
const tp=wait(owner,e=>e.type==="typing"&&e.from==="Peter"&&e.on===true,5000);driver.send(JSON.stringify({type:"typing",on:true}));await tp;ok("typing relayed driver→owner",true);
// 4. viewer cannot say
viewer.send(JSON.stringify({type:"say",text:"viewer should be ignored"}));
let leaked=false;const lk=wait(owner,e=>e.type==="say"&&e.from==="Watcher",1500).then(()=>leaked=true).catch(()=>{});await lk;ok("viewer say ignored",!leaked);
// 5. owner turn round-trip
owner.send(JSON.stringify({type:"say",text:"Reply with exactly the single word PONG and nothing else."}));
const d1=await wait(owner,e=>e.type==="done"||e.type==="error");ok("owner turn completes",d1.type==="done"&&/PONG/i.test(d1.text||""),(d1.text||"").slice(0,80));
// 6. driver risky command → approval → deny
driver.send(JSON.stringify({type:"say",text:"Run this exact bash command and tell me the result: git push origin does-not-exist-branch"}));
const ap=await wait(owner,e=>e.type==="approval"&&e.state==="pending",180000);ok("approval requested for driver git push",ap.from==="Peter"&&/git push/.test(ap.summary),ap.tool);
await new Promise(r=>setTimeout(r,800));ok("viewer sees the approval card",viewerSeen.includes(ap.id));
owner.send(JSON.stringify({type:"approve",id:ap.id,ok:false}));
const dec=await wait(owner,e=>e.type==="approval"&&e.id===ap.id&&e.state!=="pending",10000);ok("decision broadcast",dec.state==="denied"&&dec.by==="Mike");
const d2=await wait(owner,e=>(e.type==="done"||e.type==="error")&&e.id!==d1.id,180000);ok("driver turn completes after denial",d2.type==="done",(d2.text||"").slice(0,120).replace(/\n/g," "));
// 7. tool cards carried input + result
let toolEv=null,resEv=null;const tl=wait(owner,e=>e.type==="tool"&&e.callId&&(toolEv=e),60000);const rl=wait(owner,e=>e.type==="tool_result"&&(resEv=e),120000);
owner.send(JSON.stringify({type:"say",text:"Use the Bash tool to run: echo jam-tool-check. Then reply DONE."}));await tl;await rl;
ok("tool event has callId+input",!!toolEv.input?.command,toolEv.summary);ok("tool_result matched",resEv.callId===toolEv.callId&&/jam-tool-check/.test(resEv.text));
await wait(owner,e=>e.type==="done",120000);
// 8. driver non-risky command runs without approval
let apr=false;const w=wait(owner,e=>e.type==="approval",8000).then(()=>apr=true).catch(()=>{});
driver.send(JSON.stringify({type:"say",text:"Use Bash to run: ls /tmp/jamtest. Reply with the word OK."}));const d3=await wait(driver,e=>e.type==="done"||e.type==="error",120000);await w;ok("driver harmless command needs no approval",!apr&&d3.type==="done");
// 8b. queue + cancel: two quick messages → second is queued → cancel it → it never runs
{const qEv=[];const qh=ev=>{const e=JSON.parse(ev.data);if(e.type==="queue")qEv.push(e.items)};owner.addEventListener("message",qh);
 owner.send(JSON.stringify({type:"say",text:"Reply with the word FIRST only."}));owner.send(JSON.stringify({type:"say",text:"Reply with the word SECOND only."}));
 await new Promise(r=>setTimeout(r,1500));const queued=qEv.flat().find(i=>/SECOND/.test(i.text));ok("second message shows as queued",!!queued,JSON.stringify(qEv.at(-1)));
 if(queued)owner.send(JSON.stringify({type:"unqueue",id:queued.id}));
 const f=await wait(owner,e=>e.type==="done",120000);ok("first turn completes",/FIRST/i.test(f.text||""),(f.text||"").slice(0,30));
 let second=false;await wait(owner,e=>e.type==="done"&&/SECOND/i.test(e.text||""),8000).then(()=>second=true).catch(()=>{});ok("cancelled message never ran",!second);owner.removeEventListener("message",qh)}
// 8a. room names are unique: creating an existing name is rejected, settings route updates instead
{const dup=await j(`/api/rooms?k=${K}`,{method:"POST",body:JSON.stringify({name:room.toUpperCase(),cwd:"/tmp/elsewhere"})});ok("duplicate room name rejected (case-insensitive)",!dup.ok&&/exists/.test(dup.error||""),JSON.stringify(dup));
 const st=await j(`/api/rooms/${room}/settings?k=${K}`,{method:"POST",body:JSON.stringify({model:"claude-sonnet-5"})});ok("settings route changes the model",st.ok&&st.room.model==="claude-sonnet-5");
 await j(`/api/rooms/${room}/settings?k=${K}`,{method:"POST",body:JSON.stringify({model:""})});}
// 8c. history + export endpoints
{const hst=await j(`/api/history?k=${K}&room=${room}&before=999999`);ok("history endpoint returns entries with seq",hst.ok&&hst.items.length>0&&hst.items[0]._s>0,hst.items.length+" items");
 const md=await fetch(`${base}/api/export?k=${K}&room=${room}`).then(r=>r.text());ok("export is markdown with the turn",/^# jam #/.test(md)&&/PONG/.test(md),md.length+" chars")}
// 9. revoke kicks driver
const kicked=wait(driver,e=>e.type==="kicked",5000).then(()=>true).catch(()=>false);await j(`/api/invites/${drv.token}?k=${K}`,{method:"DELETE"});ok("revoke kicks live driver",await kicked);
const after=await j(`/api/whoami?k=${drv.token}`);ok("revoked token invalid",!after.ok);
// 10. /j/ page serves UI
const html=await fetch(`${base}/j/${vw.token}`).then(r=>r.text());ok("/j/<token> serves the UI",/id="root"/.test(html));
console.log("\n"+results.filter(r=>r[0]==="FAIL").length+" failures / "+results.length+" checks");
process.exit(0);
