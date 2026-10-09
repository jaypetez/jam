// Upload protocol test. Usage: K=$(cat .jam-key) node test-upload.mjs  (see run-tests.sh)
import { wsBase, DEFAULT_HOST } from "./jam-url.mjs";
const host=process.env.JAM_HOST||DEFAULT_HOST,K=process.env.K,room=process.env.ROOM||"test-upload";
const wait=(ws,pred,ms=120000)=>new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("timeout: "+pred)),ms);const h=ev=>{const e=JSON.parse(ev.data);if(pred(e)){clearTimeout(t);ws.removeEventListener("message",h);res(e)}};ws.addEventListener("message",h)});
const ws=new WebSocket(`${wsBase(host)}/ws?room=${room}&k=${K}&name=Mike`);await new Promise(r=>ws.onopen=r);const hello=await wait(ws,e=>e.type==="hello");
// 1x1 red PNG + a 900KB text file to force chunking
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const big=Buffer.from("x".repeat(900*1024)).toString("base64");const CH=600000;const total=Math.ceil(big.length/CH);
ws.send(JSON.stringify({type:"upload",id:"u1",name:"dot.png",mime:"image/png",seq:0,total:1,data:png}));
const a=await wait(ws,e=>e.type==="uploaded"&&e.id==="u1",20000);console.log("PASS png uploaded",a.path,a.size+"B");
for(let i=0;i<total;i++)ws.send(JSON.stringify({type:"upload",id:"u2",name:"big notes.txt",mime:"text/plain",seq:i,total,data:big.slice(i*CH,(i+1)*CH)}));
const b=await wait(ws,e=>e.type==="uploaded"&&e.id==="u2",30000);console.log(b.size===900*1024?"PASS":"FAIL","chunked upload",b.path,b.size+"B",total+" chunks");
ws.send(JSON.stringify({type:"say",text:"What colour is the single pixel in the attached PNG? Answer with one word.",attachments:[{name:"dot.png",path:a.path,thumb:"data:image/png;base64,"+png}]}));
const say=await wait(ws,e=>e.type==="say"&&e.attachments,5000);console.log(say.attachments[0].thumb?"PASS":"FAIL","say carries attachment + thumb");
const d=await wait(ws,e=>e.type==="done"||e.type==="error",180000);console.log(/(?:red|pink|magenta|warm|bright|mono)/i.test(d.text||"")?"PASS":"FAIL","claude saw the image:",(d.text||"").slice(0,60).replace(/\n/g," "));
// reconnect: hello must still deliver the log from per-entry keys
const ws2=new WebSocket(`${wsBase(host)}/ws?room=${room}&k=${K}&name=Mike`);await new Promise(r=>ws2.onopen=r);const h2=await wait(ws2,e=>e.type==="hello");console.log(h2.log.some(e=>e.type==="say"&&e.attachments)&&h2.log.some(e=>e.type==="done")?"PASS":"FAIL","hello log from per-entry storage",h2.log.length+" entries");
process.exit(0);
