import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
// @ts-expect-error Unshipped JavaScript commands have no declaration files.
import { STATUSES, TERMINAL, assertNewerVersion, compareVersions, generationRecord, publishAdmission, publishCandidate, verifyCoverageEvidence, requestTarget, assertNoEndedIdentity, preparedMergeProof, abandonPullRequests, abandon, advance, authorizeInstall, authorizeUpload, beginPromotion, beginUpload, claimRelease, classifyRegistry, closeWithoutPromotion, hashBytes, initialState, makeRequest, planFinalization, recordInstallFailure, recordInstallProof, recordPromotion, recordRegistry, releasePathsAllowed, retire, validateState, versionUsage, verifyReleaseIdentity, writeExclusive } from "../verification/release-control.mjs";
// @ts-expect-error Unshipped JavaScript commands have no declaration files.
import { executeFinalRecords, executeInstall, executePromotion, executePromotionRecovery, observeLatest, promotionErrorCode, latestReadOptions, executeUpload } from "../verification/release-job.mjs";

const A="a".repeat(40),B="b".repeat(40),C="c".repeat(40),NOW="2026-09-17T00:00:00.000Z",notes="Release notes\n";
// Frozen output of git show origin/release-state:state.json at 6e154912fed85ed1c5cf42ed79100214d4b1e00f.
// Keep this fixture independent of later release-state changes and plain CI checkouts.
const storedUnknownState={schema:2,version:"0.11.0",identity:"645a06295d9327237ab32fe270d0766bfaf63a5fe6f3f1ccbead270fcc65f412",status:"upload-unknown",upload:"unknown",promotion:"none",requestBaseSha:"a2a552cb7332d17e8359235580c68d9f9385f693",releaseSha:"a770943a4608c4e61da85f979440ea426278baf0",releaseParent:"a2a552cb7332d17e8359235580c68d9f9385f693",pullRequest:412,claimExecution:"35824449849:1",uploadExecution:"35824449849:1",promoterExecution:null,artifact:{file:"ytdb-slate-0.11.0.tgz",sha256:"874590324717b266d869f94ef4f43585f3d0a848c12a5ce01919b22715269f7e",integrity:"sha512-1L6tYFBxSNG0Wa3BDTYQaIfm9Hpz2rUz7e98dZMcyZIIRlmhHLwKaf8IO9yG50p/mxT6I8x7RGM9JvblgHEQjQ==",identity:"645a06295d9327237ab32fe270d0766bfaf63a5fe6f3f1ccbead270fcc65f412",releaseSha:"a770943a4608c4e61da85f979440ea426278baf0",execution:"35824449849:1"},registry:null,installFailures:[],installProof:null,promotionEvidence:null,tag:"v0.11.0",internalTag:"slate-candidate",createdAt:"2026-09-23T05:45:18.963Z",updatedAt:"2026-09-23T06:03:40.969Z"};
const req=(current="0.10.0",text=notes,authorization="101")=>makeRequest({version:"0.10.1",baseSha:A,notes:text,currentVersion:current,authorization});
const claimed=(request=req())=>claimRelease(initialState(request,NOW),{request,launchIdentity:request.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"17",runAttempt:"1"},NOW);
const owner=(state=claimed())=>({identity:state.identity,version:state.version,releaseSha:state.releaseSha,releaseParent:state.releaseParent});
const ready=(request=req())=>{const s=claimed(request),o=owner(s);return advance(advance(s,"checking",o,NOW),"ready",o,NOW);};
const uploaded=(request=req())=>{const s=ready(request),o=owner(s);return beginUpload(s,{file:"package.tgz",...hashBytes(Buffer.from("archive"))},o,"17","1",NOW);};
const published=()=>{const s=uploaded(),o=owner(s),bytes=Buffer.from("archive"),result=classifyRegistry(s,bytes,bytes,{version:s.version,integrity:hashBytes(bytes).integrity},o);return recordRegistry(s,result,o,NOW);};
const installEnvelope=(s:any,execution="17:1")=>({identity:s.identity,version:s.version,releaseSha:s.releaseSha,releaseParent:s.releaseParent,execution,registryIntegrity:s.registry.integrity,proof:{command:"slate",source:`npm:ytdb-slate@${s.version}`}});
const failureEnvelope=(s:any,execution="17:1",failure="command-proof")=>({identity:s.identity,version:s.version,releaseSha:s.releaseSha,releaseParent:s.releaseParent,execution,registryIntegrity:s.registry.integrity,result:"failed",failure});
const failedPublished=()=>{const s=published();return recordInstallFailure(s,failureEnvelope(s),owner(s),NOW);};
const proved=()=>{const s=published();return recordInstallProof(s,installEnvelope(s),owner(s),NOW);};
const identity=(request=req())=>({request,durableRequest:structuredClone(request),coverageRecord:{schema:2,parentPolicy:"exact-release-parent",allowedPaths:request.coverageDisposition.allowedPaths,verdict:"WARN"},notes,releaseSha:B,parentSha:A,changedPaths:request.coverageDisposition.allowedPaths,manifestVersion:"0.10.1",associatedPullRequests:[{number:9,merged:true,mergeCommitSha:B,baseRefName:"main"}]});

test("exact merge identity supports grouped pushes, correction, and fresh generations",()=>{assert.equal(verifyReleaseIdentity(identity()).pullRequest,9);const correction=req("0.10.1");assert.equal(correction.coverageDisposition.allowedPaths.length,3);assert.equal(verifyReleaseIdentity(identity(correction)).identity,correction.identity);assert.notEqual(C,verifyReleaseIdentity(identity()).releaseSha);const fresh=req("0.10.0",notes,"102");assert.notEqual(fresh.identity,req().identity);for(const mutate of[(x:any)=>x.notes="changed",(x:any)=>x.durableRequest=req("0.10.0","other\n"),(x:any)=>x.changedPaths=["extension/index.ts"],(x:any)=>x.associatedPullRequests=[]]){const x:any=identity();mutate(x);assert.throws(()=>verifyReleaseIdentity(x));}});

test("one request path rule governs identification for both permitted sets",()=>{
  for(const request of [req(),req("0.10.1")]){
    const allowed=request.coverageDisposition.allowedPaths;
    const requestPath=`release/requests/${request.version}/request.json`;
    const required=allowed.length===5?["package.json","package-lock.json",requestPath]:[requestPath];
    const optional=allowed.filter((p:string)=>!required.includes(p));
    for(let mask=0;mask<1<<optional.length;mask++){
      const paths=[...required,...optional.filter((_p:string,i:number)=>mask&(1<<i))];
      assert.equal(releasePathsAllowed(request,paths),true,JSON.stringify(paths));
      assert.equal(verifyReleaseIdentity({...identity(request),changedPaths:paths}).identity,request.identity);
    }
    const invalid=[[],[...allowed,"extension/index.ts"],allowed.filter((p:string)=>p!==requestPath),[requestPath,requestPath]];
    if(allowed.length===5)invalid.push(allowed.filter((p:string)=>p!=="package.json"),allowed.filter((p:string)=>p!=="package-lock.json"));
    for(const paths of invalid){
      assert.equal(releasePathsAllowed(request,paths),false,JSON.stringify(paths));
      assert.throws(()=>verifyReleaseIdentity({...identity(request),changedPaths:paths}),/release diff violates/);
    }
  }
  const request=req("0.10.1"),onlyRequest={...identity(request),changedPaths:[`release/requests/${request.version}/request.json`]};
  assert.throws(()=>verifyReleaseIdentity({...onlyRequest,notes:"tampered\n"}),/release notes changed/);
  assert.throws(()=>verifyReleaseIdentity({...onlyRequest,coverageRecord:{...onlyRequest.coverageRecord,verdict:"PASS"}}),/coverage disposition disagrees/);
  assert.throws(()=>verifyReleaseIdentity({...onlyRequest,durableRequest:req("0.10.1",notes,"102")}),/durable owner request/);
});

test("abandon then identical preparation creates a fresh authorization and rejects the old generation",()=>{const first=req(),terminal=abandon(initialState(first,NOW),{identity:first.identity,version:first.version,releaseSha:null,releaseParent:null},false,NOW),second=req("0.10.0",notes,"102");assert.equal(terminal.status,"abandoned");assert.notEqual(second.identity,first.identity);const merged=claimed(second);assert.equal(merged.status,"claimed");assert.throws(()=>advance(merged,"checking",{...owner(merged),identity:first.identity},NOW));});

test("claim and retirement require independently supplied identity",()=>{const request=req(),first=claimed(request),again=claimRelease(first,{request,launchIdentity:request.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"17",runAttempt:"2"},NOW);assert.deepEqual(again,first);assert.throws(()=>claimRelease(initialState(req("0.10.0",notes,"102"),NOW),{request,launchIdentity:request.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"17",runAttempt:"1"},NOW));assert.throws(()=>claimRelease(first,{request,launchIdentity:"f".repeat(64),releaseSha:B,parentSha:A,pullRequest:9,runId:"17",runAttempt:"1"},NOW));assert.throws(()=>retire(first,{...owner(first),identity:"f".repeat(64)},NOW));assert.equal(retire(first,owner(first),NOW).status,"retired");});

test("every upload stage rejects stale identity, execution, and prior upload",()=>{const s=ready(),o=owner(s),artifact={file:"package.tgz",...hashBytes(Buffer.from("archive"))};assert.throws(()=>beginUpload(s,artifact,{...o,identity:"f".repeat(64)},"17","1",NOW));const u=beginUpload(s,artifact,o,"17","1",NOW);assert.equal(authorizeUpload(u,o,"17","1").version,"0.10.1");assert.throws(()=>authorizeUpload(u,o,"17","2"));assert.throws(()=>beginUpload({...s,upload:"verified"},artifact,o,"17","1",NOW));const bytes=Buffer.from("archive");assert.throws(()=>classifyRegistry(u,bytes,bytes,{version:u.version,integrity:hashBytes(bytes).integrity},{...o,identity:"f".repeat(64)}));const result=classifyRegistry(u,bytes,bytes,{version:u.version,integrity:hashBytes(bytes).integrity},o);assert.throws(()=>recordRegistry(u,result,{...o,identity:"f".repeat(64)},NOW));assert.throws(()=>recordRegistry(u,{...result,identity:"e".repeat(64)},o,NOW));assert.throws(()=>recordRegistry(u,{...result,execution:"17:2"},o,NOW));assert.equal(recordRegistry(u,result,o,NOW).status,"published");});

test("retirement validates a real stored unknown upload and every part of the absence proof",()=>{const s=validateState(structuredClone(storedUnknownState));assert.equal(s.version,"0.11.0");assert.equal(s.identity,"645a06295d9327237ab32fe270d0766bfaf63a5fe6f3f1ccbead270fcc65f412");assert.equal(s.uploadExecution,"35824449849:1");const later="2026-09-23T08:04:00.000Z",doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}},proof={run:{id:35824449849,run_attempt:1,status:"completed"},job:{id:17,name:"upload",run_id:35824449849,run_attempt:1,status:"completed",conclusion:"failure",completed_at:"2026-09-23T06:03:58.000Z"},package:doc};const result=retire(s,owner(s),later,proof);assert.equal(result.status,"retired");assert.equal(result.upload,"observed-absent");assert.deepEqual(result.artifact,s.artifact);assert.equal(result.uploadExecution,s.uploadExecution);assert.equal(result.absence.execution,s.uploadExecution);assert.equal(validateState(result).status,"retired");assert.throws(()=>retire(s,{...owner(s),identity:"f".repeat(64)},later,proof));for(const change of [(e:any)=>{e.run.status="in_progress";},(e:any)=>{e.run.run_attempt=2;},(e:any)=>{e.job.conclusion="success";},(e:any)=>{e.job.status="in_progress";},(e:any)=>{e.job.run_attempt=2;},(e:any)=>{e.job.completed_at="2026-09-23T07:05:00.000Z";},(e:any)=>{e.package.time["0.11.0"]=NOW;},(e:any)=>{e.package.versions.push("0.11.0");},(e:any)=>{delete e.package.time;},(e:any)=>{e.package.versions=[];}]){const e:any=structuredClone(proof);change(e);assert.throws(()=>retire(s,owner(s),later,e));}assert.throws(()=>validateState({...result,status:"ready"}));assert.throws(()=>validateState({...result,absence:null}));for(const status of [claimed(),advance(claimed(),"checking",owner(claimed()),NOW),ready()])assert.equal(retire(status,owner(status),NOW).upload,"none");});

test("preparation sees used versions in versions or time and refuses malformed package data",()=>{const doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}};assert.equal(versionUsage(doc,"0.10.1"),false);assert.equal(versionUsage({...doc,time:{...doc.time,"0.10.1":NOW}},"0.10.1"),true);assert.equal(versionUsage({...doc,versions:[...doc.versions,"0.10.1"],time:{...doc.time,"0.10.1":NOW}},"0.10.1"),true);assert.equal(versionUsage({versions:["0.10.1"],time:{created:NOW,modified:NOW,"0.10.1":NOW}},"0.10.1"),true);for(const p of [{versions:["0.10.0"]},{versions:[],time:doc.time},{error:{code:"E404"}},null])assert.throws(()=>versionUsage(p,"0.10.1"));});

test("registry absence requires every version and metadata timestamp to be valid",()=>{
  const s=uploaded(),document={versions:["0.9.0","0.10.0"],time:{created:NOW,modified:NOW,"0.9.0":NOW,"0.10.0":NOW}};
  const proof={run:{id:17,run_attempt:1,status:"completed"},job:{id:7,name:"upload",run_id:17,run_attempt:1,status:"completed",conclusion:"failure",completed_at:NOW},package:document};
  const later="2026-09-17T02:00:00.000Z";
  assert.equal(versionUsage(document,s.version),false);
  assert.equal(retire(s,owner(s),later,proof).upload,"observed-absent");
  const invalid=[
    (p:any)=>{delete p.time["0.10.0"];},
    (p:any)=>{p.time["0.10.0"]="0";},
    (p:any)=>{p.time["0.10.0"]="2026-02-30T00:00:00Z";},
    (p:any)=>{p.time.created="0";},
    (p:any)=>{p.time.modified="0";},
    (p:any)=>{delete p.time.modified;},
    (p:any)=>{p.versions[1]=42;p.time[42]=NOW;},
    (p:any)=>{p.versions[1]="";p.time[""]=NOW;},
    (p:any)=>{p.versions[1]="invalid-version";p.time["invalid-version"]=NOW;}
  ];
  for(const change of invalid){
    const malformed:any=structuredClone(document);change(malformed);
    assert.throws(()=>versionUsage(malformed,s.version),/full package/,JSON.stringify(malformed));
    assert.throws(()=>retire(s,owner(s),later,{...proof,package:malformed}),/full package/,JSON.stringify(malformed));
  }
});

test("registry outcomes preserve unknown attribution",()=>{const s=uploaded(),o=owner(s),bytes=Buffer.from("archive"),metadata={version:s.version,integrity:hashBytes(bytes).integrity};const mismatch=classifyRegistry(s,bytes,Buffer.from("other"),metadata,o);assert.deepEqual({result:mismatch.result,attribution:mismatch.attribution},{result:"mismatch",attribution:"unknown"});assert.equal(recordRegistry(s,mismatch,o,NOW).status,"mismatch");assert.equal(classifyRegistry(s,bytes,Buffer.alloc(0),null,o).result,"inconclusive");});

test("install and promotion recorders reject stale artifacts and wrong verified result",()=>{const p=published(),o=owner(p),proof=installEnvelope(p);assert.throws(()=>recordInstallProof(p,proof,{...o,identity:"f".repeat(64)},NOW));assert.throws(()=>recordInstallProof(p,{...proof,identity:"f".repeat(64)},o,NOW));assert.throws(()=>recordInstallProof(p,{...proof,version:"0.10.2"},o,NOW));assert.throws(()=>recordInstallProof(p,{...proof,releaseParent:C},o,NOW));assert.throws(()=>recordInstallProof(p,{...proof,registryIntegrity:"sha512-foreign"},o,NOW));assert.throws(()=>recordInstallProof(p,{...proof,execution:"bad"},o,NOW));const provedState=recordInstallProof(p,proof,o,NOW),intent=beginPromotion(provedState,"0.10.0",o,"17","1",NOW),po=owner(intent),base={identity:intent.identity,releaseSha:intent.releaseSha,execution:"17:1"};assert.throws(()=>recordPromotion(intent,{...base,result:"conflict",after:"0.10.2"},{...po,identity:"f".repeat(64)},NOW));assert.throws(()=>recordPromotion(intent,{...base,result:"verified",before:"0.10.0",after:"0.10.2"},po,NOW));assert.throws(()=>recordPromotion(intent,{...base,execution:"17:2",result:"conflict",after:"0.10.2"},po,NOW));const conflict=recordPromotion(intent,{...base,result:"conflict",before:"0.10.2",after:"0.10.2"},po,NOW);assert.equal(conflict.promotion,"conflict");assert.throws(()=>closeWithoutPromotion({...conflict,promoterExecution:"19:1"},owner(conflict),NOW));assert.throws(()=>closeWithoutPromotion(conflict,{...owner(conflict),identity:"f".repeat(64)},NOW));assert.throws(()=>closeWithoutPromotion(conflict,{...owner(conflict),version:"0.10.2"},NOW));assert.equal(closeWithoutPromotion(conflict,owner(conflict),NOW).status,"closed-unpromoted");assert.throws(()=>closeWithoutPromotion(intent,owner(intent),NOW));const promoted=recordPromotion(intent,{...base,result:"verified",before:"0.10.0",after:"0.10.1"},po,NOW);assert.equal(planFinalization({state:promoted,expected:owner(promoted),remoteTagSha:"",releaseTarget:""}).createTag,true);});

function controlledObservation(responses:any[],readCost=0){
  let tick=0,index=0;const starts:number[]=[],timeouts:number[]=[],waits:number[]=[];
  return {starts,timeouts,waits,elapsed:()=>tick,now:()=>tick,sleep:(ms:number)=>{waits.push(ms);tick+=ms;},view:(_registry:string,options:any)=>{starts.push(tick);timeouts.push(options.timeout);tick+=readCost;const value=responses[Math.min(index++,responses.length-1)];if(value instanceof Error)throw value;return value;}};
}

const promotionRegistry="https://registry.npmjs.org/";
async function capturePromotionOutput(t:TestContext,invoke:()=>Promise<any>){
  let stdout="",stderr="";
  const out=t.mock.method(process.stdout,"write",(chunk:any)=>{stdout+=String(chunk);return true;});
  const err=t.mock.method(process.stderr,"write",(chunk:any)=>{stderr+=String(chunk);return true;});
  try{return{result:await invoke(),stdout,stderr};}
  finally{out.mock.restore();err.mock.restore();}
}
const oidcEnv={ACTIONS_ID_TOKEN_REQUEST_URL:"https://github.example/token?request=1",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"fixture-request-token"};
function oidcFixture(effect=()=>{}){
  const calls:any[]=[],masks:string[]=[];
  return{calls,masks,oidcEnv,mask:(value:string)=>masks.push(value),fetch:async(url:string,options:any)=>{
    calls.push({url,options});
    if(options.method==="PUT"){effect();return new Response(null,{status:200});}
    return Response.json(options.method==="GET"?{value:"fixture-id-token"}:{token:"fixture-npm-token"},{status:options.method==="GET"?200:201});
  }};
}

test("promotion and recovery share bounded classification and reject every invalid read",{timeout:10000},async()=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW),o=owner(intent);
  for(const recovery of [false,true]){
    const invoke=async(clock:any)=>recovery?executePromotionRecovery({state:intent,expected:o,runId:"19",runAttempt:"1",registry:"x",...clock}):{result:await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,...oidcFixture(),...clock})};
    for(const [reads,wanted] of [[["0.10.0","0.10.0","0.10.1"],"verified"],[["0.10.0"],"unchanged"],[["0.9.0"],"superseded"],[["0.9.0","0.10.1"],"verified"]] as const){
      const clock=controlledObservation([...reads]),out=await invoke(clock);assert.equal(out.result.result,wanted,`${recovery}/${reads}`);
      assert.ok(clock.starts.every(start=>start<60000));assert.ok(clock.timeouts.every(timeout=>timeout>0&&timeout<=60000));
      if(wanted!=="verified"){assert.equal(clock.waits.reduce((a,b)=>a+b,0),60000);assert.equal(clock.waits.length,12);}
      if(recovery){assert.equal(out.retryPromotion,wanted==="unchanged");assert.equal(out.state.status,wanted==="unchanged"?"promotion-unknown":wanted==="verified"?"promoted":"proved");assert.equal(out.state.promotionEvidence.expectedLatest,"0.10.0");}
    }
    for(const invalid of [new Error("secret"),"bad",null,{},["0.10.1"],"0.10.1\n",undefined]){
      for(const reads of [[invalid],["0.10.0",invalid]]){const before=JSON.stringify(intent);await assert.rejects(()=>invoke(controlledObservation(reads)),/latest read failed/);assert.equal(JSON.stringify(intent),before);}
    }
  }
  for(const readCost of [60000,61000])assert.throws(()=>observeLatest({registry:"x",version:intent.version,expectedLatest:"0.10.0",...controlledObservation([intent.version],readCost)}),/timed out/);
  const clock=controlledObservation(["0.10.0"],1000);assert.equal(observeLatest({registry:"x",version:intent.version,expectedLatest:"0.10.0",...clock}).result,"unchanged");assert.deepEqual(clock.starts,[0,6000,12000,18000,24000,30000,36000,42000,48000,54000]);assert.equal(clock.timeouts.at(-1),6000);
  for(const readCost of [450,3000])for(const latest of ["0.10.0","0.9.0"]){
    const clock=controlledObservation([latest],readCost),result=observeLatest({registry:"x",version:intent.version,expectedLatest:"0.10.0",...clock});
    assert.deepEqual(result,{result:latest==="0.10.0"?"unchanged":"superseded",after:latest});
    assert.ok(clock.elapsed()<=60000,`read cost ${readCost} exceeded the allowance: ${clock.elapsed()}`);
    assert.ok(clock.timeouts.every(timeout=>timeout>=1000));
    if(readCost===450){assert.equal(clock.starts.length,11);assert.equal(clock.elapsed(),59950);assert.equal(clock.timeouts.at(-1),5500);}
    if(readCost===3000){assert.equal(clock.elapsed(),60000);assert.equal(clock.waits.at(-1),1000);}
  }
  const failsLater=controlledObservation(["0.10.0",new Error("timeout")]);assert.throws(()=>observeLatest({registry:"x",version:intent.version,expectedLatest:"0.10.0",...failsLater}),/latest read failed/);
  for(const allowance of [0,60001,Infinity])assert.throws(()=>observeLatest({registry:"x",version:intent.version,expectedLatest:"0.10.0",allowance}),/timing/);
});

test("promotion writes exactly once only when the guard equals the saved earlier version",{timeout:10000},async()=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW);
  for(const [guard,wanted,writes] of [[intent.version,"verified",0],["0.9.0","superseded",0],["0.10.0","unchanged",1]] as const){
    const fixture=oidcFixture(),clock=controlledObservation([guard]);
    const result=await executePromotion({state:intent,expected:owner(intent),runId:"17",runAttempt:"1",registry:promotionRegistry,...fixture,...clock});
    assert.equal(result.result,wanted);assert.equal(fixture.calls.length,writes*3,guard);
    if(writes){
      const [github,exchange,put]=fixture.calls;
      assert.equal(github.url,"https://github.example/token?request=1&audience=npm%3Aregistry.npmjs.org");
      assert.equal(github.options.headers.Authorization,"Bearer fixture-request-token");
      assert.equal(exchange.url,"https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/ytdb-slate");
      assert.equal(exchange.options.headers.Authorization,"Bearer fixture-id-token");assert.equal(exchange.options.body,undefined);
      assert.equal(put.url,"https://registry.npmjs.org/-/package/ytdb-slate/dist-tags/latest");
      assert.equal(put.options.headers.Authorization,"Bearer fixture-npm-token");assert.equal(put.options.headers["Content-Type"],"application/json");
      assert.equal(put.options.body,JSON.stringify(intent.version));
      assert.deepEqual(fixture.calls.map(call=>call.options.method),["GET","POST","PUT"]);
      assert.ok(fixture.calls.every(call=>call.options.redirect==="error"&&call.options.signal instanceof AbortSignal&&!call.options.signal.aborted));
      assert.deepEqual(fixture.masks,["fixture-id-token","fixture-npm-token"]);
    }else assert.deepEqual(fixture.masks,[]);
    assert.equal(recordPromotion(intent,result,owner(intent),NOW).promotion,wanted);
    if(guard===intent.version)assert.equal(clock.starts.length,1);
  }
});

test("write refusals save only a closed safe error identifier",{timeout:10000},async()=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW);
  for(const [error,code] of [[{code:"ETIMEDOUT"},"ETIMEDOUT"],[{stdout:'{"error":{"code":"E401","message":"secret"}}'},"E401"],[{stderr:"npm error code E403\nsecret token"},"E403"],[{stderr:"npm ERR! code E503\n"},"E503"],[{message:"E403 secret"},"unknown"],[{code:"NEW_SECRET_CODE"},"unknown"],[{code:"E401",stderr:"npm error code E403\n"},"unknown"]] as const){
    assert.equal(promotionErrorCode(error),code);const clock=controlledObservation(["0.10.0"]);
    const result=await executePromotion({state:intent,expected:owner(intent),runId:"17",runAttempt:"1",registry:promotionRegistry,...clock,...oidcFixture(()=>{throw error;})});
    assert.equal(result.result,"refused");assert.equal(result.errorCode,code);assert.equal(clock.starts.length,13);assert.equal(result.after,"0.10.0");assert.doesNotMatch(JSON.stringify(result),/secret|message|stderr/);
    assert.equal(recordPromotion(intent,result,owner(intent),NOW).promotion,"refused");
  }
});

test("failed writes observe applied effects and save refusal even when observation fails",{timeout:10000},async()=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW),o=owner(intent);
  for(const code of ["ETIMEDOUT","ECONNRESET"])for(const [reads,wanted,after] of [
    [["0.10.0",intent.version],"verified",intent.version],
    [["0.10.0","0.9.0",intent.version],"verified",intent.version],
    [["0.10.0","0.9.0"],"refused","0.9.0"],
    [["0.10.0",new Error("private read failure")],"refused",undefined],
    [["0.10.0","0.9.0",new Error("later failure")],"refused",undefined],
    [["0.10.0",Object.assign(new Error("private timeout"),{code:"ETIMEDOUT"})],"refused",undefined],
    [["0.10.0",null],"refused",undefined]
  ] as const){
    const fixture=oidcFixture(()=>{throw {code};}),clock=controlledObservation([...reads]),result=await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,...clock,...fixture});
    assert.equal(fixture.calls.filter(call=>call.options.method==="PUT").length,1);assert.equal(result.result,wanted);assert.equal(result.after,after);
    assert.equal(Object.hasOwn(result,"after"),after!==undefined);assert.equal(Object.hasOwn(result,"errorCode"),wanted==="refused");
    if(wanted==="refused")assert.equal(result.errorCode,code);
    assert.doesNotMatch(JSON.stringify(result),/secret|private|later failure/);
    const recorded=recordPromotion(intent,result,o,NOW);assert.equal(recorded.status,wanted==="verified"?"promoted":"proved");
    if(wanted==="verified")assert.throws(()=>closeWithoutPromotion(recorded,o,NOW));
  }
});

test("promotion refuses a different or invalid registry origin before reads or credentials",{timeout:10000},async()=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW),o=owner(intent);
  const legacyControl=await import(`data:text/javascript;base64,${Buffer.from(legacyPromotionControl).toString("base64")}`);
  for(const registry of ["https://wrong.invalid/","http://registry.npmjs.org/","https://registry.npmjs.org:444/","not-a-url"]){
    let reads=0,requests=0;
    const result=await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry,oidcEnv,view:()=>{reads++;return "0.10.0";},fetch:()=>{requests++;throw new Error("unexpected credential request");}});
    assert.deepEqual(result,{identity:intent.identity,releaseSha:intent.releaseSha,execution:"17:1",result:"refused",before:"0.10.0",errorCode:"unknown"});
    assert.equal(reads,0);assert.equal(requests,0);
    assert.equal(recordPromotion(intent,result,o,NOW).promotion,"refused");
    assert.equal(legacyControl.recordPromotion(intent,result,o,NOW).promotion,"refused");
  }
  for(const registry of [promotionRegistry,"https://registry.npmjs.org","https://registry.npmjs.org:443/"]){
    const fixture=oidcFixture(),clock=controlledObservation(["0.10.0",intent.version]);
    const result=await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry,...fixture,...clock});
    assert.equal(result.result,"verified");assert.equal(fixture.calls.length,3);
  }
});

test("OIDC request failures keep closed evidence and use the observer",{timeout:10000},async t=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW),o=owner(intent);
  const cases:any[]=[
    ...[401,403,404,500].map(status=>({stage:0,status,code:`E${status}`})),
    ...[401,403,404,500].map(status=>({stage:1,status,code:`E${status}`})),
    ...[401,403,404,429,500].map(status=>({stage:2,status,code:`E${status}`})),
    ...[0,1,2].map(stage=>({stage,status:302,code:"unknown"})),
    ...[0,1].flatMap(stage=>["{broken fixture-request-token",{},null,{value:42,token:42},{value:"",token:""},{value:"fixture-id-token\n",token:"fixture-npm-token\n"}].map(body=>({stage,body,code:"unknown"}))),
    ...[0,1,2].flatMap(stage=>["ECONNRESET","ECONNREFUSED","ENOTFOUND","EAI_AGAIN","PRIVATE_CODE"].map(code=>({stage,error:new TypeError("fixture-request-token fixture-id-token fixture-npm-token",{cause:{code}}),code:code==="PRIVATE_CODE"?"unknown":code}))),
    ...[0,1,2].map(stage=>({stage,error:new DOMException("fixture-request-token fixture-id-token fixture-npm-token","TimeoutError"),code:"ETIMEDOUT"})),
    ...[0,1].flatMap(stage=>[new SyntaxError("fixture-id-token fixture-npm-token"),new DOMException("fixture-request-token","TimeoutError")].map(bodyError=>({stage,bodyError,code:bodyError.name==="TimeoutError"?"ETIMEDOUT":"unknown"}))),
    {stage:1,error:new TypeError("fixture-id-token redirect rejected"),code:"unknown"},
    {stage:1,status:200,body:{token:"fixture-npm-token"},code:"unknown"},
    {stage:0,env:{...oidcEnv,ACTIONS_ID_TOKEN_REQUEST_URL:"http://github.example/token"},code:"unknown"},
    {stage:0,env:{...oidcEnv,ACTIONS_ID_TOKEN_REQUEST_URL:"not-a-url"},code:"unknown"}
  ];
  for(const scenario of cases){
    const fixture=oidcFixture(),clock=controlledObservation(["0.10.0"]);let n=0;
    const run=await capturePromotionOutput(t,()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,...fixture,...clock,oidcEnv:scenario.env??oidcEnv,fetch:async(url:string,options:any)=>{
      assert.equal(clock.starts.length,1,"guard must precede any credential request");
      assert.equal(options.redirect,"error");assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(fixture.masks,n===0?[]:n===1?["fixture-id-token"]:["fixture-id-token","fixture-npm-token"],"mask each credential before its next use");
      if(n++===scenario.stage){
        if(scenario.error)throw scenario.error;
        if(scenario.bodyError)return{ok:true,status:scenario.stage===0?200:201,json:async()=>{throw scenario.bodyError;}};
        if(Object.hasOwn(scenario,"body"))return new Response(typeof scenario.body==="string"?scenario.body:JSON.stringify(scenario.body),{status:scenario.status??(scenario.stage===1?201:200)});
        return new Response("PRIVATE fixture-request-token fixture-id-token fixture-npm-token response",{status:scenario.status});
      }
      return fixture.fetch(url,options);
    }}));
    const result=run.result;
    assertCredentialSecrecy(run,result);
    assert.equal(result.result,"refused",JSON.stringify(scenario));assert.equal(result.before,"0.10.0");assert.equal(result.after,"0.10.0");assert.equal(result.errorCode,scenario.code);
    assert.equal(clock.starts.length,13,"request failure must enter the observer");
    assert.equal(recordPromotion(intent,result,o,NOW).promotion,"refused");
    assert.doesNotMatch(JSON.stringify(result),/fixture-|PRIVATE|response|message/);
    if(scenario.env)assert.equal(n,0);
    else assert.equal(n,scenario.stage+1);
  }
});

test("OIDC requests use ten-second deadlines and body parse failures stay closed",{timeout:10000},async t=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW),controllers:AbortController[]=[],deadlines:number[]=[];
  const timeout=t.mock.method(AbortSignal,"timeout",(ms:number)=>{deadlines.push(ms);const controller=new AbortController();controllers.push(controller);return controller.signal;});
  const abortRequest=(signal:AbortSignal,controller:AbortController)=>new Promise<never>((_resolve,reject)=>{
    signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    queueMicrotask(()=>controller.abort(new DOMException("fixture-id-token fixture-npm-token","TimeoutError")));
  });
  try{
    for(const scenario of [{stage:-1,body:false},...[0,1,2].map(stage=>({stage,body:false})),...[0,1].map(stage=>({stage,body:true}))]){
      controllers.length=0;deadlines.length=0;
      const fixture=oidcFixture(),clock=controlledObservation(scenario.stage<0?["0.10.0",intent.version]:["0.10.0"]),signals:AbortSignal[]=[];let n=0;
      const run=await capturePromotionOutput(t,()=>executePromotion({state:intent,expected:owner(intent),runId:"17",runAttempt:"1",registry:promotionRegistry,...fixture,...clock,fetch:async(url:string,options:any)=>{
        signals.push(options.signal);
        const controller=controllers[n];assert.ok(controller);
        assert.equal(options.signal,controller.signal,"fetch must receive its own deadline signal");
        if(n++===scenario.stage){
          if(scenario.body)return{ok:true,status:scenario.stage===0?200:201,json:()=>abortRequest(options.signal,controller)};
          return abortRequest(options.signal,controller);
        }
        return fixture.fetch(url,options);
      }}));
      assertCredentialSecrecy(run,run.result);
      signals.forEach((signal,index)=>assert.equal(signal,controllers[index]?.signal,"fetch must receive its own deadline signal"));
      assert.deepEqual(deadlines,Array(scenario.stage<0?3:scenario.stage+1).fill(10000));
      assert.equal(n,deadlines.length);
      if(scenario.stage<0){assert.equal(run.result.result,"verified");assert.ok(controllers.every(controller=>!controller.signal.aborted));}
      else{
        assert.equal(controllers[scenario.stage]?.signal.aborted,true);
        assert.equal(run.result.result,"refused");assert.equal(run.result.errorCode,"ETIMEDOUT");
        assert.equal(run.result.before,"0.10.0");assert.equal(run.result.after,"0.10.0");
        assert.equal(clock.starts.length,13,"aborted request must enter the observer");
      }
      assert.equal(recordPromotion(intent,run.result,owner(intent),NOW).promotion,scenario.stage<0?"verified":"refused");
    }
  }finally{timeout.mock.restore();}
});

test("recording rejects open content and preserves historical outcomes and retry binding",()=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"17","1",NOW),o=owner(intent),base={identity:intent.identity,releaseSha:intent.releaseSha,execution:"17:1"};
  const unchanged={...base,result:"unchanged",before:"0.10.0",after:"0.10.0"};
  for(const result of [unchanged,{...base,result:"verified",before:"0.10.0",after:intent.version},{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode:"E403"},{...base,result:"refused",before:"0.10.0",errorCode:"ECONNRESET"},{...base,result:"not-attempted",cause:"missing-token"}]){
    for(const extra of [{message:"secret"},{stderr:"secret"},{token:"secret"},{expectedLatest:"0.9.0"},{intentAt:"foreign"},{releaseParent:C}])assert.throws(()=>recordPromotion(intent,{...result,...extra},o,NOW),/malformed/);
  }
  for(const errorCode of ["ESECRET","E403 private text",{},["E403"],undefined])assert.throws(()=>recordPromotion(intent,{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode},o,NOW));
  for(const after of ["0.9.0",intent.version,["0.10.0"],null])assert.throws(()=>recordPromotion(intent,{...unchanged,after},o,NOW));
  const refusal={...base,result:"refused",before:"0.10.0",errorCode:"ECONNRESET"};
  for(const after of [intent.version,null,["0.10.0"],undefined,"bad"])assert.throws(()=>recordPromotion(intent,{...refusal,after},o,NOW));
  for(const after of ["0.10.0","0.9.0"])assert.equal(recordPromotion(intent,{...refusal,after},o,NOW).promotionEvidence.after,after);
  const unread=recordPromotion(intent,refusal,o,NOW);assert.equal(Object.hasOwn(unread.promotionEvidence,"after"),false);assert.equal(unread.promotionEvidence.expectedLatest,"0.10.0");
  assert.equal(executePromotionRecovery({state:unread,expected:o,runId:"19",runAttempt:"1",registry:"x",...controlledObservation([intent.version])}).state.promotion,"verified");
  const resolved=recordPromotion(intent,unchanged,o,NOW),next=beginPromotion(resolved,"0.10.0",o,"19","1",NOW);
  assert.throws(()=>beginPromotion(resolved,"0.9.0",o,"19","1",NOW),/preserve/);assert.throws(()=>beginPromotion(resolved,"0.10.0",o,"17","1",NOW),/new promoter/);
  assert.throws(()=>recordPromotion(next,{...unchanged,result:"verified",after:intent.version},o,NOW),/active promoter/);
  assert.throws(()=>executePromotionRecovery({state:resolved,expected:{...o,identity:"f".repeat(64)},runId:"19",runAttempt:"1",registry:"x",view:()=>assert.fail()}),/own/);
  for(const result of [{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode:"E403"},{...base,result:"not-attempted",cause:"missing-token"},unchanged]){
    const s=recordPromotion(intent,result,o,NOW),recovered=executePromotionRecovery({state:s,expected:o,runId:"19",runAttempt:"1",registry:"x",...controlledObservation([intent.version])});assert.equal(recovered.state.promotion,"verified");assert.equal(planFinalization({state:recovered.state,expected:o}).createTag,true);
  }
  const historical=structuredClone(recordPromotion(intent,{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode:"E403"},o,NOW));delete historical.promotionEvidence.errorCode;
  assert.equal(validateState(historical).promotion,"refused");assert.equal(closeWithoutPromotion(historical,o,NOW).status,"closed-unpromoted");assert.doesNotThrow(()=>assertNoEndedIdentity([historical],"f".repeat(64)));
  assert.equal(closeWithoutPromotion(resolved,o,NOW).promotion,"unchanged");
  for(const evidence of [null,{}, {...resolved.promotionEvidence,expectedLatest:intent.version},{...resolved.promotionEvidence,identity:"f".repeat(64)},{...resolved.promotionEvidence,execution:"bad"}])assert.throws(()=>validateState({...resolved,promotionEvidence:evidence}),/unchanged/);
  for(const change of [{identity:"f".repeat(64)},{releaseSha:C},{expectedLatest:["0.10.0"]}])assert.throws(()=>recordPromotion({...intent,promotionEvidence:{...intent.promotionEvidence,...change}},unchanged,o,NOW),/active promoter/);
});

test("not-attempted binds a fixed cause and retains the expected latest",{timeout:10000},async()=>{
  const s=proved(),o=owner(s),intent=beginPromotion(s,"0.10.0",o,"17","1",NOW),base={identity:s.identity,releaseSha:s.releaseSha,execution:"17:1"};
  await assert.rejects(()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"2",registry:promotionRegistry,oidcEnv:{},view:()=>assert.fail(),fetch:()=>assert.fail()}),/active promoter/);
  const missing=await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,oidcEnv:{},view:()=>assert.fail(),fetch:()=>assert.fail()});assert.deepEqual(missing,{...base,result:"not-attempted",cause:"missing-token"});
  for(const env of [{...oidcEnv,ACTIONS_ID_TOKEN_REQUEST_URL:""},{...oidcEnv,ACTIONS_ID_TOKEN_REQUEST_TOKEN:""}])assert.deepEqual(await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,oidcEnv:env,view:()=>assert.fail(),fetch:()=>assert.fail()}),missing);
  await assert.rejects(()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,...oidcFixture(),view:()=>{throw Error("private registry response");},fetch:()=>assert.fail()}),/latest read failed/);
  const historicalReadFailure={...base,result:"not-attempted",cause:"latest-read-failed"};
  for(const cause of [undefined,"other",null,42])assert.throws(()=>recordPromotion(intent,{...missing,cause},o,NOW),/cause|malformed/);
  for(const extra of [{before:""},{after:""},{expectedLatest:"0.9.0"},{intentAt:"tampered"}])assert.throws(()=>recordPromotion(intent,{...missing,...extra},o,NOW),/malformed/);
  for(const result of [missing,historicalReadFailure]){const recorded=recordPromotion(intent,result,o,NOW);assert.equal(recorded.status,"proved");assert.equal(recorded.promoterExecution,null);assert.equal(recorded.promotionEvidence.expectedLatest,"0.10.0");assert.equal(recorded.promotionEvidence.cause,result.cause);assert.throws(()=>validateState({...recorded,promotionEvidence:{...recorded.promotionEvidence,cause:"foreign"}}),/cause/);assert.equal(closeWithoutPromotion(recorded,o,NOW).status,"closed-unpromoted");assert.equal(beginPromotion(recorded,"0.10.0",o,"19","2",NOW).promoterExecution,"19:2");}
  const refused=recordPromotion(intent,{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode:"E403"},o,NOW);assert.equal(beginPromotion(refused,"0.10.0",o,"19","2",NOW).status,"promotion-unknown");
  const failedWrite=await executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,...controlledObservation(["0.10.0"]),...oidcFixture(()=>{throw Error("write error");})});assert.equal(failedWrite.result,"refused");assert.equal(failedWrite.errorCode,"unknown");
  let reads=0;await assert.rejects(()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:promotionRegistry,...oidcFixture(),view:()=>{if(++reads===2)throw Error("second read error");return "0.10.0";}}),/latest read failed/);
});

test("operator actions bind version and generation without mutating the wrong state",()=>{const prepared=initialState(req(),NOW),target={identity:prepared.identity,version:prepared.version,releaseSha:null,releaseParent:null};assert.throws(()=>abandon(prepared,{...target,version:"0.10.2"},false,NOW));assert.throws(()=>abandon(prepared,{...target,identity:"f".repeat(64)},false,NOW));assert.equal(abandon(prepared,target,false,NOW).status,"abandoned");assert.throws(()=>abandon(prepared,target,true,NOW));const c=claimed();assert.throws(()=>retire(c,{...owner(c),version:"0.10.2"},NOW));assert.throws(()=>retire(c,{...owner(c),identity:"f".repeat(64)},NOW));});

test("install failure evidence permits only explicit terminal closure and preserves retry history",()=>{const pub=published(),o=owner(pub),auth=authorizeInstall(pub,o,"17","2");assert.equal(auth.execution,"17:2");for(const mutate of[(s:any)=>({...s,status:"proved"}),(s:any)=>({...s,registry:null}),(s:any)=>({...s,upload:"unknown"}),(s:any)=>({...s,registry:{...s.registry,identity:"f".repeat(64)}}),(s:any)=>({...s,registry:{...s.registry,releaseSha:C}}),(s:any)=>({...s,registry:{...s.registry,execution:"17:2"}})])assert.throws(()=>authorizeInstall(mutate(pub),o,"17","2"));const failure=failureEnvelope(pub,"17:2"),failed=recordInstallFailure(pub,failure,o,NOW);assert.equal(failed.installFailures.length,1);assert.deepEqual(recordInstallFailure(failed,failure,o,NOW),failed);assert.throws(()=>recordInstallFailure(pub,{...failure,registryIntegrity:"sha512-foreign"},o,NOW));assert.throws(()=>recordInstallFailure(pub,{...failure,identity:"f".repeat(64)},o,NOW));const unchanged=JSON.stringify(failed);assert.throws(()=>closeWithoutPromotion(pub,o,NOW));assert.throws(()=>closeWithoutPromotion(uploaded(),owner(uploaded()),NOW));assert.throws(()=>closeWithoutPromotion({...failed,promotion:"unknown"},o,NOW));assert.throws(()=>closeWithoutPromotion({...failed,promoterExecution:"19:1"},o,NOW));assert.throws(()=>closeWithoutPromotion(failed,{...o,version:"0.10.2"},NOW));assert.equal(JSON.stringify(failed),unchanged);const closed=closeWithoutPromotion(failed,o,NOW);assert.equal(closed.status,"closed-unpromoted");assert.equal(closed.installFailures.length,1);assert.throws(()=>recordInstallFailure(closed,failure,o,NOW));assert.throws(()=>recordInstallProof(closed,installEnvelope(pub,"17:3"),o,NOW));const proof=installEnvelope(failed,"17:3"),retry=recordInstallProof(failed,proof,o,NOW);assert.equal(retry.status,"proved");assert.equal(retry.installFailures.length,1);assert.throws(()=>recordInstallFailure(retry,failureEnvelope(pub,"17:4"),o,NOW));const later=makeRequest({version:"0.10.2",baseSha:B,notes,currentVersion:"0.10.1",authorization:"102"});assert.equal(initialState(later,NOW).version,"0.10.2");});

test("release effects use exact commands and reject stale launch identity before effects",{timeout:10000},async()=>{const calls:any[]=[],u=uploaded(),o=owner(u),root=mkdtempSync(join(tmpdir(),"slate-upload-")),archive=join(root,"package.tgz");writeFileSync(archive,"archive");try{assert.throws(()=>executeUpload({state:u,expected:{...o,identity:"f".repeat(64)},archive,runId:"17",runAttempt:"1",registry:"https://registry.invalid/",npmVersion:()=>"11.16.0",exec:(...x:any[])=>calls.push(x)}));executeUpload({state:u,expected:o,archive,runId:"17",runAttempt:"1",registry:"https://registry.invalid/",npmVersion:()=>"11.16.0",exec:(...x:any[])=>calls.push(x)});}finally{rmSync(root,{recursive:true,force:true});}assert.deepEqual(calls[0][1],["publish",archive,"--tag","slate-candidate","--ignore-scripts","--provenance=false","--registry","https://registry.invalid/"]);
const ps=proved(),intent=beginPromotion(ps,"0.10.0",owner(ps),"17","1",NOW);let views=0;const result=await executePromotion({state:intent,expected:owner(intent),runId:"17",runAttempt:"1",registry:promotionRegistry,...oidcFixture(),view:()=>views++===0?"0.10.0":"0.10.1"});assert.equal(result.execution,"17:1");await assert.rejects(()=>executePromotion({state:intent,expected:{...owner(intent),identity:"f".repeat(64)},runId:"17",runAttempt:"1",registry:promotionRegistry,oidcEnv,view:()=>assert.fail(),fetch:()=>assert.fail()}));
const pub=published(),installRoot=mkdtempSync(join(tmpdir(),"slate-install-"));try{let wrongN=0;assert.throws(()=>executeInstall({state:pub,expected:{...owner(pub),identity:"f".repeat(64)},runId:"17",runAttempt:"2",workspace:installRoot,out:join(installRoot,"wrong.json"),exec:()=>{wrongN++;return{stdout:""};}}));assert.equal(wrongN,0);let n=0;const proof=executeInstall({state:pub,expected:owner(pub),runId:"17",runAttempt:"2",workspace:installRoot,out:join(installRoot,"proof.json"),exec:()=>++n===2?{stdout:'{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate","sourceInfo":{"source":"npm:ytdb-slate@0.10.1"}}]}}\n'}:{stdout:""}});assert.equal(proof.identity,pub.identity);assert.equal(proof.execution,"17:2");const retryProved=recordInstallProof(pub,proof,owner(pub),NOW);assert.equal(retryProved.status,"proved");assert.equal(beginPromotion(retryProved,"0.10.0",owner(retryProved),"18","1",NOW).status,"promotion-unknown");}finally{rmSync(installRoot,{recursive:true,force:true});}
const promoted=recordPromotion(intent,result,owner(intent),NOW);calls.length=0;executeFinalRecords({state:promoted,expected:owner(promoted),notes:"notes.md",repo:"JetBrains/ytdb-slate",exec:(...x:any[])=>calls.push(x)});assert.equal(calls.filter(x=>x[0]==="git").length,2);assert.equal(calls.filter(x=>x[0]==="gh").length,1);});

test("the real npm package-spec parser classifies the exact upload argument from a relative archive",()=>{const found=spawnSync("/bin/sh",["-c","command -v npm"],{encoding:"utf8"});assert.equal(found.status,0,found.stderr);const npmPath=realpathSync(found.stdout.trim()),npmRoot=resolve(dirname(npmPath),".."),requireNpm=createRequire(join(npmRoot,"package.json")),parse=requireNpm("npm-package-arg");assert.equal(parse("archive/ytdb-slate-0.11.0.tgz").type,"git");const s=uploaded(),root=mkdtempSync(join(tmpdir(),"slate-npa-")),old=process.cwd();try{mkdirSync(join(root,"archive"));writeFileSync(join(root,"archive/package.tgz"),"archive");process.chdir(root);const calls:any[]=[];executeUpload({state:s,expected:owner(s),archive:"archive/package.tgz",runId:"17",runAttempt:"1",registry:"https://registry.invalid/",npmVersion:()=>"11.16.0",exec:(...args:any[])=>calls.push(args)});const argument=calls[0][1][1];assert.equal(argument,join(root,"archive/package.tgz"));assert.equal(parse(argument).type,"file");assert.equal(parse(argument).fetchSpec,argument);assert.throws(()=>executeUpload({state:s,expected:owner(s),archive:"archive",runId:"17",runAttempt:"1",registry:"x",npmVersion:()=>"11.16.0",exec:()=>assert.fail()}),/regular file/);assert.throws(()=>executeUpload({state:s,expected:owner(s),archive:"absent.tgz",runId:"17",runAttempt:"1",registry:"x",npmVersion:()=>"11.16.0",exec:()=>assert.fail()}));}finally{process.chdir(old);rmSync(root,{recursive:true,force:true});}});

const workflowUrl=new URL("../.github/workflows/release.yml",import.meta.url),workflow=readFileSync(workflowUrl,"utf8"),releasing=readFileSync(new URL("../RELEASING.md",import.meta.url),"utf8"),agents=readFileSync(new URL("../AGENTS.md",import.meta.url),"utf8"),mechanism=readFileSync(new URL("../verification/README.md",import.meta.url),"utf8");
function workflowJobBlock(name:string){const lines=workflow.split("\n"),start=lines.findIndex(x=>x===`  ${name}:`);assert.notEqual(start,-1,`missing workflow job ${name}`);let end=lines.length;for(let i=start+1;i<lines.length;i++)if(/^  [a-z][a-z-]*:$/.test(lines[i]??"")){end=i;break;}return lines.slice(start,end);}
function assertWorkflowExpressionQuotes(source:string){
  let count=0;
  for(const match of source.matchAll(/\$\{\{([\s\S]*?)\}\}/g)){
    count++;
    const expression=match[1]??"";
    let single=false;
    for(let i=0;i<expression.length;i++){
      if(expression[i]==="'" && single && expression[i+1]==="'"){i++;continue;}
      if(expression[i]==="'"){single=!single;continue;}
      assert.notEqual(expression[i],'"',`double-quoted expression literal: ${expression}`);
    }
    assert.equal(single,false,`unclosed expression literal: ${expression}`);
  }
  assert.ok(count>0,"workflow has no expressions");
}
function assertConditionalJobGates(source:string){
  const names=[...source.matchAll(/^  ([a-z][a-z-]*):$/gm)].map(match=>match[1]!);
  assert.ok(names.length>0);
  const lines=source.split("\n");
  const jobs=new Map(names.map(name=>{
    const start=lines.indexOf(`  ${name}:`),end=lines.findIndex((line,i)=>i>start&&/^  [a-z][a-z-]*:$/.test(line));
    const body=lines.slice(start,end<0?undefined:end).join("\n");
    const raw=/^    needs: (.+)$/m.exec(body)?.[1];
    assert.ok(raw||!/^    needs:/m.test(body),`${name} needs must stay on one line for the gate audit`);
    const needs=raw?(raw.startsWith("[")?raw.slice(1,-1).split(/,\s*/):[raw]):[];
    return [name,{needs,condition:/^    if: (.+)$/m.exec(body)?.[1]}] as const;
  }));
  const conditionalAncestor=(name:string,seen=new Set<string>()):boolean=>{
    const job=jobs.get(name);assert.ok(job,`unknown job ${name}`);
    if(seen.has(name))return false;
    seen.add(name);
    return job.needs.some(need=>{
      const parent=jobs.get(need);assert.ok(parent,`unknown need ${need}`);
      return parent.condition!==undefined||conditionalAncestor(need,seen);
    });
  };
  // Named exceptions permit failure outcomes or require an output in addition to successful needs.
  const exceptions:Record<string,string>={
    claim:"!cancelled() && needs.identify.result == 'success' && needs.identify.outputs.release_sha != ''",
    "coverage-disposition":"!cancelled() && needs.identify.result == 'success' && needs.checks.result == 'success' && needs.identify.outputs.publish == 'true'",
    pack:"!cancelled() && needs.identify.result == 'success' && needs.checks.result == 'success' && (needs.coverage-disposition.result == 'success' || (needs.coverage-disposition.result == 'skipped' && needs.identify.outputs.publish != 'true'))",
    "registry-proof":"always() && needs.identify.result == 'success' && needs.seal-upload.result == 'success' && (needs.upload.result == 'success' || needs.upload.result == 'failure' || needs.upload.result == 'cancelled')",
    "record-registry":"always() && needs.identify.result == 'success' && needs.identify.outputs.release_sha != '' && (needs.registry-proof.result == 'success' || needs.registry-proof.result == 'failure')",
    "record-install-failure":"always() && needs.identify.result == 'success' && needs.install-proof.result == 'failure'",
    "recover-promote":"!cancelled() && needs.recover.result == 'success' && needs.recover.outputs.retry_promotion == 'true'",
  };
  const gated=[...jobs].filter(([name])=>conditionalAncestor(name));
  for(const name of Object.keys(exceptions))assert.ok(gated.some(([job])=>job===name),`missing gate exception ${name}`);
  for(const [name,job] of gated){
    assert.match(job.condition??"",/^\$\{\{ (?:!cancelled\(\)|always\(\))/,`${name} must override implicit success()`);
    for(const need of job.needs)assert.ok(job.condition?.includes(`needs.${need}.result`),`${name} must inspect ${need}.result`);
    const expected=exceptions[name]??`!cancelled() && ${job.needs.map(need=>`needs.${need}.result == 'success'`).join(" && ")}`;
    assert.equal(job.condition,'${{ '+expected+' }}',`${name} must require the intended result of each dependency`);
  }
}

test("both workflows use GitHub expression string literals and guarded conditional job chains",()=>{
  const ci=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
  for(const source of [workflow,ci]){
    assertWorkflowExpressionQuotes(source);
    const mutant=source.replace(/\$\{\{([^\n]*?)'([^']+)'/,(_match:string,prefix:string,quoted:string)=>'$'+'{{'+prefix+'"'+quoted+'"');
    assert.notEqual(mutant,source);
    assert.throws(()=>assertWorkflowExpressionQuotes(mutant),/double-quoted expression literal/);
  }
  assertConditionalJobGates(workflow);
  const seal=workflowJobBlock("seal-upload").join("\n");
  assert.throws(()=>assertConditionalJobGates(workflow.replace(seal,seal.replace(/^    if: .*\n/m,""))),/seal-upload must override/);
  assert.throws(()=>assertConditionalJobGates(workflow.replace(seal,seal.replace("needs.pack.result", "needs.pack.outputs.value"))),/seal-upload must inspect pack.result/);
  for(const [name,oldGate,newGate] of [
    ["seal-upload","needs.pack.result == 'success'","needs.pack.result != 'failure'"],
    ["promote","needs.record-proof.result == 'success'","needs.record-proof.result != 'cancelled'"],
    ["checks","needs.claim.result == 'success'","needs.claim.result != 'failure'"],
  ] as const){
    const original=workflowJobBlock(name).join("\n"),mutant=original.replace(oldGate,newGate);
    assert.notEqual(mutant,original,`${name} mutant must change the job`);
    assert.throws(()=>assertConditionalJobGates(workflow.replace(original,mutant)),new RegExp(`${name} must require the intended result`));
  }
  assert.throws(()=>assertConditionalJobGates(workflow+"\n  next-job:\n    needs: pack\n    runs-on: ubuntu-latest\n"),/next-job must override/);
  const pack=workflowJobBlock("pack").join("\n");
  assert.match(pack,/needs\.coverage-disposition\.result == 'skipped' && needs\.identify\.outputs\.publish != 'true'/);
  assert.match(workflowJobBlock("registry-proof").join("\n"),/needs\.upload\.result == 'failure'/);
});

function assertReleaseContentCheckouts(source:string){
  // On main, claim and seal-upload push state using release-commit control.
  // Those state checkouts retain the write token. On publish, both jobs run stored control.
  const checkoutCounts:Record<string,number>={identify:4,claim:2,checks:1,"coverage-disposition":2,pack:1,"seal-upload":2,"registry-proof":2,"install-proof":2};
  const writeCheckout="with: { ref: release-state, fetch-depth: 0, path: state }";
  const exceptions=["claim","seal-upload"];
  for(const [name,count] of Object.entries(checkoutCounts)){
    const block=source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`,`gm`))?.[0]??"";
    assert.ok(block,`missing release-content job ${name}`);
    const lines=block.split("\n"),checkouts=lines.flatMap((line,i)=>line.includes("uses: actions/checkout@")?[lines[i+1]??""]:[]);
    assert.equal(checkouts.length,count,`${name} checkout roster changed`);
    for(const withLine of checkouts){
      if(exceptions.includes(name)&&withLine.trim()===writeCheckout)continue;
      assert.match(withLine,/persist-credentials: false/,`${name} checkout must not retain credentials`);
    }
    assert.equal(checkouts.filter(line=>line.trim()===writeCheckout).length,exceptions.includes(name)?1:0,`${name} state-writer exception changed`);
  }
  const names=[...source.matchAll(/^  ([a-z][a-z-]*):$/gm)].map(match=>match[1]!);
  const job=(name:string)=>source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`,`gm`))?.[0]??"";
  const identify=job("identify"),publish=identify.slice(identify.indexOf("      - id: publish"));
  assert.match(identify,/if: steps\.candidate\.outputs\.release_sha != ''\n        uses: actions\/checkout@[^\n]+\n        with: \{ ref: '\$\{\{ steps\.candidate\.outputs\.release_sha \}\}', path: release-code, persist-credentials: false \}/);
  assert.match(identify,/id: find\n        if: steps\.candidate\.outputs\.release_sha != ''/);
  assert.match(publish,/if: github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.action == 'publish'/);
  assert.match(publish,/from '\.\/durable\/verification\/release-control\.mjs'/);
  assert.doesNotMatch(publish,/release-code\/verification\//,"publish identification must not run release-commit control");
  assert.match(job("coverage-disposition"),/node state\/verification\/release-control\.mjs coverage-report/);
  assert.match(job("install-proof"),/if \[ '\$\{\{ needs\.identify\.outputs\.publish \}\}' = true \]; then control=state\/verification\/release-job\.mjs; fi/);
  const storedControlRef="with: { ref: \"${{ fromJSON(needs.identify.outputs.publish) && 'release-state' || needs.identify.outputs.release_sha }}\", path: control, persist-credentials: false }";
  for(const name of names){
    const block=job(name),lines=block.split("\n");
    const checkouts=lines.flatMap((line,i)=>line.includes("uses: actions/checkout@")?[lines[i+1]?.trim()??""]:[]);
    const controlCheckouts=checkouts.filter(line=>line.includes("path: control"));
    if(/(?:^|[\s"'])control\/verification\/release-(?:control|job)\.mjs/.test(block))assert.equal(controlCheckouts.length,1,`${name} must checkout its control code`);
    for(const line of controlCheckouts)assert.equal(line,storedControlRef,`${name} must select stored control on publish`);
    for(const [directory,expected,finding] of [
      ["state","with: { ref: release-state, path: state, persist-credentials: false }","stored state control"],
      ["durable","with: { ref: release-state, path: durable, persist-credentials: false }","durable control"],
      ["current-control","with: { ref: '${{ github.sha }}', path: current-control }","main dispatch control"],
    ] as const){
      if(!block.includes(`${directory}/verification/release-control.mjs`)&&!block.includes(`${directory}/verification/release-job.mjs`))continue;
      const selected=checkouts.filter(line=>line.includes(`path: ${directory}`));
      assert.ok(selected.length>0,`${name} must checkout ${finding}`);
      for(const line of selected)assert.equal(line,expected,`${name} must select ${finding}`);
    }
    // Preparation runs dispatch control. Identify and install-proof have separately checked main/publish paths.
    if(["prepare","identify","install-proof"].includes(name))continue;
    if(/(?:^|[\s"'])verification\/release-(?:control|job)\.mjs/.test(block)){
      const rootCheckouts=checkouts.filter(line=>!line.includes("path:"));
      assert.ok(rootCheckouts.length>0,`${name} must checkout stored root control`);
      for(const line of rootCheckouts)assert.match(line,/^with: \{ ref: release-state(?:,| \})/,`${name} must select stored root control`);
    }
  }
  const releaseRefs=["needs.identify.outputs.release_sha","steps.candidate.outputs.release_sha","fromJSON(needs.identify.outputs.publish)"];
  const releaseJobs=names.filter(name=>job(name).split("\n").some(line=>line.includes("with: {")&&releaseRefs.some(ref=>line.includes(ref))));
  assert.deepEqual(releaseJobs.sort(),Object.keys(checkoutCounts).sort(),"release-commit checkout job roster changed");
  for(const name of exceptions){
    const block=job(name);
    assert.match(block,/git -C state push origin HEAD:release-state/,`${name} must still need the state write`);
    assert.match(block,/fromJSON\(needs\.identify\.outputs\.publish\) && 'release-state' \|\| needs\.identify\.outputs\.release_sha/,`${name} must select release-commit control on main`);
  }
}
test("release-content checkouts keep only the two main-path state-writer credentials",()=>{
  assertReleaseContentCheckouts(workflow);
  for(const sibling of ["with: { ref: release-state, path: durable, persist-credentials: false }","with: { ref: release-state, path: state, persist-credentials: false }"]){
    const mutant=workflow.replace(sibling,sibling.replace(", persist-credentials: false",""));
    assert.notEqual(mutant,workflow);
    assert.throws(()=>assertReleaseContentCheckouts(mutant),/checkout must not retain credentials/);
  }
  const conditional="fromJSON(needs.identify.outputs.publish) && 'release-state' || needs.identify.outputs.release_sha";
  const controlJobs=[...workflow.matchAll(/^  ([a-z][a-z-]*):\n[\s\S]*?(?=^  [a-z][a-z-]*:|$(?![\s\S]))/gm)]
    .filter(match=>match[0].includes("path: control"));
  assert.ok(controlJobs.length>=3);
  for(const [name,block] of controlJobs.map(match=>[match[1]!,match[0]] as const)){
    assert.ok(block.includes(conditional),`${name} mutant must change the checkout`);
    const mutant=workflow.replace(block,()=>block.replace(conditional,"needs.identify.outputs.release_sha"));
    assert.throws(()=>assertReleaseContentCheckouts(mutant),/must select stored control on publish/);
  }
  for(const name of ["record-registry","recover","close"]){
    const block=workflowJobBlock(name).join("\n");
    assert.ok(block.includes("with: { ref: release-state"),`${name} mutant must change the checkout`);
    const mutant=workflow.replace(block,()=>block.replace("with: { ref: release-state","with: { ref: '${{ needs.identify.outputs.release_sha }}'"));
    assert.throws(()=>assertReleaseContentCheckouts(mutant),/must select stored root control/);
  }
  for(const [name,ref,finding] of [
    ["coverage-disposition","ref: release-state, path: state",/must select stored state control/],
    ["install-proof","ref: release-state, path: state",/must select stored state control/],
    ["identify","ref: release-state, path: durable",/must select durable control/],
    ["retire","ref: '${{ github.sha }}', path: current-control",/must select main dispatch control/],
  ] as const){
    const block=workflowJobBlock(name).join("\n");
    assert.ok(block.includes(ref),`${name} mutant must change the checkout`);
    const mutant=workflow.replace(block,()=>block.replace(ref,"ref: '${{ needs.identify.outputs.release_sha }}', path: "+ref.split("path: ")[1]));
    assert.throws(()=>assertReleaseContentCheckouts(mutant),finding);
  }
  for(const [original,replacement,finding] of [
    ["from './durable/verification/release-control.mjs'","from './release-code/verification/release-control.mjs'",/publish identification must not run release-commit control/],
    ["then control=state/verification/release-job.mjs","then control=verification/release-job.mjs",/install-proof/],
  ] as const){
    const mutant=workflow.replace(original,replacement);
    assert.notEqual(mutant,workflow);
    assert.throws(()=>assertReleaseContentCheckouts(mutant),finding);
  }
});
function workflowRunBody(lines:string[],marker:number){const markerLine=lines[marker]??"",markerIndent=markerLine.length-markerLine.trimStart().length,body:string[]=[];for(let i=marker+1;i<lines.length;i++){const line=lines[i]??"",indent=line.length-line.trimStart().length;if(line.trim()&&indent<=markerIndent)break;body.push(line);}const contentIndent=Math.min(...body.filter(x=>x.trim()).map(x=>x.length-x.trimStart().length));return body.map(x=>x.slice(Math.min(contentIndent,x.length))).join("\n");}
function workflowRunBlock(name:string){const lines=workflowJobBlock(name),marker=lines.findIndex(x=>["run: |","- run: |"].includes(x.trim()));assert.notEqual(marker,-1,`missing run block for ${name}`);return workflowRunBody(lines,marker);}
function workflowStepRunBlock(job:string,id:string){const lines=workflowJobBlock(job),step=lines.findIndex(x=>x.trim()===`- id: ${id}`);assert.notEqual(step,-1,`missing workflow step ${job}.${id}`);const marker=lines.findIndex((x,i)=>i>step&&["run: |","- run: |"].includes(x.trim()));assert.notEqual(marker,-1,`missing run block for ${job}.${id}`);return workflowRunBody(lines,marker);}
function renderWorkflowBlock(source:string,values:Record<string,string>={}){return source.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,(_all,key:string)=>{const value=values[key.trim()];if(value===undefined)throw new Error(`unknown workflow expression ${key}`);return value;});}
function workflowFixture(t:any,state:any){const root=mkdtempSync(join(tmpdir(),"slate-workflow-")),bin=join(root,"bin"),effectLog=join(root,"effects.log"),temp=join(root,"tmp");t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(bin);mkdirSync(temp);mkdirSync(join(root,"verification"));mkdirSync(join(root,"control/verification"),{recursive:true});mkdirSync(join(root,"state/archive"),{recursive:true});mkdirSync(join(root,"current-control/verification"),{recursive:true});mkdirSync(join(root,"runner"));for(const dir of["verification","control/verification","current-control/verification"])for(const file of["release-control.mjs","release-job.mjs"])cpSync(new URL(`../verification/${file}`,import.meta.url),join(root,dir,file));writeFileSync(join(root,"state.json"),JSON.stringify(state,null,2)+"\n");writeFileSync(join(root,"state/state.json"),JSON.stringify(state,null,2)+"\n");writeFileSync(join(root,"request.json"),JSON.stringify(req()));writeFileSync(join(root,"state/request.json"),JSON.stringify(req()));writeFileSync(join(root,"state/archive/package.tgz"),"archive");writeFileSync(effectLog,"");writeFileSync(join(bin,"git"),`#!/bin/sh\nprintf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"rev-parse HEAD"*) printf '${C}\\n';; esac\nexit 0\n`);writeFileSync(join(bin,"gh"),`#!/bin/sh\nprintf 'gh\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"/pulls?"*) if test -n "${'${GH_EXPECT_PRS_QUERY:-}'}"; then if ! { test "$#" -eq 5 && test "$1" = api && test "$2" = --paginate && test "$3" = "$GH_EXPECT_PRS_QUERY" && test "$4" = --jq && test "$5" = tojson; }; then printf 'unexpected preparation pull request query: %s\\n' "$*" >&2; exit 2; fi; fi; test "${'${GH_FAIL_PRS:-0}'}" = 1 && { printf '[]\\n'; exit 1; }; test -f "$GH_PRS" || exit 1; cat "$GH_PRS"; test "${'${GH_FAIL_PRS:-0}'}" = 0 || exit 1;; *"/jobs?"*) test "${'${GH_FAIL_JOBS:-0}'}" = 1 && exit 1; test -f "$GH_JOBS" || exit 1; cat "$GH_JOBS"; test "${'${GH_FAIL_JOBS:-0}'}" = 0 || exit 1;; *"/attempts/"*) test "${'${GH_FAIL_RUN:-0}'}" = 1 && exit 1; test -f "$GH_RUN" || exit 1; cat "$GH_RUN"; test "${'${GH_FAIL_RUN:-0}'}" = 0 || exit 1;; esac\nexit 0\n`);writeFileSync(join(root,"latest"),"0.10.0\n");writeFileSync(join(bin,"npm"),`#!/bin/sh\nprintf 'npm\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"versions time"*) test "${'${NPM_FAIL:-0}'}" = 0 || { if test "${'${NPM_FAIL:-0}'}" = 4; then cat "$NPM_DOC"; exit 1; fi; echo 'E404 or network failure' >&2; exit 1; }; test -f "$NPM_DOC" && { cat "$NPM_DOC"; exit 0; }; exit 1;; *"dist-tags.latest"*) n=$(($(cat "$NPM_READ_COUNT" 2>/dev/null || echo 0)+1)); echo "$n" >"$NPM_READ_COUNT"; case "${'${NPM_READ_FAIL_FIRST:-0}'}:$n" in 1:1) echo 'PRIVATE REGISTRY RESPONSE' >&2; exit 1;; esac; case "${'${NPM_READ_FAIL_SECOND:-0}'}:$n" in 1:2) echo 'PRIVATE REGISTRY RESPONSE' >&2; exit 1;; esac; test -z "${'${NODE_AUTH_TOKEN:-}'}${'${NPM_TOKEN:-}'}${'${npm_config__authToken:-}'}" || exit 9; if test -n "${'${NPM_READS:-}'}"; then row=$(sed -n "${'$'}{n}p" "$NPM_READS"); test "$row" != FAIL || exit 1; test -n "$row" && { printf '%s\\n' "$row"; exit 0; }; fi; case "$*" in *--json*) printf '\"%s\"\\n' "$(cat "$NPM_LATEST_FILE")";; *) cat "$NPM_LATEST_FILE";; esac;; *"dist-tag add"*) printf '%s\\n' "$*" >>"$NPM_WRITE_LOG"; test "${'${NODE_AUTH_TOKEN:-}'}" = fixture-stage-token || { echo 'missing authorized token' >&2; exit 8; }; test "${'${NPM_WRITE_FAIL:-0}'}" = 0 || { if test "${'${NPM_WRITE_FAIL:-0}'}" = 3; then printf '%s\\n' "${'${3#ytdb-slate@}'}" >"$NPM_LATEST_FILE"; echo 'npm error code ETIMEDOUT' >&2; elif test "${'${NPM_WRITE_FAIL:-0}'}" = 2; then echo 'UNKNOWN npm failure' >&2; else echo 'npm error code E403' >&2; fi; exit 1; }; test "${'${NPM_WRITE_STALE:-0}'}" = 1 || printf '%s\\n' "${'${3#ytdb-slate@}'}" >"$NPM_LATEST_FILE";; esac\nexit 0\n`);writeFileSync(join(bin,"pi"),`#!/bin/sh\nprintf 'pi\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"--mode rpc"*) if test "${'${PI_SUCCESS:-0}'}" = 1; then printf '{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate","sourceInfo":{"source":"npm:ytdb-slate@0.10.1"}}]}}\\n'; else printf '{"type":"response","command":"get_commands","data":{"commands":[]}}\\n'; fi;; esac\nexit 0\n`);for(const name of["git","gh","npm","pi"])chmodSync(join(bin,name),0o755);writeFileSync(join(root,"clock.mjs"),`import assert from 'node:assert/strict';import {appendFileSync,writeFileSync} from 'node:fs';
let tick=0;Object.defineProperty(performance,'now',{value:()=>tick});Atomics.wait=(_a,_i,_v,ms)=>{tick+=ms;return 'timed-out';};
const masks=[];const log=console.log;console.log=(...args)=>{if(String(args[0]).startsWith('::add-mask::'))masks.push(String(args[0]).slice(12));log(...args);};
globalThis.fetch=async(url,options)=>{
 assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
 const method=options.method;appendFileSync(process.env.EFFECT_LOG,'oidc\\t'+method+'\\n');
 if(method==='GET'){assert.equal(url,'https://github.example/token?audience=npm%3Aregistry.npmjs.org');assert.equal(options.headers.Authorization,'Bearer fixture-request-token');return Response.json({value:'fixture-id-token'});}
 if(method==='POST'){assert.equal(url,'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/ytdb-slate');assert.deepEqual(masks,['fixture-id-token']);assert.equal(options.headers.Authorization,'Bearer fixture-id-token');assert.equal(options.body,undefined);return Response.json({token:'fixture-npm-token'},{status:201});}
 assert.equal(method,'PUT');assert.equal(url,'https://registry.npmjs.org/-/package/ytdb-slate/dist-tags/latest');assert.deepEqual(masks,['fixture-id-token','fixture-npm-token']);assert.equal(options.headers.Authorization,'Bearer fixture-npm-token');
 const version=JSON.parse(options.body);appendFileSync(process.env.NPM_WRITE_LOG,version+'\\n');
 const fail=process.env.NPM_WRITE_FAIL??'0';
 if(fail==='3'){writeFileSync(process.env.NPM_LATEST_FILE,version+'\\n');throw new TypeError('PRIVATE fixture-npm-token',{cause:{code:'ETIMEDOUT'}});}
 if(fail==='2')throw Error('UNKNOWN npm failure fixture-id-token');
 if(fail==='1')return new Response('PRIVATE fixture-npm-token',{status:403});
 if(process.env.NPM_WRITE_STALE!=='1')writeFileSync(process.env.NPM_LATEST_FILE,version+'\\n');
 return new Response(null,{status:200});
};\n`);const env={NODE_OPTIONS:`--import=${join(root,"clock.mjs")}`,PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,PI_BIN:join(bin,"pi"),HOME:root,TMPDIR:temp,RUNNER_TEMP:join(root,"runner"),REGISTRY:promotionRegistry,GH_RUN:join(root,"run.json"),GH_JOBS:join(root,"jobs.json"),GH_PRS:join(root,"prs.jsonl"),NPM_DOC:join(root,"package.json"),GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",EFFECT_LOG:effectLog,NPM_WRITE_LOG:join(root,"npm-writes"),NPM_LATEST_FILE:join(root,"latest"),NPM_READ_COUNT:join(root,"read-count"),GITHUB_RUN_ID:"900",GITHUB_RUN_ATTEMPT:"2",GITHUB_REPOSITORY:"JetBrains/ytdb-slate",GITHUB_OUTPUT:join(root,"output")};return{root,effectLog,env};}
function runWorkflowBlock(f:any,script:string,more:Record<string,string>={}){return spawnSync("/bin/bash",["-c",script],{cwd:f.root,env:{...f.env,...more},encoding:"utf8",timeout:10000});}
function registryProofFixture(t:any,state:any,scenario:string){
  const f=workflowFixture(t,state),attempts=join(f.root,"npm-attempts");
  writeFileSync(attempts,"0\n");
  writeFileSync(join(f.root,"bin/sleep"),`#!/bin/sh\nprintf 'sleep\\t%s\\n' "$*" >>"$EFFECT_LOG"\nif test "$SCENARIO" = delayed && test "$1" = 5; then /bin/sleep 1.2; fi\n`);
  writeFileSync(join(f.root,"bin/npm"),`#!/bin/sh
printf 'npm\\t%s\\n' "$*" >>"$EFFECT_LOG"
test "$2" = "ytdb-slate@$NPM_VERSION" || exit 7
case "$1" in
  view)
    test "$3" = version && test "$4" = dist.integrity || exit 7
    n=$(($(cat "$NPM_ATTEMPTS")+1)); printf '%s\\n' "$n" >"$NPM_ATTEMPTS"
    case "$SCENARIO:$n" in
      delayed:1) printf '{"error":{"code":"E404"}}\\n'; exit 1 ;;
      delayed:2) printf '{bad\\n'; exit 0 ;;
      delayed:3) printf '{"version":"0.10.2","dist.integrity":"%s"}\\n' "$NPM_INTEGRITY"; exit 0 ;;
      delayed:4) printf '{"version":"%s"}\\n' "$NPM_VERSION"; exit 0 ;;
    esac
    printf '{"version":"%s","dist.integrity":"%s"}\\n' "$NPM_VERSION" "$NPM_INTEGRITY" ;;
  pack)
    case "$SCENARIO" in
      download-fail) exit 1 ;;
      partial-pack) cp state/archive/package.tgz "registry/ytdb-slate-$NPM_VERSION.tgz"; exit 1 ;;
      stale-archive) if test "$(cat "$NPM_ATTEMPTS")" = 1; then cp state/archive/package.tgz "registry/ytdb-slate-$NPM_VERSION.tgz"; exit 1; fi; exit 0 ;;
      no-archive) exit 0 ;;
      wrong-bytes) printf 'wrong bytes' >"registry/ytdb-slate-$NPM_VERSION.tgz" ;;
      *) cp state/archive/package.tgz "registry/ytdb-slate-$NPM_VERSION.tgz" ;;
    esac
    printf 'ytdb-slate-%s.tgz\\n' "$NPM_VERSION" ;;
  *) exit 7 ;;
esac
`);
  chmodSync(join(f.root,"bin/sleep"),0o755);
  return {...f,env:{...f.env,NPM_ATTEMPTS:attempts,NPM_VERSION:state.version,NPM_INTEGRITY:hashBytes(Buffer.from("archive")).integrity,SCENARIO:scenario},attempts};
}
function assertRegistryProofLog(run:any,f:any,waits:number[],outcomes:string[],minElapsedAtAttempt=0){
  const lines=run.stdout.trim().split("\n"),pattern=/^registry proof attempt=(\d+) wait=(\d+)s elapsed=(\d+)s outcome=([a-z-]+)$/;
  const matches=lines.filter((line:string)=>line.startsWith("registry proof attempt=")).map((line:string)=>pattern.exec(line));
  assert.ok(matches.every((match:RegExpExecArray|null)=>match!==null),run.stdout);
  assert.deepEqual(matches.map((match:RegExpExecArray|null)=>Number(match?.[1])),waits.map((_wait,i)=>i+1));
  assert.deepEqual(matches.map((match:RegExpExecArray|null)=>Number(match?.[2])),waits);
  assert.deepEqual(matches.map((match:RegExpExecArray|null)=>match?.[4]),outcomes);
  const elapsed=matches.map((match:RegExpExecArray|null)=>Number(match?.[3]));
  assert.ok(elapsed.every((value:number,i:number)=>Number.isFinite(value)&&value>=0&&(i===0||value>=elapsed[i-1]!)));
  if(minElapsedAtAttempt)assert.ok(elapsed[minElapsedAtAttempt-1]!>=1,`attempt ${minElapsedAtAttempt} must record at least one elapsed second`);
  const effects=readFileSync(f.effectLog,"utf8").trim().split("\n");
  assert.deepEqual(effects.filter((line:string)=>line.startsWith("sleep\t")),waits.map(wait=>`sleep\t${wait}`));
  assert.equal(effects.filter((line:string)=>line.startsWith("npm\tview ")).length,waits.length);
  assert.equal(readFileSync(f.attempts,"utf8").trim(),String(waits.length));
  return effects.filter((line:string)=>line.startsWith("npm\tpack "));
}

const workflowValues=(state:any)=>({"needs.identify.outputs.publish":"false","needs.identify.outputs.identity":state.identity,"needs.identify.outputs.version":state.version,"needs.identify.outputs.release_sha":state.releaseSha,"needs.identify.outputs.parent_sha":state.releaseParent});
function outputValues(path:string){return Object.fromEntries(readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(line=>{const at=line.indexOf("=");return[line.slice(0,at),line.slice(at+1)];}));}

// Independent legacy-policy fixtures implement the stored recovery contract.
const legacyPromotionControl=String.raw`
import fs from 'node:fs';import {resolve} from 'node:path';
const owner=(s,e)=>{if(s.identity!==e.identity||s.version!==e.version||s.releaseSha!==e.releaseSha||s.releaseParent!==e.releaseParent)throw Error('legacy owner differs');return structuredClone(s);};
export function beginPromotion(input,latest,e,run,attempt,now){const s=owner(input,e);if(s.status!=='proved'||!['none','conflict','superseded','refused','not-attempted'].includes(s.promotion))throw Error('legacy intent refused');return {...s,status:'promotion-unknown',promotion:'unknown',promoterExecution:run+':'+attempt,promotionEvidence:{identity:s.identity,releaseSha:s.releaseSha,execution:run+':'+attempt,expectedLatest:latest,intentAt:now}};}
export function recordPromotion(input,r,e,now){const s=owner(input,e);if(s.status!=='promotion-unknown'||s.promotion!=='unknown'||r.identity!==s.identity||r.releaseSha!==s.releaseSha||r.execution!==s.promoterExecution)throw Error('legacy result differs');if(r.result==='verified'&&r.after===s.version)return {...s,status:'promoted',promotion:'verified',promotionEvidence:{...s.promotionEvidence,...r},updatedAt:now};if(['conflict','superseded','refused','not-attempted'].includes(r.result))return {...s,status:'proved',promotion:r.result,promotionEvidence:{...s.promotionEvidence,...r},promoterExecution:null,updatedAt:now};throw Error('legacy unknown result');}
export function authorizePromotion(s,e,run,attempt){owner(s,e);if(s.status!=='promotion-unknown'||s.promoterExecution!==run+':'+attempt)throw Error('legacy execution differs');return {...e,expectedLatest:s.promotionEvidence.expectedLatest,execution:s.promoterExecution};}
if(resolve(process.argv[1]??'')===resolve(new URL(import.meta.url).pathname)){
 const [cmd,...xs]=process.argv.slice(2),a={};for(let i=0;i<xs.length;i+=2)a[xs[i].slice(2)]=xs[i+1];const s=JSON.parse(fs.readFileSync(a.state)),e={identity:a.identity,version:a.version,releaseSha:a.sha,releaseParent:a.parent},now=new Date().toISOString();let out;
 if(cmd==='promotion-record')out=recordPromotion(s,JSON.parse(fs.readFileSync(a.result)),e,now);
 else if(cmd==='promotion-intent')out=beginPromotion(s,a.latest,e,a['run-id'],a['run-attempt'],now);
 else if(cmd==='advance'){owner(s,e);if(s.status!=='promoted'||s.promotion!=='verified'||a.next!=='complete')throw Error('legacy finalization refused');out={...s,status:'complete'};}
 else throw Error('unsupported legacy command');fs.writeFileSync(a.out,JSON.stringify(out));
}`;
const legacyPromotionJob=String.raw`
import fs from 'node:fs';import {resolve} from 'node:path';import {spawnSync} from 'node:child_process';import {authorizePromotion} from './release-control.mjs';
const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',...options});if(r.status!==0){const e=Error('legacy command failed');e.stderr=r.stderr;throw e;}return r.stdout.trim();};
export function executePromotion({state,expected,runId,runAttempt,registry,token}){const a=authorizePromotion(state,expected,runId,runAttempt),envelope={identity:a.identity,releaseSha:a.releaseSha,execution:a.execution};if(!token)return {...envelope,result:'not-attempted',cause:'missing-token'};let before;try{before=run('npm',['view','ytdb-slate','dist-tags.latest','--registry',registry]);}catch{return {...envelope,result:'not-attempted',cause:'latest-read-failed'};}if(before!==a.expectedLatest)return {...envelope,result:'conflict',before,expected:a.expectedLatest,after:before};try{run('npm',['dist-tag','add','ytdb-slate@'+a.version,'latest','--registry',registry],{env:{...process.env,NODE_AUTH_TOKEN:token}});}catch(e){if(/E401|E403/.test(e.stderr))return {...envelope,result:'refused',before,after:before};throw e;}const after=run('npm',['view','ytdb-slate','dist-tags.latest','--registry',registry]);if(after!==a.version)throw Error('legacy unresolved');return {...envelope,result:'verified',before,after};}
if(resolve(process.argv[1]??'')===resolve(new URL(import.meta.url).pathname)){
 const [cmd,...xs]=process.argv.slice(2),a={};for(let i=0;i<xs.length;i+=2)a[xs[i].slice(2)]=xs[i+1];const s=JSON.parse(fs.readFileSync(a.state));
 if(cmd==='final-records'){if(s.status!=='promoted'||s.promotion!=='verified'||!s.installProof)throw Error('legacy final proof missing');run('git',['tag','v'+s.version,s.releaseSha]);run('git',['push','origin','refs/tags/v'+s.version]);run('gh',['release','create','v'+s.version]);}
 else if(cmd==='promote')fs.writeFileSync(a.out,JSON.stringify(executePromotion({state:s,expected:{identity:a.identity,version:a.version,releaseSha:a.sha,releaseParent:a.parent},runId:a['run-id'],runAttempt:a['run-attempt'],registry:a.registry,token:process.env.NODE_AUTH_TOKEN})));
 else throw Error('unsupported legacy effect');
}`;

function useLegacyPromotion(f:any){writeFileSync(join(f.root,"verification/release-control.mjs"),legacyPromotionControl);writeFileSync(join(f.root,"verification/release-job.mjs"),legacyPromotionJob);}
function promotionScript(s:any){const line=workflowJobBlock("promote").join("\n").match(/^\s*run: (node verification\/release-job\.mjs promote[^\n]*)$/m)?.[1];assert.ok(line);return renderWorkflowBlock(line,workflowValues(s));}

test("workflow supports independent legacy recovery and refuses partial declarations without writes",{timeout:15000},t=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"900","2",NOW),base={identity:intent.identity,releaseSha:intent.releaseSha,execution:"900:2"};
  for(const latest of ["0.10.0","0.10.1","0.9.0"]){
    const f=workflowFixture(t,intent);useLegacyPromotion(f);writeFileSync(join(f.root,"latest"),latest+"\n");const r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:intent.version,IDENTITY:intent.identity});assert.equal(r.status,0,r.stderr);
    const state=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(state.status,latest===intent.version?"complete":"proved");assert.equal(state.promotion,latest===intent.version?"verified":"superseded");assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add/);assert.doesNotMatch(readFileSync(f.env.GITHUB_OUTPUT,"utf8"),/retry_promotion=true/);
  }
  for(const result of [{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode:"E403"},{...base,result:"not-attempted",cause:"latest-read-failed"}]){
    const state=recordPromotion(intent,result,owner(intent),NOW);
    for(const latest of ["0.10.0","0.9.0"]){const f=workflowFixture(t,state);useLegacyPromotion(f);writeFileSync(join(f.root,"latest"),latest+"\n");const before=readFileSync(join(f.root,"state.json"),"utf8"),r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:state.version,IDENTITY:state.identity,GITHUB_RUN_ATTEMPT:"3"});if(latest==="0.10.0"){assert.equal(r.status,0,r.stderr);assert.match(readFileSync(f.env.GITHUB_OUTPUT,"utf8"),/retry_promotion=true/);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).promoterExecution,"900:3");}else{assert.notEqual(r.status,0);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\t.*(?:add|commit|push)/);}}
  }
  for(const declaration of ["control","job","bad-both"]){const f=workflowFixture(t,intent);useLegacyPromotion(f);const before=readFileSync(join(f.root,"state.json"),"utf8");for(const module of ["control","job"]){if(declaration===module||declaration==="bad-both"){const path=join(f.root,`verification/release-${module}.mjs`);writeFileSync(path,readFileSync(path,"utf8")+`\nexport const PROMOTION_OBSERVATION=${JSON.stringify(declaration==="bad-both"?42:"bounded-latest-v1")};\n`);}}
    const r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:intent.version,IDENTITY:intent.identity});assert.notEqual(r.status,0);assert.match(r.stderr,/support is inconsistent/);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\t|git\t.*(?:add|commit|push)/);
  }
});

test("real promotion and recovery workflows handle stale reads, unchanged results and read failures",{timeout:30000},t=>{
  const intent=beginPromotion(proved(),"0.10.0",owner(proved()),"900","2",NOW);
  for(const recovery of [false,true]){
    for(const [responses,wanted] of [[["0.10.0","0.10.0","0.10.1"],"verified"],[["0.10.0"],"unchanged"],[["0.10.1"],"verified"],[["0.9.0"],"superseded"],[["0.9.0","0.10.1"],"verified"],[["0.10.0","FAIL"],"failure"],[["{bad"],"failure"],[["[]"],"failure"]] as const){
      const f=workflowFixture(t,intent),reads=join(f.root,"reads");writeFileSync(join(f.root,"latest"),responses[0]!=="{bad"&&responses[0]!=="[]"?responses[0]+"\n":"0.10.0\n");writeFileSync(reads,responses.map(s=>s==="FAIL"||s==="{bad"||s==="[]"?s:JSON.stringify(s)).join("\n")+"\n");
      const before=readFileSync(join(f.root,"state.json"),"utf8"),r=runWorkflowBlock(f,recovery?workflowRunBlock("recover"):promotionScript(intent),{VERSION:intent.version,IDENTITY:intent.identity,GITHUB_RUN_ATTEMPT:recovery?"3":"2",...(!recovery?{ACTIONS_ID_TOKEN_REQUEST_URL:"https://github.example/token",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"fixture-request-token",NPM_TOKEN:"alias-secret",npm_config__authToken:"alias-secret"}:{}),NPM_READS:reads,NPM_WRITE_STALE:"1"});
      const effects=readFileSync(f.effectLog,"utf8");assert.match(effects,/--fetch-retries=0/);assert.match(effects,/--fetch-timeout=/);
      const expectedWrites=!recovery&&responses[0]==="0.10.0"?1:0;
      assert.equal(effects.split("\n").filter(line=>line==="oidc\tPUT").length,expectedWrites,`${recovery}/${responses}`);
      assert.doesNotMatch(effects,/npm\tdist-tag add/);
      if(expectedWrites)assert.equal(readFileSync(f.env.NPM_WRITE_LOG,"utf8").trim().split("\n").length,1);
      else assert.throws(()=>readFileSync(f.env.NPM_WRITE_LOG),/ENOENT/);
      if(wanted==="failure"){assert.notEqual(r.status,0,`${recovery}/${responses}`);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)/);assert.throws(()=>readFileSync(join(f.root,recovery?"promotion-recovery.json":"runner/promotion.json")),/ENOENT/);continue;}
      assert.equal(r.status,0,`${recovery}/${responses}: ${r.stderr}`);const result=JSON.parse(readFileSync(join(f.root,recovery?"promotion-recovery.json":"runner/promotion.json"),"utf8"));assert.equal(result.result,wanted);
      assert.equal(r.stdout.includes("::error::"),wanted!=="verified");assert.doesNotMatch(JSON.stringify(result)+r.stdout,/alias-secret|fixture-stage-token/);
      if(recovery){assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,wanted==="verified"?"complete":wanted==="unchanged"?"promotion-unknown":"proved");assert.equal(readFileSync(f.env.GITHUB_OUTPUT,"utf8").includes("retry_promotion=true"),wanted==="unchanged");assert.doesNotMatch(effects,/npm\tdist-tag add/);}
      else{mkdirSync(join(f.root,"promotion"));cpSync(join(f.root,"runner/promotion.json"),join(f.root,"promotion/promotion.json"));writeFileSync(join(f.root,"promotion/untrusted.txt"),"secret");const recorded=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("record-promotion"),workflowValues(intent)));assert.equal(recorded.status,0,recorded.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).promotion,wanted);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\tadd .*promotion/);}
    }
  }
});

test("real npm read timeout kills retries and reads receive no credential environment",{timeout:5000},t=>{
  const f=workflowFixture(t,proved()),path=process.env.PATH;writeFileSync(join(f.root,"bin/npm"),'#!/bin/sh\nprintf "%s\\n" "$*" >"$HOME/read-args"\nexec /bin/sleep 5\n');
  const home=process.env.HOME;process.env.PATH=f.env.PATH;process.env.HOME=f.root;
  try{const start=performance.now();assert.throws(()=>observeLatest({registry:"https://registry.invalid/",version:"0.10.1",expectedLatest:"0.10.0",allowance:60}),(error:any)=>{assert.equal(error.message,"latest read timed out");assert.equal(error.cause?.code,"ETIMEDOUT");assert.equal(error.cause?.signal,"SIGKILL");return true;});assert.ok(performance.now()-start<1000,"a timed-out read must finish within one second");assert.match(readFileSync(join(f.root,"read-args"),"utf8"),/--fetch-retries=0 --fetch-timeout=\d+/);}
  finally{if(path===undefined)delete process.env.PATH;else process.env.PATH=path;if(home===undefined)delete process.env.HOME;else process.env.HOME=home;}
  const credentialNames=["NODE_AUTH_TOKEN","NPM_TOKEN","npm_config__authToken","ACTIONS_ID_TOKEN_REQUEST_URL","ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  const saved=Object.fromEntries(credentialNames.map(k=>[k,process.env[k]]));for(const name of credentialNames)process.env[name]="secret";
  try{const opts=latestReadOptions(37);assert.equal(opts.timeout,37);assert.equal(opts.killSignal,"SIGKILL");assert.ok(Object.keys(opts.env).every(k=>!/token|auth|password/i.test(k)));assert.notEqual(opts.env.npm_config_userconfig,opts.env.npm_config_globalconfig);assert.equal(readFileSync(opts.env.npm_config_userconfig,"utf8"),"");assert.equal(readFileSync(opts.env.npm_config_globalconfig,"utf8"),"");}
  finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
function installedNpmReadFixture(t:TestContext){
  const root=mkdtempSync(join(tmpdir(),"slate-installed-npm-")),home=join(root,"home"),cache=join(root,"cache"),project=join(root,"project");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const path of [home,cache,project])mkdirSync(path);
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_/i.test(key)&&!/^NODE_OPTIONS$/i.test(key)));
  const env={...inherited,HOME:home,USERPROFILE:home,npm_config_offline:"true",npm_config_update_notifier:"false",npm_config_cache:cache};
  const run=(body:string,timeout=5000)=>{
    const script=`
      import assert from "node:assert/strict";
      import { spawnSync } from "node:child_process";
      import { latestReadOptions } from ${JSON.stringify(new URL("../verification/release-job.mjs",import.meta.url).href)};
      const options=latestReadOptions(${timeout});
      function runNpm(args,overrides={}){
        const spawnOptions={encoding:"utf8",...options,...overrides};
        assert.equal(spawnOptions.env.npm_config_offline,"true","real npm must run offline");
        assert.equal(spawnOptions.env.npm_config_update_notifier,"false","real npm must disable update checks");
        assert.equal(spawnOptions.env.npm_config_cache,${JSON.stringify(cache)},"real npm must use the temporary cache");
        assert.equal(spawnOptions.env.HOME,${JSON.stringify(home)},"real npm must use the temporary home");
        assert.ok(Object.keys(spawnOptions.env).every(key=>!/^npm_config_/i.test(key)||/^npm_config_(offline|update_notifier|cache|userconfig|globalconfig)$/.test(key)),"real npm must not inherit configuration overrides");
        return spawnSync("npm",args,spawnOptions);
      }
      ${body}
    `;
    const r=spawnSync(process.execPath,["--input-type=module","--eval",script],{cwd:project,env,encoding:"utf8",timeout:10000});
    assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);
  };
  return{project,run};
}

test("real installed npm loads the production token-free read options without network",{timeout:15000},t=>{
  const f=installedNpmReadFixture(t);
  f.run(`
    for(const key of ["userconfig","globalconfig","offline","update-notifier","cache"]){
      const r=runNpm(["config","get",key]);
      assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),options.env["npm_config_"+key.replaceAll("-","_")]);
    }
    const r=runNpm(["--version"]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/^\\d+\\.\\d+\\.\\d+\\s*$/);
  `);
});

test("real installed npm read options ignore project npm configuration",{timeout:10000},t=>{
  const f=installedNpmReadFixture(t),sentinel="https://project-config-sentinel.invalid/";
  writeFileSync(join(f.project,"package.json"),'{"private":true}\n');
  writeFileSync(join(f.project,".npmrc"),`registry=${sentinel}\n`);
  f.run(`
    const control=runNpm(["config","get","registry"],{cwd:process.cwd()});
    assert.equal(control.error,undefined);
    assert.equal(control.status,0,control.stderr);
    assert.equal(control.stdout.trim(),${JSON.stringify(sentinel)},"the project configuration must load in the control");
    const isolated=runNpm(["config","get","registry"]);
    assert.equal(isolated.error,undefined);
    assert.equal(isolated.status,0,isolated.stderr);
    assert.notEqual(isolated.stdout.trim(),${JSON.stringify(sentinel)},"production reads must ignore project configuration");
  `,2000);
});

function identifyCheckout(){const lines=workflowJobBlock("identify"),checkout=lines.findIndex(x=>x.includes("with: { ref: release-state, path: durable, persist-credentials: false }")),releaseCode=lines.findIndex(x=>x.includes("with: { ref: '${{ steps.candidate.outputs.release_sha }}', path: release-code, persist-credentials: false }"));assert.notEqual(checkout,-1);assert.ok(releaseCode>checkout,"identify must check out the selected release commit after durable state");const condition=lines.slice(0,checkout).reverse().find(x=>x.trim().startsWith("- if:"))?.trim().slice(5).trim();assert.ok(condition);assert.equal(lines.slice(checkout+1,releaseCode).reverse().find(x=>x.trim().startsWith("- if:"))?.trim().slice(5).trim(),condition);return{condition,ref:"release-state",index:checkout,releaseCode};}
function candidateCondition(condition:string,releaseSha:string){if(condition==="steps.candidate.outputs.release_sha != ''")return releaseSha!=="";if(condition==="always()")return true;throw new Error(`unsupported candidate condition: ${condition}`);}
function registryCondition(){const line=workflowJobBlock("record-registry").find(x=>x.trim().startsWith("if:"));assert.ok(line);return line.trim().slice(3).trim();}
function registryEligible(condition:string,releaseSha:string,result:string){assert.equal(condition,"${{ always() && needs.identify.result == 'success' && needs.identify.outputs.release_sha != '' && (needs.registry-proof.result == 'success' || needs.registry-proof.result == 'failure') }}");return releaseSha!==""&&(result==="success"||result==="failure");}
function createIdentifyFixture(t:any,kind:"ordinary"|"candidate",durable:boolean){const root=mkdtempSync(join(tmpdir(),"slate-identify-")),repo=join(root,"repo"),remote=join(root,"remote.git"),bin=join(root,"bin");t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(repo);mkdirSync(bin);const env={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,HOME:root,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GITHUB_REPOSITORY:"JetBrains/ytdb-slate"};const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};spawnSync("git",["init","--bare",remote],{env,encoding:"utf8",timeout:10000});git(repo,"init","-b","main");git(repo,"config","user.name","Test");git(repo,"config","user.email","test@example.invalid");mkdirSync(join(repo,"verification"));cpSync(new URL("../verification/release-control.mjs",import.meta.url),join(repo,"verification/release-control.mjs"));writeFileSync(join(repo,"package.json"),'{"version":"0.10.0"}\n');writeFileSync(join(repo,"package-lock.json"),'{"version":"0.10.0","packages":{"":{"version":"0.10.0"}}}\n');git(repo,"add",".");git(repo,"commit","-m","base");const base=git(repo,"rev-parse","HEAD");let request:any=null;if(kind==="candidate"){request=makeRequest({version:"0.10.1",baseSha:base,notes,currentVersion:"0.10.0",authorization:"101"});mkdirSync(join(repo,"release/requests/0.10.1"),{recursive:true});writeFileSync(join(repo,"package.json"),'{"version":"0.10.1"}\n');writeFileSync(join(repo,"package-lock.json"),'{"version":"0.10.1","packages":{"":{"version":"0.10.1"}}}\n');writeFileSync(join(repo,"release/requests/0.10.1/request.json"),JSON.stringify(request));writeFileSync(join(repo,"release/requests/0.10.1/notes.md"),notes);writeFileSync(join(repo,"release/requests/0.10.1/coverage.json"),JSON.stringify({schema:2,parentPolicy:"exact-release-parent",allowedPaths:request.coverageDisposition.allowedPaths,verdict:"WARN"}));}else writeFileSync(join(repo,"ordinary"),"x\n");git(repo,"add",".");git(repo,"commit","-m",kind);const after=git(repo,"rev-parse","HEAD");git(repo,"remote","add","origin",remote);git(repo,"push","origin","HEAD:main");if(durable&&request){const state=join(root,"state");mkdirSync(state);git(state,"init","-b","release-state");git(state,"config","user.name","Test");git(state,"config","user.email","test@example.invalid");writeFileSync(join(state,"request.json"),JSON.stringify(request));git(state,"add",".");git(state,"commit","-m","state");git(state,"remote","add","origin",remote);git(state,"push","origin","HEAD:release-state");}writeFileSync(join(bin,"gh"),`#!/bin/sh\nprintf '[{"number":9,"merged_at":"2026-09-17T00:00:00Z","merge_commit_sha":"%s","base":{"ref":"main"}}]\\n' "$EXPECTED_SHA"\n`);chmodSync(join(bin,"gh"),0o755);return{root,repo,remote,env,base,after};}
function advanceIdentifyCorrection(f:any){
  const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,env:f.env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const firstBase=f.after,dir=join(f.repo,"release/requests/0.10.1"),correctedNotes="Corrected release notes\n";
  const first=makeRequest({version:"0.10.1",baseSha:firstBase,notes:correctedNotes,currentVersion:"0.10.1",authorization:"102"});
  writeFileSync(join(dir,"request.json"),JSON.stringify(first));writeFileSync(join(dir,"notes.md"),correctedNotes);
  writeFileSync(join(dir,"coverage.json"),JSON.stringify({schema:2,parentPolicy:"exact-release-parent",allowedPaths:first.coverageDisposition.allowedPaths,verdict:"WARN"}));
  git(f.repo,"add",".");git(f.repo,"commit","-m","first correction");const parent=git(f.repo,"rev-parse","HEAD");
  const second=makeRequest({version:"0.10.1",baseSha:parent,notes:correctedNotes,currentVersion:"0.10.1",authorization:"103"});
  writeFileSync(join(dir,"request.json"),JSON.stringify(second));git(f.repo,"add",".");git(f.repo,"commit","-m","second correction");
  git(f.repo,"push","origin","HEAD:main");const state=join(f.root,"state");writeFileSync(join(state,"request.json"),JSON.stringify(second));git(state,"add",".");git(state,"commit","-m","second owner");git(state,"push","origin","HEAD:release-state");
  return{...f,base:parent,after:git(f.repo,"rev-parse","HEAD"),request:join(dir,"request.json"),notes:correctedNotes};
}
function runIdentifyGate(f:any,candidateScript=workflowStepRunBlock("identify","candidate"),condition=identifyCheckout().condition){const output=join(f.root,"candidate-output");writeFileSync(output,"");const candidate=spawnSync("/bin/bash",["-c",candidateScript],{cwd:f.repo,env:{...f.env,BEFORE:f.base,AFTER:f.after,GITHUB_OUTPUT:output},encoding:"utf8",timeout:10000});if(candidate.status!==0)return{candidate,values:{},checkout:null,releaseCheckout:null,validation:null};const values=outputValues(output),eligible=candidateCondition(condition,values.release_sha??"");let checkout:any=null,releaseCheckout:any=null,validation:any=null;if(eligible){checkout=spawnSync("git",["clone","--branch",identifyCheckout().ref,f.remote,"durable"],{cwd:f.repo,env:f.env,encoding:"utf8",timeout:10000});if(checkout.status===0){releaseCheckout=spawnSync("git",["clone",f.remote,"release-code"],{cwd:f.repo,env:f.env,encoding:"utf8",timeout:10000});if(releaseCheckout.status===0)releaseCheckout=spawnSync("git",["-C","release-code","checkout","--detach",values.release_sha??""],{cwd:f.repo,env:f.env,encoding:"utf8",timeout:10000});if(releaseCheckout.status===0){const findOutput=join(f.root,"find-output");validation=spawnSync("/bin/bash",["-c",workflowStepRunBlock("identify","find")],{cwd:f.repo,env:{...f.env,RELEASE_SHA:values.release_sha,PARENT_SHA:values.parent_sha,VERSION:values.version,REQUEST:values.request_path,GH_TOKEN:"fixture",EXPECTED_SHA:values.release_sha,GITHUB_OUTPUT:findOutput},encoding:"utf8",timeout:10000});if(validation.status===0)Object.assign(values,outputValues(findOutput));}}}return{candidate,values,checkout,releaseCheckout,validation};}

test("identify reads the pushed range before durable state and validates a genuine candidate",t=>{const job=workflowJobBlock("identify"),candidateAt=job.findIndex(x=>x.trim()==="- id: candidate"),checkout=identifyCheckout(),findAt=job.findIndex(x=>x.trim()==="- id: find");assert.ok(candidateAt>=0&&candidateAt<checkout.index&&checkout.index<checkout.releaseCode&&checkout.releaseCode<findAt);const ordinary=createIdentifyFixture(t,"ordinary",false),ordinaryRun=runIdentifyGate(ordinary);assert.equal(ordinaryRun.candidate.status,0,ordinaryRun.candidate.stderr);assert.equal(ordinaryRun.values.release_sha,undefined);assert.equal(ordinaryRun.checkout,null);assert.match(ordinaryRun.candidate.stdout,/no release candidate/);const real=createIdentifyFixture(t,"candidate",true),realRun=runIdentifyGate(real);assert.equal(realRun.checkout?.status,0,realRun.checkout?.stderr);assert.equal(realRun.releaseCheckout?.status,0,realRun.releaseCheckout?.stderr);assert.equal(realRun.validation?.status,0,realRun.validation?.stderr);assert.equal(realRun.values.release_sha,real.after);assert.equal(realRun.values.pull_request,"9");assert.equal(realRun.values.identity?.length,64);});

test("two consecutive same-version corrections identify and pass the real roster WARN rule with only request.json changed",t=>{
  const identified=advanceIdentifyCorrection(createIdentifyFixture(t,"candidate",true));
  const diff=spawnSync("git",["diff","--name-only",`${identified.base}..${identified.after}`],{cwd:identified.repo,env:identified.env,encoding:"utf8"});
  assert.equal(diff.status,0,diff.stderr);assert.equal(diff.stdout.trim(),"release/requests/0.10.1/request.json");
  const gate=runIdentifyGate(identified);assert.equal(gate.candidate.status,0,gate.candidate.stderr);
  assert.equal(gate.validation?.status,0,gate.validation?.stderr);assert.equal(gate.values.release_sha,identified.after);
  const roster=createRosterFixture(t,false,true),run=runRoster(roster);
  assert.equal(run.status,0,run.stderr+run.stdout);
  assert.match(readFileSync(join(roster.evidence,"coverage-disposition.txt"),"utf8"),new RegExp(JSON.parse(readFileSync(roster.request,"utf8")).identity));
});

test("grouped pushes identify using the selected release commit's rule, not the pushed head's rule",t=>{
  const current=readFileSync(new URL("../verification/release-control.mjs",import.meta.url),"utf8");
  const old=current.replace("return paths.size===changedPaths.length&&paths.has", "return paths.size===changedPaths.length&&changedPaths.length===allowed.length&&paths.has");
  assert.notEqual(old,current);
  for(const releaseUsesOldRule of [true,false]){
    const f=createIdentifyFixture(t,"candidate",true),dir=join(f.repo,"release/requests/0.10.1");
    const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,env:f.env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    const correction=makeRequest({version:"0.10.1",baseSha:f.after,notes,currentVersion:"0.10.1",authorization:"102"});
    writeFileSync(join(dir,"coverage.json"),JSON.stringify({schema:2,parentPolicy:"exact-release-parent",allowedPaths:correction.coverageDisposition.allowedPaths,verdict:"WARN"}));
    if(releaseUsesOldRule)writeFileSync(join(f.repo,"verification/release-control.mjs"),old);
    git(f.repo,"add",".");git(f.repo,"commit","-m","set up correction policy");const parent=git(f.repo,"rev-parse","HEAD");
    const request=makeRequest({version:"0.10.1",baseSha:parent,notes,currentVersion:"0.10.1",authorization:"103"});
    writeFileSync(join(dir,"request.json"),JSON.stringify(request));git(f.repo,"add",".");git(f.repo,"commit","-m","request-only correction");const releaseSha=git(f.repo,"rev-parse","HEAD");
    writeFileSync(join(f.repo,"verification/release-control.mjs"),releaseUsesOldRule?current:old);
    git(f.repo,"add",".");git(f.repo,"commit","-m","newer rule in same push");const after=git(f.repo,"rev-parse","HEAD");
    git(f.repo,"push","origin","HEAD:main");const state=join(f.root,"state");writeFileSync(join(state,"request.json"),JSON.stringify(request));git(state,"add",".");git(state,"commit","-m","correction owner");git(state,"push","origin","HEAD:release-state");
    const result=runIdentifyGate({...f,base:parent,after});assert.equal(result.candidate.status,0,result.candidate.stderr);assert.equal(result.values.release_sha,releaseSha);assert.equal(result.releaseCheckout?.status,0,result.releaseCheckout?.stderr);
    if(releaseUsesOldRule){assert.notEqual(result.validation?.status,0,"release commit's older rule must refuse before claim");assert.match(result.validation?.stderr??"",/release diff violates/);assert.equal(result.values.identity,undefined);}
    else{assert.equal(result.validation?.status,0,result.validation?.stderr);assert.equal(result.values.identity,request.identity);}
  }
});

test("identify preserves a leading-space foreign path in the release diff",t=>{
  const f=createIdentifyFixture(t,"candidate",true),dir=join(f.repo,"release/requests/0.10.1"),foreign=join(f.repo," release/requests/0.10.1");
  const git=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,env:f.env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const request=makeRequest({version:"0.10.1",baseSha:f.after,notes,currentVersion:"0.10.1",authorization:"102"});
  writeFileSync(join(dir,"request.json"),JSON.stringify(request));writeFileSync(join(dir,"coverage.json"),JSON.stringify({schema:2,parentPolicy:"exact-release-parent",allowedPaths:request.coverageDisposition.allowedPaths,verdict:"WARN"}));
  mkdirSync(foreign,{recursive:true});writeFileSync(join(foreign,"notes.md"),notes);
  git(f.repo,"add",".");git(f.repo,"commit","-m","correction with leading-space path");const after=git(f.repo,"rev-parse","HEAD");git(f.repo,"push","origin","HEAD:main");
  const state=join(f.root,"state");writeFileSync(join(state,"request.json"),JSON.stringify(request));git(state,"add",".");git(state,"commit","-m","correction owner");git(state,"push","origin","HEAD:release-state");
  const result=runIdentifyGate({...f,base:f.after,after});assert.equal(result.values.release_sha,after,`${result.candidate.stderr} ${result.candidate.stdout}`);assert.notEqual(result.validation?.status,0,"foreign path must block identification before claim");assert.match(result.validation?.stderr??"",/release diff violates/);assert.equal(result.values.identity,undefined);
});

test("identify fails closed for a candidate without durable state and its guards reject mutations",t=>{const missing=createIdentifyFixture(t,"candidate",false),failed=runIdentifyGate(missing);assert.equal(failed.candidate.status,0,failed.candidate.stderr);assert.notEqual(failed.checkout?.status,0);assert.equal(failed.validation,null);const ordinary=createIdentifyFixture(t,"ordinary",false),unguarded=runIdentifyGate(ordinary,workflowStepRunBlock("identify","candidate"),"always()");assert.notEqual(unguarded.checkout?.status,0);const real=createIdentifyFixture(t,"candidate",true),source=workflowStepRunBlock("identify","candidate"),mutant=source.replace("^release/requests/.*/request.json$","^never-a-release-request$");assert.notEqual(mutant,source);const missed=runIdentifyGate(real,mutant);assert.equal(missed.values.release_sha,undefined);assert.equal(missed.validation,null);});

test("record-registry condition requires an identified release and a completed proof outcome",()=>{const condition=registryCondition();for(const releaseSha of["",B])for(const result of["success","failure","skipped","cancelled"])assert.equal(registryEligible(condition,releaseSha,result),releaseSha!==""&&(result==="success"||result==="failure"),`${releaseSha||"empty"}/${result}`);const mutant=condition.replace(" || needs.registry-proof.result == 'failure'","");assert.notEqual(mutant,condition);assert.throws(()=>registryEligible(mutant,B,"failure"));});

test("real registry-proof workflow block retries invalid metadata and stops at the first complete attempt",{timeout:15000},t=>{
  const state=uploaded(),source=renderWorkflowBlock(workflowRunBlock("registry-proof"),workflowValues(state)),f=registryProofFixture(t,state,"delayed");
  assert.ok(workflowJobBlock("registry-proof").includes("    timeout-minutes: 15"));
  const run=runWorkflowBlock(f,source);
  assert.equal(run.status,0,run.stderr);
  const packs=assertRegistryProofLog(run,f,[0,5,10,20,30],["metadata-failed","invalid-metadata","invalid-metadata","invalid-metadata","complete"],2);
  assert.match(run.stdout,/ytdb-slate-0\.10\.1\.tgz/);
  assert.deepEqual(packs,[`npm\tpack ytdb-slate@${state.version} --ignore-scripts --pack-destination registry --registry ${promotionRegistry}`]);
  const result=JSON.parse(readFileSync(join(f.root,"registry/result.json"),"utf8"));
  assert.equal(result.result,"verified");assert.equal(result.identity,state.identity);assert.equal(result.execution,state.uploadExecution);
  assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"upload-unknown");
});

test("real registry-proof workflow block leaves failed downloads and partial pack writes inconclusive",{timeout:30000},t=>{
  const state=uploaded(),source=renderWorkflowBlock(workflowRunBlock("registry-proof"),workflowValues(state));
  for(const scenario of ["download-fail","partial-pack"]){
    const f=registryProofFixture(t,state,scenario),run=runWorkflowBlock(f,source);
    assert.equal(run.status,1,`${scenario}: ${run.stderr}`);
    const packs=assertRegistryProofLog(run,f,[0,5,10,20,30,60,60,60,60],Array(9).fill("download-failed"));
    assert.equal(packs.length,9,scenario);
    const result=JSON.parse(readFileSync(join(f.root,"registry/result.json"),"utf8"));
    assert.equal(result.result,"inconclusive",scenario);assert.equal(result.upload,"unknown",scenario);
    assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"upload-unknown");
    if(scenario==="partial-pack")assert.equal(readFileSync(join(f.root,`registry/ytdb-slate-${state.version}.tgz`),"utf8"),"archive");
  }
});

test("real registry-proof workflow block clears a failed pack's archive before a later empty pack",{timeout:15000},t=>{
  const state=uploaded(),source=renderWorkflowBlock(workflowRunBlock("registry-proof"),workflowValues(state)),f=registryProofFixture(t,state,"stale-archive"),run=runWorkflowBlock(f,source);
  assert.equal(run.status,1,run.stderr);
  const packs=assertRegistryProofLog(run,f,[0,5,10,20,30,60,60,60,60],Array(9).fill("download-failed"));
  assert.equal(packs.length,9);
  assert.equal(JSON.parse(readFileSync(join(f.root,"registry/result.json"),"utf8")).result,"inconclusive");
  assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"upload-unknown");
  assert.equal(readFileSync(join(f.root,"registry/metadata.json"),"utf8").includes(state.version),true);
});

test("real registry-proof workflow block rejects a successful pack with no archive",{timeout:15000},t=>{
  const state=uploaded(),source=renderWorkflowBlock(workflowRunBlock("registry-proof"),workflowValues(state)),f=registryProofFixture(t,state,"no-archive"),run=runWorkflowBlock(f,source);
  assert.equal(run.status,1,run.stderr);
  const packs=assertRegistryProofLog(run,f,[0,5,10,20,30,60,60,60,60],Array(9).fill("download-failed"));
  assert.equal(packs.length,9);
  assert.equal(JSON.parse(readFileSync(join(f.root,"registry/result.json"),"utf8")).result,"inconclusive");
  assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"upload-unknown");
});

test("real registry-proof workflow block classifies a complete wrong-byte observation as mismatch",{timeout:15000},t=>{
  const state=uploaded(),source=renderWorkflowBlock(workflowRunBlock("registry-proof"),workflowValues(state)),f=registryProofFixture(t,state,"wrong-bytes"),run=runWorkflowBlock(f,source);
  assert.equal(run.status,0,run.stderr);
  assert.equal(assertRegistryProofLog(run,f,[0],["complete"]).length,1);
  assert.equal(JSON.parse(readFileSync(join(f.root,"registry/result.json"),"utf8")).result,"mismatch");
});

test("real record-registry workflow block records results and reports absent failure evidence",t=>{const state=uploaded(),values=workflowValues(state),source=renderWorkflowBlock(workflowRunBlock("record-registry"),values),bytes=Buffer.from("archive"),result=classifyRegistry(state,bytes,bytes,{version:state.version,integrity:hashBytes(bytes).integrity},owner(state)),success=workflowFixture(t,state);mkdirSync(join(success.root,"registry"));writeFileSync(join(success.root,"registry/result.json"),JSON.stringify(result));const recorded=runWorkflowBlock(success,source);assert.equal(recorded.status,0,recorded.stderr);assert.equal(JSON.parse(readFileSync(join(success.root,"state.json"),"utf8")).status,"published");const absent=workflowFixture(t,state),failed=runWorkflowBlock(absent,source);assert.notEqual(failed.status,0);assert.match(failed.stdout,/Registry observation is inconclusive\. Upload remains unknown\./);assert.equal(JSON.parse(readFileSync(join(absent.root,"state.json"),"utf8")).status,"upload-unknown");});

test("real seal-upload workflow block runs and requires identity at begin-upload",t=>{const state=claimed(),values=workflowValues(state),source=workflowRunBlock("seal-upload"),f=workflowFixture(t,state),result=runWorkflowBlock(f,renderWorkflowBlock(source,values),{GITHUB_RUN_ID:"17"});assert.equal(result.status,0,result.stderr);const sealed=JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8"));assert.equal(sealed.status,"upload-unknown");assert.equal(sealed.uploadExecution,"17:2");assert.match(readFileSync(f.effectLog,"utf8"),/push origin HEAD:release-state --force-with-lease=/);
const mutant=source.split("\n").map(line=>line.includes(" begin-upload ")?line.replace(" --identity '${{ needs.identify.outputs.identity }}'",""):line).join("\n");assert.notEqual(mutant,source);const mf=workflowFixture(t,state),failed=runWorkflowBlock(mf,renderWorkflowBlock(mutant,values),{GITHUB_RUN_ID:"17"});assert.notEqual(failed.status,0);assert.equal(JSON.parse(readFileSync(join(mf.root,"state/state.json"),"utf8")).status,"claimed");assert.doesNotMatch(readFileSync(mf.effectLog,"utf8"),/push origin/);});

test("real seal block resumes the owning run only before the first upload",t=>{
  const claim=claimed(),o=owner(claim),checking=advance(claim,"checking",o,NOW),readyState=advance(checking,"ready",o,NOW),script=renderWorkflowBlock(workflowRunBlock("seal-upload"),workflowValues(claim));
  for(const state of [checking,readyState]){
    const f=workflowFixture(t,state),run=runWorkflowBlock(f,script,{GITHUB_RUN_ID:"17"});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"upload-unknown");assert.match(readFileSync(f.effectLog,"utf8"),/push origin HEAD:release-state/);
    const foreign=workflowFixture(t,state),rejected=runWorkflowBlock(foreign,script,{GITHUB_RUN_ID:"18"});assert.notEqual(rejected.status,0);assert.doesNotMatch(readFileSync(foreign.effectLog,"utf8"),/push origin HEAD:release-state/);
  }
  const uploadedState=uploaded(),f=workflowFixture(t,uploadedState),replayed=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("seal-upload"),workflowValues(uploadedState)),{GITHUB_RUN_ID:"17"});assert.notEqual(replayed.status,0);assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).uploadExecution,"17:1");
});

test("real operator workflow blocks bind targets and permit intended progress",t=>{for(const [name,state,expectedStatus] of [["retire",claimed(),"retired"],["close",proved(),"closed-unpromoted"],["close",failedPublished(),"closed-unpromoted"]] as const){const script=workflowRunBlock(name);for(const [label,version,identity] of [["correct",state.version,state.identity],["wrong-version","0.10.2",state.identity],["wrong-identity",state.version,"f".repeat(64)]] as const){const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8"),result=runWorkflowBlock(f,script,{VERSION:version,IDENTITY:identity}),effects=readFileSync(f.effectLog,"utf8");if(label==="correct"){assert.equal(result.status,0,`${name}: ${result.stderr}`);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,expectedStatus);assert.match(effects,/push origin HEAD:release-state/);if(name==="retire")assert.match(effects,/commit -m Retire merged no-upload authorization/);}else{assert.notEqual(result.status,0,`${name} accepted ${label}`);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)|gh\t|npm\t/);}}}
const state=published(),script=workflowRunBlock("recover");for(const [label,version,identity] of [["correct",state.version,state.identity],["wrong-version","0.10.2",state.identity],["wrong-identity",state.version,"f".repeat(64)]] as const){const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8"),result=runWorkflowBlock(f,script,{VERSION:version,IDENTITY:identity}),effects=readFileSync(f.effectLog,"utf8");if(label==="correct"){assert.equal(result.status,0,result.stderr);assert.match(effects,/gh\trun rerun 17 --repo JetBrains\/ytdb-slate --failed/);assert.match(result.stdout,/failed jobs and their dependents/);assert.match(result.stdout,/Promotion and final records can run only after/);assert.doesNotMatch(result.stdout,/read-only installation proof|promotion remain disabled/i);}else{assert.notEqual(result.status,0);assert.doesNotMatch(effects,/gh\t|npm\t|git\t.*(?:add|commit|push)/);}assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);}const unknown=uploaded(),uf=workflowFixture(t,unknown),before=readFileSync(join(uf.root,"state.json"),"utf8"),retried=runWorkflowBlock(uf,script,{VERSION:unknown.version,IDENTITY:unknown.identity});assert.equal(retried.status,0,retried.stderr);assert.match(readFileSync(uf.effectLog,"utf8"),/gh\trun rerun 17 --repo JetBrains\/ytdb-slate --failed/);assert.match(retried.stdout,/failed jobs and their dependents/);assert.match(retried.stdout,/sealed upload authority rejects every upload rerun/);assert.match(retried.stdout,/Promotion and final records can run only after registry and installation proofs succeed/);assert.equal(readFileSync(join(uf.root,"state.json"),"utf8"),before);});

test("real abandonment validates every page before any effect and closes only open exact matches",t=>{
  const state=initialState(req(),NOW),branch=`release/v${state.version}-${state.identity.slice(0,12)}`;
  const exact={number:9,merged_at:null,state:"open",head:{ref:branch,repo:{full_name:"JetBrains/ytdb-slate"}},base:{ref:"main"}};
  const fork={...exact,number:10,head:{...exact.head,repo:{full_name:"fork/repo"}}};
  const otherBase={...exact,number:11,base:{ref:"other"}};
  const otherBranch={...exact,number:15,head:{...exact.head,ref:"release/unrelated"}};
  const closed={...exact,number:12,state:"closed"};
  const merged={...exact,number:13,merged_at:NOW,state:"closed"};
  const page=(...prs:any[])=>JSON.stringify(prs)+"\n";
  const target={repository:"JetBrains/ytdb-slate",branch};
  assert.deepEqual(abandonPullRequests(page(fork,otherBase,exact,closed),target),[9]);
  assert.deepEqual(abandonPullRequests(page()+page(exact,{...exact,number:14}),target),[9,14]);
  assert.throws(()=>abandonPullRequests(page(exact)+page(merged),target),/merged/);
  const job=workflowJobBlock("abandon").join("\n"),script=workflowRunBlock("abandon");
  assert.match(job,/ref: '\$\{\{ github.sha \}\}', path: current-control/);
  assert.match(script,/gh api --paginate "repos\/\$GITHUB_REPOSITORY\/pulls\?state=all&head=\$owner:\$branch&per_page=100" --jq 'tojson'/);
  assert.match(script,/from '.\/current-control\/verification\/release-control.mjs'/);
  const run=(payload:string,fail="0",source=script,currentControl?:string)=>{
    const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8");
    writeFileSync(join(f.root,"prs.jsonl"),payload);
    if(currentControl)writeFileSync(join(f.root,"current-control/verification/release-control.mjs"),currentControl);
    const result=runWorkflowBlock(f,source,{VERSION:state.version,IDENTITY:state.identity,GH_FAIL_PRS:fail,GH_EXPECT_PRS_QUERY:`repos/${target.repository}/pulls?state=all&head=JetBrains:${target.branch}&per_page=100`});
    return {f,before,result,effects:readFileSync(f.effectLog,"utf8"),after:readFileSync(join(f.root,"state.json"),"utf8")};
  };
  for(const [name,payload,closedNumbers] of [
    ["no match",page(),[]],
    ["fork only",page({...fork,merged_at:NOW,state:"closed"}),[]],
    ["wrong base",page({...otherBase,merged_at:NOW,state:"closed"}),[]],
    ["wrong branch",page(otherBranch),[]],
    ["exact plus fork",page(fork,exact,closed,otherBase,otherBranch),[9]],
    ["several unmerged",page(exact)+page({...exact,number:14},fork),[9,14]],
  ] as const){
    const r=run(payload);assert.equal(r.result.status,0,`${name}: ${r.result.stderr}`);
    assert.equal(JSON.parse(r.after).status,"abandoned");
    assert.deepEqual(r.effects.split("\n").filter(line=>line.startsWith("gh\tpr close ")).map(line=>Number(/pr close (\d+)/.exec(line)?.[1])),closedNumbers,name);
    assert.match(r.effects,/git\tpush origin HEAD:release-state --force-with-lease=/);
    assert.doesNotMatch(r.effects,/gh\tpr close (?:10|11|12|15)\b/);
  }
  for(const [name,mutant] of [
    ["wrong owner",script.replace("owner=${GITHUB_REPOSITORY%%/*}","owner=foreign-org")],
    ["wrong branch",script.replace('branch="release/v$VERSION-${identity:0:12}"','branch="release/v$VERSION"')],
  ] as const){
    assert.notEqual(mutant,script,`${name} mutation must change the workflow`);
    const r=run(page(merged),"0",mutant);
    assert.notEqual(r.result.status,0,name);
    assert.match(r.result.stderr,/unexpected preparation pull request query/,name);
    assert.equal(r.after,r.before,name);
    assert.doesNotMatch(r.effects,/gh\tpr close|git\tpush origin --delete|git\t(?:add|commit)|git\tpush origin HEAD:release-state/,name);
  }
  const refusals=[
    ["read error",page(exact),"1"],
    ["partial output with read error",page(exact),"2"],
    ["invalid first page","{\n","0"],
    ["invalid later page",page(exact)+"{\n","0"],
    ["malformed evidence on later page",page(exact)+page({...fork,head:{...fork.head,repo:null}}),"0"],
    ["unsafe pull request number",page({...exact,number:1.5}),"0"],
    ["merged on later page",page(exact)+page(merged),"0"],
    ["missing REST state",page({...exact,state:undefined}),"0"],
    ["missing fork REST state",page({...fork,state:undefined}),"0"],
  ] as const;
  const controlSource=readFileSync(new URL("../verification/release-control.mjs",import.meta.url),"utf8");
  const unguardedRead=script.replace(/ \|\| \{ echo 'Cannot read preparation pull requests\.' >&2; exit 2; \}/," || true");
  assert.notEqual(unguardedRead,script);
  for(const [name,payload,fail] of refusals){
    const guarded=run(payload,fail);assert.notEqual(guarded.result.status,0,name);
    assert.match(guarded.result.stderr,/./,name);
    assert.equal(guarded.after,guarded.before,name);
    assert.doesNotMatch(guarded.effects,/gh\tpr close|git\tpush origin --delete|git\t(?:add|commit)|git\tpush origin HEAD:release-state/,name);
    const guard=name.includes("REST state")? 'if(action==="abandonment"&&p.state!=="open"&&p.state!=="closed")throw new Error("prepared abandonment pull request evidence is malformed");':name==="merged on later page"?'if(matches.some(p=>p.merged_at!==null))throw new Error("Matching preparation pull request is merged. Use retire instead.");':null;
    const control=guard?controlSource.replace(guard,""):name.includes("invalid")?controlSource.replace('throw new Error(`prepared ${action} pull request evidence is malformed`);','return [];'):(name==="malformed evidence on later page"||name==="unsafe pull request number")?controlSource.replace('if(!p||!Number.isSafeInteger(p.number)||p.number<1||p.merged_at!==null&&!dated(p.merged_at)||typeof p.head?.ref!=="string"||typeof p.head?.repo?.full_name!=="string"||typeof p.base?.ref!=="string")throw new Error(`prepared ${action} pull request evidence is malformed`);','if(!p||!Number.isSafeInteger(p.number)||p.number<1||p.merged_at!==null&&!dated(p.merged_at)||typeof p.head?.ref!=="string"||typeof p.head?.repo?.full_name!=="string"||typeof p.base?.ref!=="string")return [];'):controlSource;
    if(fail==="0")assert.notEqual(control,controlSource,`${name} lacks a mutation`);
    const mutant=run(payload,fail,fail==="0"?script:unguardedRead,control);
    assert.equal(mutant.result.status,0,`${name} did not detect removal of its guard: ${mutant.result.stderr}`);
    assert.equal(JSON.parse(mutant.after).status,"abandoned");
  }
  for(const [name,version,identity] of [["wrong version","0.10.2",state.identity],["wrong identity",state.version,"f".repeat(64)]] as const){
    const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8"),result=runWorkflowBlock(f,script,{VERSION:version,IDENTITY:identity});
    assert.notEqual(result.status,0,name);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);
    assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/gh\t|git\t(?:add|commit|push)/);
  }
});

test("prepared retirement validates one merged pull request and preserves empty claim fields",t=>{
  const state=initialState(req(),NOW),branch=`release/v${state.version}-${state.identity.slice(0,12)}`,pr={number:9,merged_at:NOW,head:{ref:branch,repo:{full_name:"JetBrains/ytdb-slate"}},base:{ref:"main"}},pages=JSON.stringify([pr])+"\n";
  assert.equal(preparedMergeProof(pages,{repository:"JetBrains/ytdb-slate",branch}),true);assert.equal(preparedMergeProof(JSON.stringify([{...pr,merged_at:null}])+"\n"+pages,{repository:"JetBrains/ytdb-slate",branch}),true);assert.throws(()=>preparedMergeProof(JSON.stringify([{...pr,merged_at:"not-a-date"}])+"\n",{repository:"JetBrains/ytdb-slate",branch}),/malformed/);
  const target={identity:state.identity,version:state.version,releaseSha:null,releaseParent:null};
  const retired=retire(state,target,NOW,{merged:true});assert.equal(retired.status,"retired");assert.equal(retired.releaseSha,null);assert.equal(retired.releaseParent,null);assert.equal(retired.claimExecution,null);assert.equal(retired.pullRequest,null);
  assert.throws(()=>retire(state,target,NOW));assert.throws(()=>retire({...state,claimExecution:"17:1"},target,NOW,{merged:true}));
  assert.throws(()=>retire({...state,promotion:"unknown"},target,NOW,{merged:true}));
  for(const bad of ["", "garbage\n", "{}\n", JSON.stringify([{...pr,head:{...pr.head,repo:{full_name:"fork/repo"}}}])+"\n",JSON.stringify([{...pr,base:{ref:"other"}}])+"\n",JSON.stringify([{...pr,merged_at:null}])+"\n",JSON.stringify([pr,pr])+"\n",JSON.stringify([{...pr,head:{...pr.head,ref:"wrong"}}])+"\n"]){assert.throws(()=>preparedMergeProof(bad,{repository:"JetBrains/ytdb-slate",branch}),bad);}
  const script=workflowRunBlock("retire");assert.match(script,/--paginate/);assert.match(script,/--merged-proof true/);
  for(const [label,payload,fail] of [["merged",pages,"0"],["read error",pages,"1"],["malformed","{\n","0"],["zero","[]\n","0"],["multiple",JSON.stringify([pr,pr])+"\n","0"],["fork",JSON.stringify([{...pr,head:{...pr.head,repo:{full_name:"fork/repo"}}}])+"\n","0"],["wrong base",JSON.stringify([{...pr,base:{ref:"other"}}])+"\n","0"],["unmerged",JSON.stringify([{...pr,merged_at:null}])+"\n","0"]] as const){
    const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8");writeFileSync(join(f.root,"prs.jsonl"),payload);
    writeFileSync(join(f.root,"verification/release-control.mjs"),"throw Error('stored control cannot retire prepared');\n");
    const result=runWorkflowBlock(f,script,{VERSION:state.version,IDENTITY:state.identity,GH_FAIL_PRS:fail}),effects=readFileSync(f.effectLog,"utf8");
    if(label==="merged"){assert.equal(result.status,0,`${result.stderr} ${result.stdout}`);const after=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(after.status,"retired");assert.equal(after.releaseSha,null);assert.equal(after.claimExecution,null);assert.match(effects,/push origin HEAD:release-state --force-with-lease=/);}
    else{assert.notEqual(result.status,0,label);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)/);if(label==="read error")assert.equal(result.status,2);if(label==="unmerged")assert.match(result.stderr,/Use abandon/);}
  }
});

test("real claim block binds the identified identity before any state write and races with retirement",t=>{
  const request=req(),prepared=initialState(request,NOW),merged=claimed(request),retiredPrepared=retire(prepared,{identity:prepared.identity,version:prepared.version,releaseSha:null,releaseParent:null},NOW,{merged:true}),later=req("0.10.0",notes,"102"),newOwner=initialState(later,NOW);
  const script=workflowRunBlock("claim"),values={...workflowValues(merged),"needs.identify.outputs.pull_request":"9"};assert.match(workflowJobBlock("claim").join("\n"),/LAUNCH_IDENTITY: \$\{\{ needs\.identify\.outputs\.identity \}\}/);assert.match(script,/--identity "\$LAUNCH_IDENTITY"/);
  for(const [label,state,ok] of [["claim first",prepared,true],["repeat claim",merged,true],["retire first",retiredPrepared,false],["new preparation",newOwner,false]] as const){const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state/state.json"),"utf8");writeFileSync(join(f.root,"state/request.json"),JSON.stringify(state.identity===request.identity?request:later));const r=runWorkflowBlock(f,renderWorkflowBlock(script,values),{LAUNCH_IDENTITY:request.identity,GITHUB_RUN_ID:"17"}),effects=readFileSync(f.effectLog,"utf8");assert.equal(r.status===0,ok,`${label}: ${r.stderr}`);if(label==="claim first")assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"claimed");if(!ok){assert.equal(readFileSync(join(f.root,"state/state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)/);}}
  assert.equal(retire(merged,owner(merged),NOW).status,"retired");assert.throws(()=>claimRelease(retire(merged,owner(merged),NOW),{request,launchIdentity:request.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"17",runAttempt:"1"},NOW));
});

test("claim shell refuses a replacement owner even when selected release control ignores launch identity",t=>{
  const old=readFileSync(new URL("./fixtures/release-control-no-launch-identity.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(old,/launchIdentity/);
  const launch=req(),replacement=req("0.10.0",notes,"102"),state=initialState(replacement,NOW),script=workflowRunBlock("claim"),values={...workflowValues(claimed(launch)),"needs.identify.outputs.pull_request":"9"};
  const run=(source:string)=>{const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state/state.json"),"utf8");writeFileSync(join(f.root,"state/request.json"),JSON.stringify(replacement));writeFileSync(join(f.root,"control/verification/release-control.mjs"),old);const result=runWorkflowBlock(f,renderWorkflowBlock(source,values),{LAUNCH_IDENTITY:launch.identity});return{f,before,result,effects:readFileSync(f.effectLog,"utf8")};};
  const guarded=run(script);assert.equal(guarded.result.status,2,guarded.result.stderr);assert.match(guarded.result.stderr,/Launch identity does not match the durable owner/);assert.equal(readFileSync(join(guarded.f.root,"state/state.json"),"utf8"),guarded.before);assert.doesNotMatch(guarded.effects,/git\t.*(?:add|commit|push)/);
  const mutant=script.split("\n").filter(line=>!line.startsWith("durable_identity=")&&!line.includes("Claim refused.")).join("\n");assert.notEqual(mutant,script);const unguarded=run(mutant);assert.equal(unguarded.result.status,0,unguarded.result.stderr);assert.equal(JSON.parse(readFileSync(join(unguarded.f.root,"state/state.json"),"utf8")).status,"claimed");assert.match(unguarded.effects,/git\t.*push origin HEAD:release-state/);
});

test("release-state history rejects ended identity after another preparation and refuses unreadable records",()=>{
  const first=req(),a=initialState(first,NOW),retired=retire(a,{identity:a.identity,version:a.version,releaseSha:null,releaseParent:null},NOW,{merged:true}),second=req("0.10.0",notes,"102"),b=initialState(second,NOW),ended=abandon(b,{identity:b.identity,version:b.version,releaseSha:null,releaseParent:null},false,NOW);
  assert.doesNotThrow(()=>assertNoEndedIdentity([a],first.identity));assert.doesNotThrow(()=>assertNoEndedIdentity([ended,b,retired,a],req("0.10.0",notes,"103").identity));assert.throws(()=>assertNoEndedIdentity([ended,b,retired,a],first.identity),/already ended/);assert.throws(()=>claimRelease(ended,{request:first,launchIdentity:first.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"17",runAttempt:"1"},NOW));assert.throws(()=>assertNoEndedIdentity([],first.identity),/empty/);assert.throws(()=>assertNoEndedIdentity([ended,{...a,status:"broken"}],first.identity),/unknown release status/);
});

test("preparation history reads a closed not-attempted release without reviving its identity",()=>{const s=proved(),o=owner(s),intent=beginPromotion(s,"0.10.0",o,"17","1",NOW),recorded=recordPromotion(intent,{identity:s.identity,releaseSha:s.releaseSha,execution:"17:1",result:"not-attempted",cause:"missing-token"},o,NOW),closed=closeWithoutPromotion(recorded,o,NOW);assert.equal(validateState(closed).promotion,"not-attempted");assert.throws(()=>assertNoEndedIdentity([closed],closed.identity),/already ended/);assert.doesNotThrow(()=>assertNoEndedIdentity([closed],"f".repeat(64)));});

test("real retire workflow accepts the stored 0.11.0 record only after its own evidence reads",t=>{const state=validateState(structuredClone(storedUnknownState)),script=workflowRunBlock("retire"),run={id:35824449849,run_attempt:1,status:"completed"},job={id:17,name:"upload",run_id:run.id,run_attempt:1,status:"completed",conclusion:"failure",completed_at:new Date(Date.now()-2*3600000).toISOString()},doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}};assert.match(workflowJobBlock("retire").join("\n"),/permissions: \{ contents: write, actions: read, pull-requests: read \}/);assert.match(workflowJobBlock("retire").join("\n"),/ref: '\$\{\{ github.sha \}\}', path: current-control/);assert.match(script,/npm view ytdb-slate versions time --json --cache "\$root\/npm-cache"/);for(const [label,mutate] of [["absent",()=>{}],["package E404",(_r:any,_j:any,_d:any,f:any)=>{f.fail="1";}],["version E404",(_r:any,_j:any,_d:any,f:any)=>{f.fail="2";}],["network error",(_r:any,_j:any,_d:any,f:any)=>{f.fail="3";}],["npm valid JSON with nonzero exit",(_r:any,_j:any,_d:any,f:any)=>{f.fail="4";}],["GitHub run error",(_r:any,_j:any,_d:any,f:any)=>{f.ghRun="1";}],["GitHub run valid JSON with nonzero exit",(_r:any,_j:any,_d:any,f:any)=>{f.ghRun="2";}],["GitHub jobs error",(_r:any,_j:any,_d:any,f:any)=>{f.ghJobs="1";}],["GitHub jobs valid JSON with nonzero exit",(_r:any,_j:any,_d:any,f:any)=>{f.ghJobs="2";}],["malformed JSON",(_r:any,_j:any,d:any)=>{d.bad="{";}],["time missing",(_r:any,_j:any,d:any)=>{delete d.time;}],["partial publication times",(_r:any,_j:any,d:any)=>{d.versions.push("0.10.1");}],["degenerate date",(_r:any,_j:any,d:any)=>{d.time["0.10.0"]="0";}],["malformed version member",(_r:any,_j:any,d:any)=>{d.versions.push(42);d.time[42]=NOW;}],["modified missing",(_r:any,_j:any,d:any)=>{delete d.time.modified;}],["earlier versions missing",(_r:any,_j:any,d:any)=>{d.versions=[];}],["time only",(_r:any,_j:any,d:any)=>{d.time[state.version]=NOW;}],["version present",(_r:any,_j:any,d:any)=>{d.versions.push(state.version);}],["upload success",(_r:any,j:any)=>{j.conclusion="success";}],["run in progress",(r:any)=>{r.status="in_progress";}],["settle interval",(_r:any,j:any)=>{j.completed_at=new Date(Date.now()-10*60000).toISOString();}],["job list incomplete",(_r:any,_j:any,_d:any,f:any)=>{f.total=2;}]] as const){const r:any=structuredClone(run),j:any=structuredClone(job),d:any=structuredClone(doc),flags:any={};mutate(r,j,d,flags);const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8");writeFileSync(join(f.root,"verification/release-control.mjs"),"console.error('stored release-state control cannot retire an unknown upload');process.exitCode=2;\n");writeFileSync(join(f.root,"run.json"),JSON.stringify(r));writeFileSync(join(f.root,"jobs.json"),JSON.stringify({total_count:flags.total??1,jobs:[j]}));writeFileSync(join(f.root,"package.json"),d.bad??JSON.stringify(d));const result=runWorkflowBlock(f,script,{VERSION:state.version,IDENTITY:state.identity,NPM_FAIL:flags.fail??"0",GH_FAIL_RUN:flags.ghRun??"0",GH_FAIL_JOBS:flags.ghJobs??"0"}),effects=readFileSync(f.effectLog,"utf8");if(label==="absent"){assert.equal(result.status,0,`${result.stderr} ${result.stdout}`);const after=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(after.status,"retired");assert.equal(after.upload,"observed-absent");assert.deepEqual(after.artifact,state.artifact);assert.match(effects,/push origin HEAD:release-state --force-with-lease=/);assert.match(effects,/commit -m Retire observed-absent upload/);}else{assert.notEqual(result.status,0,`${label} was accepted`);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)/);assert.match(result.stderr,/.+/);}}const f=workflowFixture(t,state),wrong=runWorkflowBlock(f,script,{VERSION:state.version,IDENTITY:"f".repeat(64)});assert.notEqual(wrong.status,0);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/gh\t|npm\t|git\t.*(?:add|commit|push)/);});

test("real prepare workflow uses the control script's final statuses for lane ownership",{timeout:180000},t=>{
  const script=workflowRunBlock("prepare"),claim=claimed(),unknown=uploaded(),publication=published(),proof=proved();
  const promotion=beginPromotion(proof,"0.10.0",owner(proof),"17","1",NOW);
  const promoted=recordPromotion(promotion,{identity:promotion.identity,releaseSha:promotion.releaseSha,execution:"17:1",result:"verified",before:"0.10.0",after:promotion.version},owner(promotion),NOW);
  const mismatch=recordRegistry(unknown,classifyRegistry(unknown,Buffer.from("archive"),Buffer.from("other"),{version:unknown.version,integrity:hashBytes(Buffer.from("archive")).integrity},owner(unknown)),owner(unknown),NOW);
  const first=initialState(req(),NOW);
  const states:Record<string,any>={prepared:first,claimed:claim,checking:advance(claim,"checking",owner(claim),NOW),ready:ready(),"upload-unknown":unknown,published:publication,proved:proof,"promotion-unknown":promotion,promoted,complete:advance(promoted,"complete",owner(promoted),NOW),abandoned:abandon(first,{identity:first.identity,version:first.version,releaseSha:null,releaseParent:null},false,NOW),retired:retire(claim,owner(claim),NOW),mismatch,"closed-unpromoted":closeWithoutPromotion(proof,owner(proof),NOW)};
  assert.match(script,/generationRecord/);
  assert.deepEqual(Object.keys(states).sort(),[...STATUSES].sort());
  for(const status of STATUSES){
    const old=validateState(states[status]),f=workflowFixture(t,old);
    assert.equal(old.status,status);
    writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"0.11.0",versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}}));
    writeFileSync(join(f.root,"package-lock.json"),JSON.stringify({version:"0.11.0",packages:{"":{version:"0.11.0"}}}));
    writeFileSync(join(f.root,"bin/git"),`#!/bin/sh\nprintf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in\n  "ls-remote --exit-code --heads origin release-state") exit 0;;\n  "ls-remote --exit-code --heads origin "*) exit 2;;\n  "rev-parse HEAD") printf '${C}\\n'; exit 0;;\n  "rev-parse origin/release-state") printf '${A}\\n'; exit 0;;\n  "rev-list ${A}") printf '${A}\\n'; exit 0;;
  "show ${A}:state.json") cat "$HOME/state.json"; exit 0;;
  "show ${A}:request.json") cat "$HOME/request.json"; exit 0;;\n  "commit-tree "*) cat >/dev/null; printf '${B}\\n'; exit 0;;\nesac\nexit 0\n`);
    const result=runWorkflowBlock(f,script,{VERSION:"0.10.1",NOTES:"Release notes",STATE_BRANCH:"release-state"}),effects=readFileSync(f.effectLog,"utf8");
    assert.notEqual(old.identity,makeRequest({version:"0.10.1",baseSha:C,notes:"Release notes\n",currentVersion:"0.11.0",authorization:"900"}).identity,status);
    if(TERMINAL.includes(status)){
      assert.equal(result.status,0,`${status}: ${result.stderr} ${result.stdout}`);
      assert.match(effects,/git\tpush origin .*refs\/heads\/release-state/,status);
    }else{
      assert.notEqual(result.status,0,`${status} took the lane`);
      assert.match(result.stderr,/unfinished release 0\.10\.1 already owns the lane/,status);
      assert.doesNotMatch(effects,/git\t(?:add|commit|push)/,status);
    }
  }
});

test("real preparation blocks resurrection at the leased history snapshot and refuses a failed history read",{timeout:180000},t=>{
  const a=makeRequest({version:"0.10.1",baseSha:C,notes:"Release notes\n",currentVersion:"0.11.0",authorization:"900"}),b=makeRequest({version:"0.10.1",baseSha:C,notes:"Release notes\n",currentVersion:"0.11.0",authorization:"901"}),preparedA=initialState(a,NOW),retiredA=retire(preparedA,{identity:a.identity,version:a.version,releaseSha:null,releaseParent:null},NOW,{merged:true}),preparedB=initialState(b,NOW),endedB=abandon(preparedB,{identity:b.identity,version:b.version,releaseSha:null,releaseParent:null},false,NOW),f=workflowFixture(t,retiredA),script=workflowRunBlock("prepare");
  writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"0.11.0",versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}}));
  writeFileSync(join(f.root,"package-lock.json"),'{"version":"0.11.0","packages":{"":{"version":"0.11.0"}}}');
  for(const [sha,state] of [["a",retiredA],["b",preparedB],["c",endedB],["d",preparedA]] as const){writeFileSync(join(f.root,`${sha}.json`),JSON.stringify(state));writeFileSync(join(f.root,`${sha}-request.json`),JSON.stringify(state.identity===a.identity?a:b));}
  writeFileSync(join(f.root,"bin/git"),`#!/bin/sh
printf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"
case "$*" in
  "rev-parse HEAD") printf '${C}\\n';;
  "ls-remote --exit-code --heads origin release-state") exit 0;;
  "ls-remote --exit-code --heads origin "*) exit 2;;
  "rev-parse origin/release-state") printf '%s\\n' "$HISTORY_HEAD";;
  "rev-list "*) test "${'${HISTORY_FAIL:-0}'}" = 0 || exit 1; case "$HISTORY_HEAD" in a) printf 'a\\nd\\n';; b) printf 'b\\na\\nd\\n';; c) printf 'c\\nb\\na\\nd\\n';; esac;;
  "show "*) sha="${'${2%%:*}'}"; case "$2" in *:request.json) cat "$HOME/$sha-request.json";; *) cat "$HOME/$sha.json";; esac;;
  "commit-tree "*) cat >/dev/null; printf '${B}\\n';;
esac
exit 0
`);
  const noChange=(effects:string)=>assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)/);
  const resume=runWorkflowBlock(f,script,{VERSION:a.version,NOTES:"Release notes",STATE_BRANCH:"release-state",GITHUB_RUN_ID:"901",HISTORY_HEAD:"b"});assert.equal(resume.status,0,resume.stderr+resume.stdout);assert.match(resume.stdout,/Continuing idempotently/);
  writeFileSync(f.effectLog,"");const newRun=runWorkflowBlock(f,script,{VERSION:a.version,NOTES:"Release notes",STATE_BRANCH:"release-state",GITHUB_RUN_ID:"901",HISTORY_HEAD:"a"});assert.equal(newRun.status,0,newRun.stderr+newRun.stdout);assert.match(readFileSync(f.effectLog,"utf8"),/push origin .*refs\/heads\/release-state.*force-with-lease=refs\/heads\/release-state:a/);
  writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"0.11.0",versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}}));writeFileSync(f.effectLog,"");const revived=runWorkflowBlock(f,script,{VERSION:a.version,NOTES:"Release notes",STATE_BRANCH:"release-state",GITHUB_RUN_ID:"900",HISTORY_HEAD:"c"});assert.notEqual(revived.status,0,`${revived.stderr} ${revived.stdout} ${readFileSync(f.effectLog,"utf8")}`);assert.match(revived.stderr,/already ended/);noChange(readFileSync(f.effectLog,"utf8"));
  writeFileSync(f.effectLog,"");const failedRead=runWorkflowBlock(f,script,{VERSION:a.version,NOTES:"Release notes",STATE_BRANCH:"release-state",GITHUB_RUN_ID:"902",HISTORY_HEAD:"c",HISTORY_FAIL:"1"});assert.notEqual(failedRead.status,0);noChange(readFileSync(f.effectLog,"utf8"));
  writeFileSync(join(f.root,"a.json"),"{bad json");writeFileSync(f.effectLog,"");const malformed=runWorkflowBlock(f,script,{VERSION:a.version,NOTES:"Release notes",STATE_BRANCH:"release-state",GITHUB_RUN_ID:"902",HISTORY_HEAD:"c"});assert.notEqual(malformed.status,0);noChange(readFileSync(f.effectLog,"utf8"));
});

test("prepare refuses unreadable state and prepared-branch probes before any push",t=>{
  const request=makeRequest({version:"0.10.1",baseSha:C,notes,currentVersion:"0.11.0",authorization:"900"}),state=initialState(request,NOW);
  for(const probe of ["release-state","prepared"]){
    const f=workflowFixture(t,state);writeFileSync(join(f.root,"request.json"),JSON.stringify(request));writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"0.11.0",versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}}));
    writeFileSync(join(f.root,"bin/git"),`#!/bin/sh
printf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"
case "$*" in
  "rev-parse HEAD") printf '${C}\\n';;
  "ls-remote --exit-code --heads origin release/0.10") exit 2;;
  "ls-remote --exit-code --heads origin release-state") if test "$PROBE" = release-state; then exit 128; else exit 0; fi;;
  "ls-remote --exit-code --heads origin "*) exit 128;;
  "rev-parse origin/release-state") printf '${A}\\n';;
  "rev-list ${A}") printf '${A}\\n';;
  "show ${A}:state.json") cat "$HOME/state.json";;
  "show ${A}:request.json") cat "$HOME/request.json";;
esac
exit 0
`);
    const before=readFileSync(join(f.root,"state/state.json"),"utf8"),result=runWorkflowBlock(f,workflowRunBlock("prepare"),{VERSION:request.version,NOTES:"Release notes",STATE_BRANCH:"release-state",PROBE:probe}),effects=readFileSync(f.effectLog,"utf8");
    assert.equal(result.status,2,`${probe}: ${result.stderr} ${result.stdout}`);assert.match(result.stderr,probe==="release-state"?/release-state branch could not be read/:/prepared branch could not be read/);assert.equal(readFileSync(join(f.root,"state/state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*push origin/);
    if(probe==="prepared")assert.match(result.stdout,/Continuing idempotently/);
  }
});

test("real prepare workflow refuses a version listed only in npm time or a failed package read",t=>{const script=workflowRunBlock("prepare");assert.match(script,/npm view ytdb-slate versions time --json --cache/);for(const failed of [false,true]){const f=workflowFixture(t,retire(claimed(),owner(claimed()),NOW)),doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW,"0.10.1":NOW}};writeFileSync(join(f.root,"package.json"),JSON.stringify(doc));writeFileSync(join(f.root,"bin/git"),`#!/bin/sh\ncase "$*" in "rev-parse HEAD") printf '${C}\\n';; "ls-remote --exit-code --heads origin release/0.10"|"ls-remote --exit-code --heads origin release-state") exit 2;; esac\nexit 0\n`);const result=runWorkflowBlock(f,script,{VERSION:"0.10.1",NOTES:"Release notes",STATE_BRANCH:"release-state",NPM_FAIL:failed?"1":"0"});assert.notEqual(result.status,0);assert.match(result.stderr,failed?/Cannot read the full npm package document/:/must exceed every npm version/);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\t.*(?:add|commit|push)/);}});

test("preparation refuses a successful-looking npm body with a nonzero read status",t=>{
  const f=workflowFixture(t,retire(claimed(),owner(claimed()),NOW)),doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}};
  writeFileSync(join(f.root,"package.json"),JSON.stringify(doc));
  writeFileSync(join(f.root,"bin/git"),`#!/bin/sh\ncase "$*" in "rev-parse HEAD") printf '${C}\\n';; "ls-remote --exit-code --heads origin release/0.10"|"ls-remote --exit-code --heads origin release-state") exit 2;; esac\nexit 0\n`);
  const result=runWorkflowBlock(f,workflowRunBlock("prepare"),{VERSION:"0.10.1",NOTES:"Release notes",NPM_FAIL:"4",STATE_BRANCH:"release-state"});
  assert.notEqual(result.status,0);
  assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\t(?:config|add|commit|push)/);
  assert.match(result.stderr,/Cannot read the full npm package document/);
});

test("real install failure workflow records the producing attempt and closes without success effects",t=>{const pub=published(),values=workflowValues(pub),install=renderWorkflowBlock(workflowRunBlock("install-proof"),values),f=workflowFixture(t,pub),failed=runWorkflowBlock(f,install);assert.notEqual(failed.status,0);const failurePath=join(f.root,"runner/install/failure.json"),failure=JSON.parse(readFileSync(failurePath,"utf8"));assert.equal(failure.execution,"900:2");assert.equal(failure.result,"failed");mkdirSync(join(f.root,"failure"));cpSync(failurePath,join(f.root,"failure/failure.json"));const recorded=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("record-install-failure"),values));assert.equal(recorded.status,0,recorded.stderr);const state=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(state.status,"published");assert.equal(state.installFailures[0].execution,"900:2");assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag|git\ttag|gh\trelease create/);const closed=runWorkflowBlock(f,workflowRunBlock("close"),{VERSION:state.version,IDENTITY:state.identity});assert.equal(closed.status,0,closed.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"closed-unpromoted");});

const oidcWorkflowEnv={ACTIONS_ID_TOKEN_REQUEST_URL:"https://github.example/token",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"fixture-request-token"};
function assertCredentialSecrecy(run:any,result:any){
  const maskLines=run.stdout.split("\n").filter((line:string)=>line.startsWith("::add-mask::"));
  assert.ok(maskLines.every((line:string)=>["::add-mask::fixture-id-token","::add-mask::fixture-npm-token"].includes(line)));
  const visible=run.stdout.split("\n").filter((line:string)=>!line.startsWith("::add-mask::")).join("\n");
  for(const [channel,text] of [["stdout",visible],["stderr",run.stderr],["result",JSON.stringify(result)]])assert.doesNotMatch(text,/fixture-(?:request|id|npm)-token/,`${channel} must contain no credential text`);
}
function assertPromotionAuthority(source:string){
  const jobs=[...source.matchAll(/^  ([a-z][a-z-]*):\n([\s\S]*?)(?=^  [a-z][a-z-]*:|$(?![\s\S]))/gm)].map(match=>({name:match[1]!,body:match[2]!}));
  assert.doesNotMatch(source,/NPM_STAGE_ONLY_TOKEN|secrets\./);
  assert.doesNotMatch(source.slice(0,source.indexOf("\njobs:")),/id-token:/,"no workflow-wide OIDC authority");
  assert.deepEqual(jobs.filter(job=>/id-token: write/.test(job.body)).map(job=>job.name).sort(),["promote","recover-promote","upload"]);
  assert.deepEqual(jobs.filter(job=>/environment: npm-release\b/.test(job.body)).map(job=>job.name),["upload"]);
  assert.deepEqual(jobs.filter(job=>/environment: npm-promote\b/.test(job.body)).map(job=>job.name).sort(),["promote","recover-promote"]);
  for(const name of ["promote","recover-promote"]){
    const body=jobs.find(job=>job.name===name)?.body;assert.ok(body);
    assert.match(body,/permissions: \{ contents: read, id-token: write \}/);
    assert.doesNotMatch(body,/registry-url:|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|npm (ci|install|test|pack)/);
  }
}

test("stored executor recognition uses the OIDC exchange path in every rule copy",()=>{
  const path="/-/npm/v1/oidc/token/exchange/",current=readFileSync(new URL("../verification/release-job.mjs",import.meta.url),"utf8");
  assert.ok(current.includes(path));assert.ok(!legacyPromotionJob.includes(path));
  assert.ok(current.includes("NODE_AUTH_TOKEN"));assert.ok(legacyPromotionJob.includes("NODE_AUTH_TOKEN"));
  for(const text of [releasing,agents,mechanism]){
    assert.ok(text.includes(`Do not rerun a preparation or claim run whose stored executor lacks \`${path}\`.`));
    assert.ok(text.includes(`The stored executor uses OIDC only when it contains \`${path}\`. An executor without that path uses the stored-token route.`));
  }
});

test("promotion workflow authority checks reject each regression",()=>{
  assertPromotionAuthority(workflow);
  for(const name of ["promote","recover-promote"]){
    const block=workflowJobBlock(name).join("\n");
    for(const [from,to] of [["id-token: write","id-token: read"],["environment: npm-promote","environment: npm-release"],["node-version: '24.18.0'","node-version: '24.18.0', registry-url: 'https://registry.npmjs.org'"],["steps:","steps:\n      - env: { NODE_AUTH_TOKEN: '${{ secrets.OTHER_NPM_TOKEN }}' }"],["steps:","steps:\n      - run: npm install -g npm@11.21.0"]]){
      const mutant=workflow.replace(block,()=>block.replace(from!,to!));assert.notEqual(mutant,workflow);assert.throws(()=>assertPromotionAuthority(mutant));
    }
  }
  for(const name of ["recover","install-proof","finalize"]){
    const block=workflowJobBlock(name).join("\n"),mutant=workflow.replace(block,()=>block.replace("permissions: {","permissions: { id-token: write,"));
    assert.notEqual(mutant,workflow);assert.throws(()=>assertPromotionAuthority(mutant));
  }
  const upload=workflowJobBlock("upload").join("\n");
  for(const [from,to] of [["id-token: write","id-token: read"],["environment: npm-release","environment: npm-promote"]]){
    const mutant=workflow.replace(upload,()=>upload.replace(from!,to!));assert.notEqual(mutant,workflow);assert.throws(()=>assertPromotionAuthority(mutant));
  }
});

test("real promotion steps and recorders retry only with a new intent",{timeout:30000},t=>{
  const values=(job:string,s:any)=>Object.fromEntries(Object.entries(workflowValues(s)).map(([k,v])=>[job.startsWith("recover")?k.replace("needs.identify.","needs.recover."):k,v]));
  const promote=(job:string,s:any)=>{const line=workflowJobBlock(job).join("\n").match(/^\s*run: (node verification\/release-job\.mjs promote[^\n]*)$/m)?.[1];assert.ok(line);return renderWorkflowBlock(line,values(job,s));};
  const recorder=(job:string,s:any)=>renderWorkflowBlock(workflowRunBlock(job),values(job,s));
  for(const job of ["promote","recover-promote"]){
    const steps=workflowJobBlock(job).join("\n").split(/^      - /m);
    const step=steps.filter(x=>/^\s*run: node verification\/release-job\.mjs promote\b/m.test(x));
    assert.equal(step.length,1,`${job} must have one promotion step`);
    assert.doesNotMatch(step[0]!,/secrets\.|NODE_AUTH_TOKEN/,`${job} must not bind a token secret`);
    assertPromotionAuthority(workflow);
  }
  for(const scenario of ["missing-token","refused"]){
    const proof=proved(),intent=beginPromotion(proof,"0.10.0",owner(proof),"900","2",NOW),f=workflowFixture(t,intent);
    const first=runWorkflowBlock(f,promote("promote",intent),{...(scenario==="missing-token"?{}:oidcWorkflowEnv),NPM_READ_FAIL_FIRST:"0",NPM_WRITE_FAIL:scenario==="refused"?"1":"0"}),result=JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8"));
    assert.equal(first.status,0,first.stderr);assert.equal(result.result,scenario==="refused"?"refused":"not-attempted",`${scenario}: ${readFileSync(f.effectLog,"utf8")} read-count=${scenario==="missing-token"?"none":readFileSync(join(f.root,"read-count"),"utf8")}`);if(scenario!=="refused")assert.equal(result.cause,"missing-token");assert.deepEqual(first.stdout.split("\n").filter(line=>line.startsWith("::error::")),["::error::Promotion is not verified. Inspect the saved result before recovery."]);assert.doesNotMatch(JSON.stringify(result)+first.stdout,/PRIVATE REGISTRY RESPONSE/);
    assertCredentialSecrecy(first,result);
    assert.equal((readFileSync(f.effectLog,"utf8").match(/oidc\tPUT/g)??[]).length,scenario==="refused"?1:0);
    assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add/);assert.equal(readFileSync(join(f.root,"latest"),"utf8"),"0.10.0\n");
    const absent=runWorkflowBlock(f,recorder("record-promotion",intent),{GITHUB_RUN_ATTEMPT:"3"});assert.notEqual(absent.status,0);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"promotion-unknown");
    assert.notEqual(runWorkflowBlock(f,promote("promote",intent),{GITHUB_RUN_ATTEMPT:"3",...oidcWorkflowEnv}).status,0);
    mkdirSync(join(f.root,"promotion"));cpSync(join(f.root,"runner/promotion.json"),join(f.root,"promotion/promotion.json"));const saved=runWorkflowBlock(f,recorder("record-promotion",intent),{GITHUB_RUN_ATTEMPT:"3"});assert.equal(saved.status,0,saved.stderr);const resolved=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(resolved.status,"proved");assert.equal(resolved.promotion,result.result);assert.equal(resolved.promotionEvidence.expectedLatest,"0.10.0");
    const finalize=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("finalize"),workflowValues(intent)));assert.notEqual(finalize.status,0);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\ttag|gh\trelease create/);
    const retry=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:resolved.version,IDENTITY:resolved.identity,GITHUB_RUN_ATTEMPT:"3"});assert.equal(retry.status,0,retry.stderr);assert.match(readFileSync(join(f.root,"output"),"utf8"),/retry_promotion=true/);const newIntent=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(newIntent.promoterExecution,"900:3");assert.equal(newIntent.promotionEvidence.expectedLatest,"0.10.0");
    const again=runWorkflowBlock(f,promote("recover-promote",newIntent),{GITHUB_RUN_ATTEMPT:"3"});assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8")).cause,"missing-token");assert.deepEqual(again.stdout.split("\n").filter(line=>line.startsWith("::error::")),["::error::Promotion is not verified. Inspect the saved result before recovery."]);assert.equal(readFileSync(join(f.root,"latest"),"utf8"),"0.10.0\n");
    const second=runWorkflowBlock(f,promote("recover-promote",newIntent),{GITHUB_RUN_ATTEMPT:"3",...oidcWorkflowEnv});assert.equal(second.status,0,second.stderr);const secondResult=JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8"));assert.equal(secondResult.result,"verified");assertCredentialSecrecy(second,secondResult);assert.equal(readFileSync(join(f.root,"latest"),"utf8"),`${newIntent.version}\n`);
    cpSync(join(f.root,"runner/promotion.json"),join(f.root,"promotion/promotion.json"));const recorded=runWorkflowBlock(f,recorder("recover-promotion-record",newIntent),{GITHUB_RUN_ATTEMPT:"4"});assert.equal(recorded.status,0,recorded.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"complete");assert.equal((readFileSync(f.effectLog,"utf8").match(/oidc\tPUT/g)??[]).length,scenario==="refused"?2:1);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add/);
  }
});

test("recover observes superseding selections and retries an unchanged unknown outcome",{timeout:10000},t=>{
  const proof=proved(),intent=beginPromotion(proof,"0.10.0",owner(proof),"900","2",NOW),base={identity:intent.identity,releaseSha:intent.releaseSha,execution:"900:2"};
  for(const result of [{...base,result:"not-attempted",cause:"missing-token"},{...base,result:"refused",before:"0.10.0",after:"0.10.0",errorCode:"E403"}]){
    const s=recordPromotion(intent,result,owner(intent),NOW),f=workflowFixture(t,s);writeFileSync(join(f.root,"latest"),"0.9.0\n");
    const r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:s.version,IDENTITY:s.identity,GITHUB_RUN_ATTEMPT:"3"});assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).promotion,"superseded");assert.match(r.stdout,/::error::/);
    assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add|git\ttag|gh\trelease create/);
  }
  const f=workflowFixture(t,intent),r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:intent.version,IDENTITY:intent.identity,GITHUB_RUN_ATTEMPT:"3"});assert.equal(r.status,0,r.stderr);
  const retried=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(retried.promotion,"unknown");assert.equal(retried.promoterExecution,"900:3");assert.equal(retried.promotionEvidence.expectedLatest,"0.10.0");
  assert.match(readFileSync(join(f.root,"output"),"utf8"),/retry_promotion=true/);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add/);
});

test("real promoter observes failed writes and leaves other failed reads unresolved",{timeout:10000},t=>{
  const s=proved(),intent=beginPromotion(s,"0.10.0",owner(s),"900","2",NOW),line=workflowJobBlock("promote").join("\n").match(/^\s*run: (node verification\/release-job\.mjs promote[^\n]*)$/m)?.[1];assert.ok(line);
  const script=renderWorkflowBlock(line,workflowValues(intent));
  for(const [name,flags] of [["write",{NPM_WRITE_FAIL:"2"}],["applied failed write",{NPM_WRITE_FAIL:"3"}],["failed refusal read",{NPM_WRITE_FAIL:"1",NPM_READ_FAIL_SECOND:"1"}],["guard read",{NPM_READ_FAIL_FIRST:"1"}],["second read",{NPM_READ_FAIL_SECOND:"1"}]] as const){
    const f=workflowFixture(t,intent),r=runWorkflowBlock(f,script,{...oidcWorkflowEnv,...flags});
    assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"promotion-unknown");
    assert.equal((readFileSync(f.effectLog,"utf8").match(/oidc\tPUT/g)??[]).length,name==="guard read"?0:1);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add/);
    if(["write","applied failed write","failed refusal read"].includes(name)){
      assert.equal(r.status,0,r.stderr);const result=JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8"));
      assert.equal(result.result,name==="applied failed write"?"verified":"refused");assert.equal(result.errorCode,name==="write"?"unknown":name==="failed refusal read"?"E403":undefined);
      assert.equal(Object.hasOwn(result,"after"),name!=="failed refusal read");if(name!=="failed refusal read")assert.equal(result.after,name==="applied failed write"?intent.version:"0.10.0");
      assert.equal(r.stdout.includes("::error::"),name!=="applied failed write");assert.doesNotMatch(JSON.stringify(result)+r.stdout,/UNKNOWN npm failure|PRIVATE/);assertCredentialSecrecy(r,result);
      mkdirSync(join(f.root,"promotion"));cpSync(join(f.root,"runner/promotion.json"),join(f.root,"promotion/promotion.json"));
      const recorded=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("record-promotion"),workflowValues(intent)));assert.equal(recorded.status,0,recorded.stderr);
      const state=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(state.promotion,result.result);if(name==="applied failed write")assert.throws(()=>closeWithoutPromotion(state,owner(state),NOW));
    }
    else{assert.notEqual(r.status,0);assert.match(r.stderr,/latest read failed/);assert.throws(()=>readFileSync(join(f.root,"runner/promotion.json"),"utf8"),/ENOENT/);}
  }
});

test("production install effect writes durable failure evidence and permits a later success",t=>{const pub=published(),root=mkdtempSync(join(tmpdir(),"slate-install-failure-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const failureOut=join(root,"failure.json");assert.throws(()=>executeInstall({state:pub,expected:owner(pub),runId:"17",runAttempt:"2",workspace:root,out:join(root,"proof.json"),failureOut,exec:()=>{throw new Error("offline install failed");}}));const failure=JSON.parse(readFileSync(failureOut,"utf8"));assert.deepEqual({execution:failure.execution,result:failure.result,failure:failure.failure},{execution:"17:2",result:"failed",failure:"install-command"});const recorded=recordInstallFailure(pub,failure,owner(pub),NOW);let n=0;const proof=executeInstall({state:recorded,expected:owner(recorded),runId:"17",runAttempt:"3",workspace:root,out:join(root,"proof.json"),failureOut:join(root,"later-failure.json"),exec:()=>++n===2?{stdout:'{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate","sourceInfo":{"source":"npm:ytdb-slate@0.10.1"}}]}}\n'}:{stdout:""}});const success=recordInstallProof(recorded,proof,owner(recorded),NOW);assert.equal(success.status,"proved");assert.equal(success.installFailures.length,1);assert.equal(success.installProof.execution,"17:3");});

test("production workflow carries immutable identity through every stage and confines OIDC authority",()=>{const job=(name:string)=>workflow.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z-]*:\\n|$)`))?.[0]??"";for(const name of["seal-upload","upload","record-registry","install-proof","record-install-failure","record-proof","promote","record-promotion","finalize"])assert.match(job(name),/--identity/);assert.match(job("registry-proof"),/expected=\{identity:/);for(const name of["recover","recover-promote","recover-promotion-record","abandon","retire","close"])assert.match(job(name),/IDENTITY|--identity/);assert.match(job("prepare"),/--authorization "\$GITHUB_RUN_ID"/);assert.match(job("prepare"),/generationRecord/);assert.match(job("record-install-failure"),/if: \$\{\{ always\(\) && needs\.identify\.result == 'success' && needs\.install-proof\.result == 'failure'/);assertPromotionAuthority(workflow);assert.match(job("upload"),/environment: npm-release[\s\S]*id-token: write/);assert.doesNotMatch(job("promote"),/npm (ci|install|test|pack)/);for(const text of[releasing,agents,mechanism]){assert.match(text,/install-failure-<attempt>/);assert.match(text,/install-failures\//);assert.match(text,/record-install-failure/);}for(const text of [releasing,agents,mechanism]){assert.match(text,/started before pull request #439 merged/);assert.doesNotMatch(text,/started before this fix/);}assert.match(releasing,/Do not rerun only `record-install-failure`/);assert.match(releasing,/If installation fails again, the failure recorder uses the same new run attempt\./);assert.match(releasing,/If installation succeeds, the failure recorder is skipped\./);assert.match(releasing,/The release can continue only after the required proofs succeed\./);assert.match(releasing,/dependent jobs can promote `latest` and create final records/);});

test("competing durable writers reject a stale compare-and-swap lease",t=>{const root=mkdtempSync(join(tmpdir(),"slate-cas-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const env={PATH:process.env.PATH??"",HOME:root,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"};const run=(cwd:string,...args:string[])=>{const r=spawnSync("git",args,{cwd,env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};const remote=join(root,"remote.git"),seed=join(root,"seed");run(root,"init","--bare",remote);mkdirSync(seed);run(seed,"init","-b","main");run(seed,"config","user.name","Test");run(seed,"config","user.email","test@example.invalid");writeFileSync(join(seed,"state"),"one");run(seed,"add","state");run(seed,"commit","-m","seed");run(seed,"remote","add","origin",remote);run(seed,"push","origin","HEAD:release-state");const a=join(root,"a"),b=join(root,"b");run(root,"clone","--branch","release-state",remote,a);run(root,"clone","--branch","release-state",remote,b);for(const d of [a,b]){run(d,"config","user.name","Test");run(d,"config","user.email","test@example.invalid");}const old=run(a,"rev-parse","HEAD");writeFileSync(join(a,"state"),"a");run(a,"commit","-am","a");run(a,"push","origin","HEAD:release-state",`--force-with-lease=refs/heads/release-state:${old}`);writeFileSync(join(b,"state"),"b");run(b,"commit","-am","b");const stale=spawnSync("git",["push","origin","HEAD:release-state",`--force-with-lease=refs/heads/release-state:${old}`],{cwd:b,env,encoding:"utf8",timeout:10000});assert.notEqual(stale.status,0);});

test("exclusive records cannot replace existing evidence",()=>{const root=mkdtempSync(join(tmpdir(),"slate-record-")),path=join(root,"x.json");try{writeExclusive(path,{a:1});assert.throws(()=>writeExclusive(path,{a:2}),/refusing to replace/);assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),{a:1});}finally{rmSync(root,{recursive:true,force:true});}});

function createRosterFixture(t:any,extraPath=false,correction=false){
  const root=mkdtempSync(join(tmpdir(),"slate-roster-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const repo=join(root,"repo"),bin=join(root,"bin"),evidence=join(root,"evidence");mkdirSync(join(repo,"verification"),{recursive:true});mkdirSync(bin);cpSync(new URL("../verification/release-checks.sh",import.meta.url),join(repo,"verification/release-checks.sh"));chmodSync(join(repo,"verification/release-checks.sh"),0o755);cpSync(new URL("../verification/release-control.mjs",import.meta.url),join(repo,"verification/release-control.mjs"));
  const realNode=process.execPath,log=join(root,"fake.log");
  writeFileSync(join(bin,"npm"),`#!/bin/sh\necho "npm $*" >>"$FAKE_LOG"\nif [ "$1 $2" = "test --" ]; then [ "${'${NO_VERDICT:-0}'}" = 1 ] || echo 'RUN VERDICT: WARN — fixture'; fi\nexit 0\n`);
  writeFileSync(join(bin,"bash"),`#!/bin/sh\necho "bash $*" >>"$FAKE_LOG"\ncase "$*" in *"${'${FAKE_FAIL:-__none__}'}"*) exit 7;; esac\ncase "$1" in -c) echo '{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate"}]}}';; esac\nexit 0\n`);
  writeFileSync(join(bin,"node"),`#!/bin/sh\necho "node $*" >>"$FAKE_LOG"\ncase "$1" in -e|-p|--input-type=module) exec ${realNode} "$@";; *) exit 0;; esac\n`);for(const f of ["npm","bash","node"])chmodSync(join(bin,f),0o755);
  const env={PATH:`${bin}:${process.env.PATH??""}`,HOME:root,FAKE_LOG:log,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}; const git=(...a:string[])=>{const r=spawnSync("git",a,{cwd:repo,env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  spawnSync("git",["init","-b","main",repo],{env,encoding:"utf8"});git("config","user.name","Test");git("config","user.email","test@example.invalid");writeFileSync(join(repo,"package.json"),'{"version":"0.10.0"}\n');writeFileSync(join(repo,"package-lock.json"),'{"version":"0.10.0","packages":{"":{"version":"0.10.0"}}}\n');git("add",".");git("commit","-m","base");const base=git("rev-parse","HEAD");const r=req();mkdirSync(join(repo,"release/requests/0.10.1"),{recursive:true});writeFileSync(join(repo,"package.json"),'{"version":"0.10.1"}\n');writeFileSync(join(repo,"package-lock.json"),'{"version":"0.10.1","packages":{"":{"version":"0.10.1"}}}\n');writeFileSync(join(repo,"release/requests/0.10.1/request.json"),JSON.stringify(r));writeFileSync(join(repo,"release/requests/0.10.1/notes.md"),notes);writeFileSync(join(repo,"release/requests/0.10.1/coverage.json"),JSON.stringify({schema:2,parentPolicy:"exact-release-parent",allowedPaths:r.coverageDisposition.allowedPaths,verdict:"WARN"}));if(extraPath)writeFileSync(join(repo,"extra"),"x");git("add",".");git("commit","-m","release");let parent=base;
  if(correction){const dir=join(repo,"release/requests/0.10.1"),firstBase=git("rev-parse","HEAD"),correctedNotes="Corrected release notes\n",first=makeRequest({version:"0.10.1",baseSha:firstBase,notes:correctedNotes,currentVersion:"0.10.1",authorization:"102"});writeFileSync(join(dir,"request.json"),JSON.stringify(first));writeFileSync(join(dir,"notes.md"),correctedNotes);writeFileSync(join(dir,"coverage.json"),JSON.stringify({schema:2,parentPolicy:"exact-release-parent",allowedPaths:first.coverageDisposition.allowedPaths,verdict:"WARN"}));git("add",".");git("commit","-m","first correction");parent=git("rev-parse","HEAD");const second=makeRequest({version:"0.10.1",baseSha:parent,notes:correctedNotes,currentVersion:"0.10.1",authorization:"103"});writeFileSync(join(dir,"request.json"),JSON.stringify(second));git("add",".");git("commit","-m","second correction");}
  return{root,repo,evidence,base:parent,request:join(repo,"release/requests/0.10.1/request.json"),env};
}
function runRoster(f:any,more:any={}){return spawnSync("/bin/bash",["verification/release-checks.sh","--repo",f.repo,"--base",f.base,"--request",f.request,"--evidence",f.evidence],{cwd:f.repo,env:{...f.env,...more},encoding:"utf8",timeout:30000});}

test("real release roster executes every command in order with strict flags and reviewed WARN",t=>{const f=createRosterFixture(t);const r=runRoster(f);assert.equal(r.status,0,r.stderr+r.stdout);const commands=readFileSync(join(f.evidence,"commands.tsv"),"utf8");assert.match(commands,/^typecheck\tnpm run typecheck/m);assert.match(commands,/resolver.*--strict/);assert.match(commands,/ladder.*--strict/);assert.equal(commands.trim().split("\n").length,14);assert.match(readFileSync(join(f.evidence,"coverage-disposition.txt"),"utf8"),new RegExp(req().identity));});

test("real release roster propagates command failure and rejects missing verdict or foreign WARN paths",t=>{let f=createRosterFixture(t);let r=runRoster(f,{FAKE_FAIL:"run-resolver-checks"});assert.equal(r.status,7);f=createRosterFixture(t);r=runRoster(f,{NO_VERDICT:"1"});assert.equal(r.status,2);f=createRosterFixture(t,true);r=runRoster(f);assert.equal(r.status,2);});

test("real WARN roster refuses forbidden paths for both request sets",t=>{
  const requestPath="release/requests/0.10.1/request.json";
  const cases=[
    {name:"five without package.json",correction:false,paths:["package-lock.json",requestPath]},
    {name:"five without package-lock.json",correction:false,paths:["package.json",requestPath]},
    {name:"five without request.json",correction:false,paths:["package.json","package-lock.json"]},
    {name:"five with empty diff",correction:false,paths:[]},
    {name:"three without request.json",correction:true,paths:["release/requests/0.10.1/notes.md"]},
    {name:"three with foreign path",correction:true,paths:[requestPath,"foreign"]},
  ];
  for(const entry of cases){
    const f=createRosterFixture(t,false,entry.correction),git=(...a:string[])=>{const r=spawnSync("git",a,{cwd:f.repo,env:f.env,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    const parent=git("rev-parse","HEAD");
    for(const path of entry.paths){if(path==="foreign")writeFileSync(join(f.repo,path),"foreign\n");else writeFileSync(join(f.repo,path),readFileSync(join(f.repo,path),"utf8")+"\n");}
    git("add",".");git("commit","--allow-empty","-m",entry.name);
    const result=runRoster({...f,base:parent});assert.equal(result.status,2,`${entry.name}: ${result.stderr} ${result.stdout}`);assert.match(result.stderr,/coverage WARN paths violate/);
  }
});

test("real WARN roster sees both sides when a forbidden source is renamed to request.json",t=>{
  const f=createRosterFixture(t,false,true),requestPath="release/requests/0.10.1/request.json";
  const git=(...args:string[])=>{const r=spawnSync("git",args,{cwd:f.repo,env:f.env,encoding:"utf8",timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git("mv",requestPath,"foreign.json");git("commit","-m","foreign source in parent");const parent=git("rev-parse","HEAD");
  git("mv","foreign.json",requestPath);git("commit","-m","restore via rename");
  assert.equal(git("diff","--name-only",`${parent}..HEAD`),requestPath,"default rename detection collapses the forbidden source");
  assert.deepEqual(git("diff","--no-renames","--name-only",`${parent}..HEAD`).split("\n"),["foreign.json",requestPath]);
  const result=runRoster({...f,base:parent});assert.equal(result.status,2,result.stderr+result.stdout);assert.match(result.stderr,/coverage WARN paths violate/);
});

test("real WARN roster accepts the required five-path subset",t=>{
  const f=createRosterFixture(t),git=(...a:string[])=>{const r=spawnSync("git",a,{cwd:f.repo,env:f.env,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const parent=git("rev-parse","HEAD");for(const path of ["package.json","package-lock.json","release/requests/0.10.1/request.json"])writeFileSync(join(f.repo,path),readFileSync(join(f.repo,path),"utf8")+"\n");
  git("add",".");git("commit","-m","required paths");const r=runRoster({...f,base:parent});assert.equal(r.status,0,r.stderr+r.stdout);
});

test("roster production contract names the real typecheck command",()=>{const source=readFileSync(new URL("../verification/release-checks.sh",import.meta.url),"utf8");assert.match(source,/^run typecheck npm run typecheck$/m);});

const branchRequest=(authorization="900")=>makeRequest({version:"0.10.1",baseSha:A,notes,currentVersion:"0.10.0",authorization,target:"release/0.10"});
const branchPr=(r:any,overrides:any={})=>({number:9,merged_at:NOW,state:"closed",head:{ref:`release/v${r.version}-${r.identity.slice(0,12)}`,repo:{full_name:"JetBrains/ytdb-slate"}},base:{ref:"release/0.10"},merge_commit_sha:B,...overrides});

test("bound target format, version line, order, and generation are independent guards",()=>{
  const r=branchRequest(),legacy=req(),state=initialState(r,NOW),doc={versions:["0.9.0","0.10.0"],time:{created:NOW,modified:NOW,"0.9.0":NOW,"0.10.0":NOW}};
  assert.equal(r.schema,3);assert.equal(requestTarget(r),"release/0.10");assert.equal(requestTarget(legacy),"main");assert.notEqual(r.identity,legacy.identity);
  assert.throws(()=>makeRequest({version:r.version,baseSha:A,notes,currentVersion:"0.10.0",authorization:"900",target:"release/0.11"}),/target/);
  assert.throws(()=>verifyReleaseIdentity({...identity(r),coverageRecord:{...identity(r).coverageRecord,schema:3},associatedPullRequests:[{number:9,merged:true,mergeCommitSha:B,baseRefName:"main"}]}),/merged pull request/);
  assert.throws(()=>verifyReleaseIdentity({...identity(),pushedBranch:"release/0.10"}),/pushed branch/);
  assert.equal(compareVersions("0.10.11","0.10.9"),1);assert.equal(compareVersions("1.0.0","0.99.999"),1);assert.equal(assertNewerVersion(doc,"0.10.1"),true);
  for(const blocked of ["0.10.0","0.9.9"])assert.throws(()=>assertNewerVersion(doc,blocked),/exceed/);
  assert.throws(()=>assertNewerVersion({...doc,time:{...doc.time,"0.11.0":NOW}},"0.10.1"),/exceed/);
  assert.throws(()=>assertNewerVersion({error:{code:"E404"}},"0.10.1"));
  assert.equal(generationRecord([{state,request:r}],"900").identity,r.identity);
  assert.throws(()=>generationRecord([{state,request:r},{state:initialState(branchRequest("900"),NOW),request:{...r,baseSha:C}}],"900"));
  assert.throws(()=>generationRecord([{state:retire(state,{identity:r.identity,version:r.version,releaseSha:null,releaseParent:null},NOW,{merged:true}),request:r}],"900"),/already ended/);
  assert.equal(generationRecord([{state,request:r}],"901"),null);
});

test("release-branch pull request matching validates every page and the bound target",()=>{
  const r=branchRequest(),p=branchPr(r),pages=JSON.stringify([])+"\n"+JSON.stringify([p])+"\n",target={repository:"JetBrains/ytdb-slate",branch:p.head.ref,target:"release/0.10"};
  assert.equal(publishCandidate(pages,r).releaseSha,B);
  assert.equal(preparedMergeProof(pages,target),true);
  assert.deepEqual(abandonPullRequests(JSON.stringify([{...p,merged_at:null,state:"open"}])+"\n",target),[9]);
  for(const bad of [JSON.stringify([p])+"\n{",JSON.stringify([p])+"\n"+JSON.stringify([p]),JSON.stringify([{...p,base:{ref:"main"}}]),JSON.stringify([{...p,head:{...p.head,repo:{full_name:"fork/ytdb-slate"}}}])])assert.throws(()=>publishCandidate(bad,r));
  const s=initialState(r,NOW),admit={state:s,request:r,version:r.version,identity:r.identity,runId:"900",pages,firstParentShas:[C,B,A],releaseSha:B,parentSha:A};
  assert.equal(publishAdmission(admit).pullRequest,9);
  for(const wrong of [{...admit,firstParentShas:[C,A]},{...admit,identity:"f".repeat(64)},{...admit,request:req()},{...admit,pages:JSON.stringify([branchPr(r,{base:{ref:"main"}})])}])assert.throws(()=>publishAdmission(wrong));
  const claimedState=claimRelease(s,{request:r,launchIdentity:r.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"900",runAttempt:"1"},NOW);
  assert.equal(publishAdmission({...admit,state:claimedState,pages:undefined,firstParentShas:undefined}).continuation,true);
  assert.throws(()=>publishAdmission({...admit,state:claimedState,runId:"901"}),/owning/);
  assert.throws(()=>claimRelease(claimedState,{request:r,launchIdentity:r.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"901",runAttempt:"1"},NOW),/another workflow run/);
  assert.deepEqual(claimRelease(claimedState,{request:r,launchIdentity:r.identity,releaseSha:B,parentSha:A,pullRequest:9,runId:"900",runAttempt:"2"},NOW),claimedState);
  const next=advance(advance(claimedState,"checking",owner(claimedState),NOW),"ready",owner(claimedState),NOW),artifact={file:"package.tgz",...hashBytes(Buffer.from("archive"))};
  assert.throws(()=>beginUpload(next,artifact,owner(next),"901","1",NOW),/owned/);
  const sealed=beginUpload(next,artifact,owner(next),"900","1",NOW);
  assert.throws(()=>authorizeUpload({...sealed,claimExecution:"901:1"},owner(sealed),"900","1"),/sealed/);
});

function publishWorkflowFixture(t:any){
  const r=branchRequest(),s=initialState(r,NOW),f=workflowFixture(t,s);
  mkdirSync(join(f.root,"durable/verification"),{recursive:true});
  cpSync(new URL("../verification/release-control.mjs",import.meta.url),join(f.root,"durable/verification/release-control.mjs"));
  writeFileSync(join(f.root,"durable/request.json"),JSON.stringify(r));writeFileSync(join(f.root,"durable/state.json"),JSON.stringify(s));
  writeFileSync(join(f.root,"state/request.json"),JSON.stringify(r));mkdirSync(join(f.root,"state/verification"),{recursive:true});cpSync(new URL("../verification/release-control.mjs",import.meta.url),join(f.root,"state/verification/release-control.mjs"));
  writeFileSync(join(f.root,"prs.jsonl"),JSON.stringify([])+"\n"+JSON.stringify([branchPr(r)])+"\n");
  const path=`release/requests/${r.version}`;
  writeFileSync(join(f.root,"candidate-request.json"),JSON.stringify(r));writeFileSync(join(f.root,"candidate-notes.md"),notes);
  writeFileSync(join(f.root,"candidate-coverage.json"),JSON.stringify({schema:3,parentPolicy:"exact-release-parent",allowedPaths:r.coverageDisposition.allowedPaths,verdict:"WARN"}));
  writeFileSync(join(f.root,"candidate-package.json"),JSON.stringify({version:r.version}));
  writeFileSync(join(f.root,"bin/git"),`#!/bin/sh
printf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"
case "$*" in
  "ls-remote --exit-code --heads origin release/0.10") printf '${B}\\trefs/heads/release/0.10\\n';;
  "rev-list --first-parent ${B}") printf '${C}\\n${B}\\n${A}\\n';;
  "rev-parse ${B}^1") printf '${A}\\n';;
  "show ${B}:${path}/request.json") cat "$HOME/candidate-request.json";;
  "show ${B}:${path}/notes.md") cat "$HOME/candidate-notes.md";;
  "show ${B}:${path}/coverage.json") cat "$HOME/candidate-coverage.json";;
  "show ${B}:package.json") cat "$HOME/candidate-package.json";;
  "diff-tree "*|"diff --no-renames --name-only -z ${A}..${B}") printf 'package.json\\0package-lock.json\\0${path}/coverage.json\\0${path}/notes.md\\0${path}/request.json\\0';;
  "rev-parse HEAD") printf '${C}\\n';;
esac
exit 0
`);
  return{...f,r,s};
}

test("real publish and claim workflow blocks admit a paginated merge and reject a second run",t=>{
  const f=publishWorkflowFixture(t),script=workflowStepRunBlock("identify","publish");
  const run=(more:any={})=>runWorkflowBlock(f,script,{VERSION:f.r.version,IDENTITY:f.r.identity,...more});
  const accepted=run();assert.equal(accepted.status,0,accepted.stderr);
  const output=outputValues(f.env.GITHUB_OUTPUT);assert.equal(output.release_sha,B);assert.equal(output.parent_sha,A);assert.equal(output.pull_request,"9");assert.equal(output.identity,f.r.identity);
  assert.match(readFileSync(f.effectLog,"utf8"),/gh\tapi --paginate/);
  const values={...workflowValues({...f.s,releaseSha:B,releaseParent:A}),"needs.identify.outputs.pull_request":"9"};
  const claimScript=renderWorkflowBlock(workflowRunBlock("claim"),values);
  const first=runWorkflowBlock(f,claimScript,{LAUNCH_IDENTITY:f.r.identity});assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).claimExecution,"900:2");
  writeFileSync(f.effectLog,"");const duplicate=runWorkflowBlock(f,claimScript,{LAUNCH_IDENTITY:f.r.identity,GITHUB_RUN_ID:"901"});assert.notEqual(duplicate.status,0);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/push origin/);
  const same=runWorkflowBlock(f,claimScript,{LAUNCH_IDENTITY:f.r.identity,GITHUB_RUN_ATTEMPT:"3"});assert.equal(same.status,0,same.stderr);
  writeFileSync(join(f.root,"durable/state.json"),readFileSync(join(f.root,"state/state.json")));
  writeFileSync(f.effectLog,"");const continuation=run({GITHUB_RUN_ATTEMPT:"3"});assert.equal(continuation.status,0,continuation.stderr);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/gh\tapi|git\t/);
  const foreign=run({GITHUB_RUN_ID:"901"});assert.notEqual(foreign.status,0);
});

test("real publish workflow rejects missing and forged pull request evidence before claim",t=>{
  for(const payload of ["{\n",JSON.stringify([])+"\n",JSON.stringify([branchPr(branchRequest(),{base:{ref:"main"}})])+"\n",JSON.stringify([branchPr(branchRequest())])+"\n"+JSON.stringify([branchPr(branchRequest(),{number:10})])+"\n"]){
    const f=publishWorkflowFixture(t);writeFileSync(join(f.root,"prs.jsonl"),payload);
    const result=runWorkflowBlock(f,workflowStepRunBlock("identify","publish"),{VERSION:f.r.version,IDENTITY:f.r.identity});assert.notEqual(result.status,0);
    assert.equal(JSON.parse(readFileSync(join(f.root,"durable/state.json"),"utf8")).status,"prepared");
    assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/push origin/);
  }
});

test("stored control validates both report artifacts and exact changed paths",t=>{
  const f=publishWorkflowFixture(t),report=join(f.root,"reports"),request=f.r;
  for(const node of ["22.23.1","24.18.0"]){const dir=join(report,`release-check-evidence-${node}`);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"roster.txt"),`ROSTER COMPLETE head=${B} base=${A} mode=report\n`);writeFileSync(join(dir,"commands.tsv"),["typecheck","packaging","packaging-self","load","resolver","tests","ladder","package-content","package-content-self","writing","writing-scaling","writing-reminder","worker-reminder","isolated-load"].map(x=>`${x}\tcommand\n`).join(""));writeFileSync(join(dir,"coverage-verdict.txt"),"RUN VERDICT: WARN — fixture\n");writeFileSync(join(dir,"tests.log"),"RUN VERDICT: WARN — fixture\n");}
  const allowed=request.coverageDisposition.allowedPaths,options={root:report,parentSha:A,releaseSha:B,request,changedPaths:allowed};
  assert.match(verifyCoverageEvidence(options),new RegExp(request.identity));
  assert.throws(()=>verifyCoverageEvidence({...options,changedPaths:[...allowed,"extension/index.ts"]}),/coverage WARN/);
  const second=join(report,"release-check-evidence-24.18.0");writeFileSync(join(second,"coverage-verdict.txt"),"RUN VERDICT: PASS — forged\n");assert.throws(()=>verifyCoverageEvidence(options),/malformed/);
  writeFileSync(join(second,"coverage-verdict.txt"),"RUN VERDICT: WARN — fixture\n");writeFileSync(join(second,"roster.txt"),`ROSTER COMPLETE head=${C} base=${A} mode=report\n`);assert.throws(()=>verifyCoverageEvidence(options),/bind/);
  const source=workflowJobBlock("coverage-disposition").join("\n");assert.match(source,/state\/verification\/release-control.mjs coverage-report/);for(const name of ["checks","pack","install-proof"]){const job=workflowJobBlock(name).join("\n");assert.match(job,/package-manager-cache: false/);assert.doesNotMatch(job,/cache: npm/);}
  writeFileSync(join(second,"roster.txt"),`ROSTER COMPLETE head=${B} base=${A} mode=report\n`);
  const script=renderWorkflowBlock(workflowRunBlock("coverage-disposition"),workflowValues({...f.s,releaseSha:B,releaseParent:A}));
  const accepted=runWorkflowBlock(f,script);assert.equal(accepted.status,0,accepted.stderr);assert.match(readFileSync(join(f.root,"coverage-disposition.txt"),"utf8"),new RegExp(request.identity));
  writeFileSync(join(second,"tests.log"),"RUN VERDICT: PASS — forged\n");const refused=runWorkflowBlock(f,script);assert.notEqual(refused.status,0);
});

test("real preparation binds an existing release branch and refuses moved heads or a repeated unrecorded attempt",t=>{
  const root=mkdtempSync(join(tmpdir(),"slate-branch-prepare-")),repo=join(root,"repo"),remote=join(root,"remote.git"),bin=join(root,"bin");t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(repo);mkdirSync(bin);
  const env={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,HOME:root,TMPDIR:root,STATE_BRANCH:"release-state",REGISTRY:"https://registry.invalid/",GITHUB_RUN_ID:"900",GITHUB_RUN_ATTEMPT:"1",GITHUB_REPOSITORY:"JetBrains/ytdb-slate"};
  const git=(cwd:string,...args:string[])=>{const p=spawnSync("git",args,{cwd,env,encoding:"utf8",timeout:10000});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
  git(root,"init","--bare",remote);git(repo,"init","-b","main");git(repo,"remote","add","origin",remote);git(repo,"config","user.name","Fixture");git(repo,"config","user.email","fixture@example.invalid");mkdirSync(join(repo,"verification"));for(const filename of["release-control.mjs","release-job.mjs"])cpSync(new URL(`../verification/${filename}`,import.meta.url),join(repo,"verification",filename));writeFileSync(join(repo,"package.json"),'{"version":"0.10.0"}\n');writeFileSync(join(repo,"package-lock.json"),'{"version":"0.10.0","packages":{"":{"version":"0.10.0"}}}\n');git(repo,"add",".");git(repo,"commit","-m","base");const base=git(repo,"rev-parse","HEAD");git(repo,"push","origin","HEAD:main");git(repo,"push","origin","HEAD:release/0.10");
  writeFileSync(join(bin,"npm"),`#!/bin/sh\nprintf '{"versions":["0.9.0","0.10.0"],"time":{"created":"${NOW}","modified":"${NOW}","0.9.0":"${NOW}","0.10.0":"${NOW}"}}\\n'\n`);chmodSync(join(bin,"npm"),0o755);
  const script=workflowRunBlock("prepare"),run=(attempt:string,id="900")=>spawnSync("/bin/bash",["-c",script],{cwd:repo,env:{...env,VERSION:"0.10.1",NOTES:"Release notes",GITHUB_RUN_ATTEMPT:attempt,GITHUB_RUN_ID:id},encoding:"utf8",timeout:20000});
  const unrecorded=run("2");assert.notEqual(unrecorded.status,0);assert.match(unrecorded.stderr,/no recorded base/);
  const first=run("1");assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/Target branch: release\/0\.10/);
  const request=JSON.parse(git(repo,"show","origin/release-state:request.json"));assert.equal(request.targetBranch,"release/0.10");assert.equal(request.baseSha,base);assert.equal(request.schema,3);
  const prepared=git(repo,"rev-parse","origin/release-state");const branch=`release/v0.10.1-${request.identity.slice(0,12)}`;
  assert.equal(git(repo,"rev-parse",`${branch}^`),base);
  git(repo,"switch","--detach",base);const repeat=run("2");assert.equal(repeat.status,0,repeat.stderr);assert.match(repeat.stdout,/Continuing idempotently/);
  git(repo,"switch","--detach",base);git(repo,"switch","-c","backport");writeFileSync(join(repo,"change"),"backport\n");git(repo,"add","change");git(repo,"commit","-m","backport");git(repo,"push","origin","HEAD:release/0.10");git(repo,"switch","--detach",base);
  const moved=run("3");assert.notEqual(moved.status,0);assert.match(moved.stderr,/target moved/);assert.equal(git(repo,"rev-parse","origin/release-state"),prepared);
  const newRun=run("1","901");assert.notEqual(newRun.status,0);assert.match(newRun.stderr,/owns the lane/);
});

test("real operator workflow blocks match only the durable release-branch target",t=>{
  const r=branchRequest(),state=initialState(r,NOW),branch=`release/v${r.version}-${r.identity.slice(0,12)}`,merged=branchPr(r),open={...merged,merged_at:null,state:"open"};
  for(const [job,pr,status] of [["retire",merged,"retired"],["abandon",open,"abandoned"]] as const){
    const f=workflowFixture(t,state);writeFileSync(join(f.root,"request.json"),JSON.stringify(r));writeFileSync(join(f.root,"state/request.json"),JSON.stringify(r));writeFileSync(join(f.root,"prs.jsonl"),JSON.stringify([])+"\n"+JSON.stringify([pr])+"\n");
    const result=runWorkflowBlock(f,workflowRunBlock(job),{VERSION:r.version,IDENTITY:r.identity,GH_EXPECT_PRS_QUERY:`repos/JetBrains/ytdb-slate/pulls?state=all&head=JetBrains:${branch}&per_page=100`});
    assert.equal(result.status,0,`${job}: ${result.stderr}`);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,status);
    assert.match(readFileSync(f.effectLog,"utf8"),/gh\tapi --paginate/);
  }
  for(const job of ["retire","abandon"]){const f=workflowFixture(t,state);writeFileSync(join(f.root,"request.json"),JSON.stringify(r));writeFileSync(join(f.root,"prs.jsonl"),JSON.stringify([branchPr(r,{base:{ref:"main"}})])+"\n");const result=runWorkflowBlock(f,workflowRunBlock(job),{VERSION:r.version,IDENTITY:r.identity});if(job==="retire"){assert.notEqual(result.status,0);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"prepared");}else{assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"abandoned");assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/gh\tpr close/);}}
});

test("report mode executes the same roster without a request or a local WARN decision",t=>{
  const f=createRosterFixture(t),run=spawnSync("/bin/bash",["verification/release-checks.sh","--repo",f.repo,"--base",f.base,"--report","--evidence",f.evidence],{cwd:f.repo,env:f.env,encoding:"utf8",timeout:30000});
  assert.equal(run.status,0,run.stderr+run.stdout);assert.match(readFileSync(join(f.evidence,"roster.txt"),"utf8"),/mode=report/);assert.match(readFileSync(join(f.evidence,"coverage-verdict.txt"),"utf8"),/WARN/);
  assert.throws(()=>readFileSync(join(f.evidence,"coverage-disposition.txt")));
  const ci=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");assert.match(ci,/release\/\[0-9\]\*/);assert.match(ci,/branch creation has no previous commit/);
});
