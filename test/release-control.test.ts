import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
// @ts-expect-error Unshipped JavaScript commands have no declaration files.
import { STATUSES, TERMINAL, assertNoEndedIdentity, preparedMergeProof, abandon, advance, authorizeInstall, authorizeUpload, beginPromotion, beginUpload, claimRelease, classifyRegistry, closeWithoutPromotion, hashBytes, initialState, makeRequest, planFinalization, recordInstallFailure, recordInstallProof, recordPromotion, recordRegistry, releasePathsAllowed, retire, validateState, versionUsage, verifyReleaseIdentity, writeExclusive } from "../verification/release-control.mjs";
// @ts-expect-error Unshipped JavaScript commands have no declaration files.
import { executeFinalRecords, executeInstall, executePromotion, executeUpload } from "../verification/release-job.mjs";

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

test("not-attempted binds a fixed cause and retains the expected latest",()=>{
  const s=proved(),o=owner(s),intent=beginPromotion(s,"0.10.0",o,"17","1",NOW),base={identity:s.identity,releaseSha:s.releaseSha,execution:"17:1"};
  assert.throws(()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"2",registry:"x",token:"",view:()=>assert.fail(),exec:()=>assert.fail()}),/active promoter/);
  const missing=executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:"x",token:"",view:()=>assert.fail(),exec:()=>assert.fail()});assert.deepEqual(missing,{...base,result:"not-attempted",cause:"missing-token"});
  const failed=executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:"x",token:"secret",view:()=>{throw Error("private registry response");},exec:()=>assert.fail()});assert.deepEqual(failed,{...base,result:"not-attempted",cause:"latest-read-failed"});assert.doesNotMatch(JSON.stringify(failed),/private registry response/);
  for(const cause of [undefined,"other",null,42])assert.throws(()=>recordPromotion(intent,{...missing,cause},o,NOW),/cause|malformed/);
  for(const extra of [{before:""},{after:""},{expectedLatest:"0.9.0"},{intentAt:"tampered"}])assert.throws(()=>recordPromotion(intent,{...missing,...extra},o,NOW),/malformed/);
  for(const result of [missing,failed]){const recorded=recordPromotion(intent,result,o,NOW);assert.equal(recorded.status,"proved");assert.equal(recorded.promoterExecution,null);assert.equal(recorded.promotionEvidence.expectedLatest,"0.10.0");assert.equal(recorded.promotionEvidence.cause,result.cause);assert.throws(()=>validateState({...recorded,promotionEvidence:{...recorded.promotionEvidence,cause:"foreign"}}),/cause/);assert.equal(closeWithoutPromotion(recorded,o,NOW).status,"closed-unpromoted");assert.equal(beginPromotion(recorded,"0.10.0",o,"19","2",NOW).promoterExecution,"19:2");}
  const refused=recordPromotion(intent,{...base,result:"refused",before:"0.10.0",after:"0.10.0"},o,NOW);assert.equal(beginPromotion(refused,"0.10.0",o,"19","2",NOW).status,"promotion-unknown");
  assert.throws(()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:"x",token:"secret",view:()=>"0.10.0",exec:()=>{throw Error("write error");}}),/write error/);
  let reads=0;assert.throws(()=>executePromotion({state:intent,expected:o,runId:"17",runAttempt:"1",registry:"x",token:"secret",view:()=>{if(++reads===2)throw Error("second read error");return "0.10.0";},exec:()=>{}}),/second read error/);
});

test("operator actions bind version and generation without mutating the wrong state",()=>{const prepared=initialState(req(),NOW),target={identity:prepared.identity,version:prepared.version,releaseSha:null,releaseParent:null};assert.throws(()=>abandon(prepared,{...target,version:"0.10.2"},false,NOW));assert.throws(()=>abandon(prepared,{...target,identity:"f".repeat(64)},false,NOW));assert.equal(abandon(prepared,target,false,NOW).status,"abandoned");assert.throws(()=>abandon(prepared,target,true,NOW));const c=claimed();assert.throws(()=>retire(c,{...owner(c),version:"0.10.2"},NOW));assert.throws(()=>retire(c,{...owner(c),identity:"f".repeat(64)},NOW));});

test("install failure evidence permits only explicit terminal closure and preserves retry history",()=>{const pub=published(),o=owner(pub),auth=authorizeInstall(pub,o,"17","2");assert.equal(auth.execution,"17:2");for(const mutate of[(s:any)=>({...s,status:"proved"}),(s:any)=>({...s,registry:null}),(s:any)=>({...s,upload:"unknown"}),(s:any)=>({...s,registry:{...s.registry,identity:"f".repeat(64)}}),(s:any)=>({...s,registry:{...s.registry,releaseSha:C}}),(s:any)=>({...s,registry:{...s.registry,execution:"17:2"}})])assert.throws(()=>authorizeInstall(mutate(pub),o,"17","2"));const failure=failureEnvelope(pub,"17:2"),failed=recordInstallFailure(pub,failure,o,NOW);assert.equal(failed.installFailures.length,1);assert.deepEqual(recordInstallFailure(failed,failure,o,NOW),failed);assert.throws(()=>recordInstallFailure(pub,{...failure,registryIntegrity:"sha512-foreign"},o,NOW));assert.throws(()=>recordInstallFailure(pub,{...failure,identity:"f".repeat(64)},o,NOW));const unchanged=JSON.stringify(failed);assert.throws(()=>closeWithoutPromotion(pub,o,NOW));assert.throws(()=>closeWithoutPromotion(uploaded(),owner(uploaded()),NOW));assert.throws(()=>closeWithoutPromotion({...failed,promotion:"unknown"},o,NOW));assert.throws(()=>closeWithoutPromotion({...failed,promoterExecution:"19:1"},o,NOW));assert.throws(()=>closeWithoutPromotion(failed,{...o,version:"0.10.2"},NOW));assert.equal(JSON.stringify(failed),unchanged);const closed=closeWithoutPromotion(failed,o,NOW);assert.equal(closed.status,"closed-unpromoted");assert.equal(closed.installFailures.length,1);assert.throws(()=>recordInstallFailure(closed,failure,o,NOW));assert.throws(()=>recordInstallProof(closed,installEnvelope(pub,"17:3"),o,NOW));const proof=installEnvelope(failed,"17:3"),retry=recordInstallProof(failed,proof,o,NOW);assert.equal(retry.status,"proved");assert.equal(retry.installFailures.length,1);assert.throws(()=>recordInstallFailure(retry,failureEnvelope(pub,"17:4"),o,NOW));const later=makeRequest({version:"0.10.2",baseSha:B,notes,currentVersion:"0.10.1",authorization:"102"});assert.equal(initialState(later,NOW).version,"0.10.2");});

test("release effects use exact commands and reject stale launch identity before effects",()=>{const calls:any[]=[],u=uploaded(),o=owner(u),root=mkdtempSync(join(tmpdir(),"slate-upload-")),archive=join(root,"package.tgz");writeFileSync(archive,"archive");try{assert.throws(()=>executeUpload({state:u,expected:{...o,identity:"f".repeat(64)},archive,runId:"17",runAttempt:"1",registry:"https://registry.invalid/",npmVersion:()=>"11.16.0",exec:(...x:any[])=>calls.push(x)}));executeUpload({state:u,expected:o,archive,runId:"17",runAttempt:"1",registry:"https://registry.invalid/",npmVersion:()=>"11.16.0",exec:(...x:any[])=>calls.push(x)});}finally{rmSync(root,{recursive:true,force:true});}assert.deepEqual(calls[0][1],["publish",archive,"--tag","slate-candidate","--ignore-scripts","--provenance=false","--registry","https://registry.invalid/"]);
const ps=proved(),intent=beginPromotion(ps,"0.10.0",owner(ps),"17","1",NOW);let views=0;const result=executePromotion({state:intent,expected:owner(intent),runId:"17",runAttempt:"1",registry:"https://registry.invalid/",token:"secret",view:()=>views++===0?"0.10.0":"0.10.1",exec:(...x:any[])=>calls.push(x)});assert.equal(result.execution,"17:1");assert.throws(()=>executePromotion({state:intent,expected:{...owner(intent),identity:"f".repeat(64)},runId:"17",runAttempt:"1",registry:"x",token:"secret",view:()=>assert.fail(),exec:()=>assert.fail()}));
const pub=published(),installRoot=mkdtempSync(join(tmpdir(),"slate-install-"));try{let wrongN=0;assert.throws(()=>executeInstall({state:pub,expected:{...owner(pub),identity:"f".repeat(64)},runId:"17",runAttempt:"2",workspace:installRoot,out:join(installRoot,"wrong.json"),exec:()=>{wrongN++;return{stdout:""};}}));assert.equal(wrongN,0);let n=0;const proof=executeInstall({state:pub,expected:owner(pub),runId:"17",runAttempt:"2",workspace:installRoot,out:join(installRoot,"proof.json"),exec:()=>++n===2?{stdout:'{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate","sourceInfo":{"source":"npm:ytdb-slate@0.10.1"}}]}}\n'}:{stdout:""}});assert.equal(proof.identity,pub.identity);assert.equal(proof.execution,"17:2");const retryProved=recordInstallProof(pub,proof,owner(pub),NOW);assert.equal(retryProved.status,"proved");assert.equal(beginPromotion(retryProved,"0.10.0",owner(retryProved),"18","1",NOW).status,"promotion-unknown");}finally{rmSync(installRoot,{recursive:true,force:true});}
const promoted=recordPromotion(intent,result,owner(intent),NOW);calls.length=0;executeFinalRecords({state:promoted,expected:owner(promoted),notes:"notes.md",repo:"JetBrains/ytdb-slate",exec:(...x:any[])=>calls.push(x)});assert.equal(calls.filter(x=>x[0]==="git").length,2);assert.equal(calls.filter(x=>x[0]==="gh").length,1);});

test("the real npm package-spec parser classifies the exact upload argument from a relative archive",()=>{const found=spawnSync("/bin/sh",["-c","command -v npm"],{encoding:"utf8"});assert.equal(found.status,0,found.stderr);const npmPath=realpathSync(found.stdout.trim()),npmRoot=resolve(dirname(npmPath),".."),requireNpm=createRequire(join(npmRoot,"package.json")),parse=requireNpm("npm-package-arg");assert.equal(parse("archive/ytdb-slate-0.11.0.tgz").type,"git");const s=uploaded(),root=mkdtempSync(join(tmpdir(),"slate-npa-")),old=process.cwd();try{mkdirSync(join(root,"archive"));writeFileSync(join(root,"archive/package.tgz"),"archive");process.chdir(root);const calls:any[]=[];executeUpload({state:s,expected:owner(s),archive:"archive/package.tgz",runId:"17",runAttempt:"1",registry:"https://registry.invalid/",npmVersion:()=>"11.16.0",exec:(...args:any[])=>calls.push(args)});const argument=calls[0][1][1];assert.equal(argument,join(root,"archive/package.tgz"));assert.equal(parse(argument).type,"file");assert.equal(parse(argument).fetchSpec,argument);assert.throws(()=>executeUpload({state:s,expected:owner(s),archive:"archive",runId:"17",runAttempt:"1",registry:"x",npmVersion:()=>"11.16.0",exec:()=>assert.fail()}),/regular file/);assert.throws(()=>executeUpload({state:s,expected:owner(s),archive:"absent.tgz",runId:"17",runAttempt:"1",registry:"x",npmVersion:()=>"11.16.0",exec:()=>assert.fail()}));}finally{process.chdir(old);rmSync(root,{recursive:true,force:true});}});

const workflowUrl=new URL("../.github/workflows/release.yml",import.meta.url),workflow=readFileSync(workflowUrl,"utf8"),releasing=readFileSync(new URL("../RELEASING.md",import.meta.url),"utf8"),agents=readFileSync(new URL("../AGENTS.md",import.meta.url),"utf8"),mechanism=readFileSync(new URL("../verification/README.md",import.meta.url),"utf8");
function workflowJobBlock(name:string){const lines=workflow.split("\n"),start=lines.findIndex(x=>x===`  ${name}:`);assert.notEqual(start,-1,`missing workflow job ${name}`);let end=lines.length;for(let i=start+1;i<lines.length;i++)if(/^  [a-z][a-z-]*:$/.test(lines[i]??"")){end=i;break;}return lines.slice(start,end);}
function workflowRunBody(lines:string[],marker:number){const markerLine=lines[marker]??"",markerIndent=markerLine.length-markerLine.trimStart().length,body:string[]=[];for(let i=marker+1;i<lines.length;i++){const line=lines[i]??"",indent=line.length-line.trimStart().length;if(line.trim()&&indent<=markerIndent)break;body.push(line);}const contentIndent=Math.min(...body.filter(x=>x.trim()).map(x=>x.length-x.trimStart().length));return body.map(x=>x.slice(Math.min(contentIndent,x.length))).join("\n");}
function workflowRunBlock(name:string){const lines=workflowJobBlock(name),marker=lines.findIndex(x=>["run: |","- run: |"].includes(x.trim()));assert.notEqual(marker,-1,`missing run block for ${name}`);return workflowRunBody(lines,marker);}
function workflowStepRunBlock(job:string,id:string){const lines=workflowJobBlock(job),step=lines.findIndex(x=>x.trim()===`- id: ${id}`);assert.notEqual(step,-1,`missing workflow step ${job}.${id}`);const marker=lines.findIndex((x,i)=>i>step&&["run: |","- run: |"].includes(x.trim()));assert.notEqual(marker,-1,`missing run block for ${job}.${id}`);return workflowRunBody(lines,marker);}
function renderWorkflowBlock(source:string,values:Record<string,string>={}){return source.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,(_all,key:string)=>{const value=values[key.trim()];if(value===undefined)throw new Error(`unknown workflow expression ${key}`);return value;});}
function workflowFixture(t:any,state:any){const root=mkdtempSync(join(tmpdir(),"slate-workflow-")),bin=join(root,"bin"),effectLog=join(root,"effects.log"),temp=join(root,"tmp");t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(bin);mkdirSync(temp);mkdirSync(join(root,"verification"));mkdirSync(join(root,"control/verification"),{recursive:true});mkdirSync(join(root,"state/archive"),{recursive:true});mkdirSync(join(root,"current-control/verification"),{recursive:true});mkdirSync(join(root,"runner"));for(const dir of["verification","control/verification","current-control/verification"])for(const file of["release-control.mjs","release-job.mjs"])cpSync(new URL(`../verification/${file}`,import.meta.url),join(root,dir,file));writeFileSync(join(root,"state.json"),JSON.stringify(state,null,2)+"\n");writeFileSync(join(root,"state/state.json"),JSON.stringify(state,null,2)+"\n");writeFileSync(join(root,"state/archive/package.tgz"),"archive");writeFileSync(effectLog,"");writeFileSync(join(bin,"git"),`#!/bin/sh\nprintf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"rev-parse HEAD"*) printf '${C}\\n';; esac\nexit 0\n`);writeFileSync(join(bin,"gh"),`#!/bin/sh\nprintf 'gh\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"/pulls?"*) test "${'${GH_FAIL_PRS:-0}'}" = 0 || exit 1; test -f "$GH_PRS" || exit 1; cat "$GH_PRS";; *"/jobs?"*) test "${'${GH_FAIL_JOBS:-0}'}" = 1 && exit 1; test -f "$GH_JOBS" || exit 1; cat "$GH_JOBS"; test "${'${GH_FAIL_JOBS:-0}'}" = 0 || exit 1;; *"/attempts/"*) test "${'${GH_FAIL_RUN:-0}'}" = 1 && exit 1; test -f "$GH_RUN" || exit 1; cat "$GH_RUN"; test "${'${GH_FAIL_RUN:-0}'}" = 0 || exit 1;; esac\nexit 0\n`);writeFileSync(join(root,"latest"),"0.10.0\n");writeFileSync(join(bin,"npm"),`#!/bin/sh\nprintf 'npm\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"versions time"*) test "${'${NPM_FAIL:-0}'}" = 0 || { if test "${'${NPM_FAIL:-0}'}" = 4; then cat "$NPM_DOC"; exit 1; fi; echo 'E404 or network failure' >&2; exit 1; }; test -f "$NPM_DOC" && { cat "$NPM_DOC"; exit 0; }; exit 1;; *"dist-tags.latest"*) n=$(($(cat "$NPM_READ_COUNT" 2>/dev/null || echo 0)+1)); echo "$n" >"$NPM_READ_COUNT"; case "${'${NPM_READ_FAIL_FIRST:-0}'}:$n" in 1:1) echo 'PRIVATE REGISTRY RESPONSE' >&2; exit 1;; esac; case "${'${NPM_READ_FAIL_SECOND:-0}'}:$n" in 1:2) echo 'PRIVATE REGISTRY RESPONSE' >&2; exit 1;; esac; cat "$NPM_LATEST_FILE";; *"dist-tag add"*) test "${'${NODE_AUTH_TOKEN:-}'}" = fixture-stage-token || { echo 'missing authorized token' >&2; exit 8; }; test "${'${NPM_WRITE_FAIL:-0}'}" = 0 || { if test "${'${NPM_WRITE_FAIL:-0}'}" = 2; then echo 'UNKNOWN npm failure' >&2; else echo 'E403 Forbidden' >&2; fi; exit 1; }; printf '%s\\n' "${'${3#ytdb-slate@}'}" >"$NPM_LATEST_FILE";; esac\nexit 0\n`);writeFileSync(join(bin,"pi"),`#!/bin/sh\nprintf 'pi\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in *"--mode rpc"*) if test "${'${PI_SUCCESS:-0}'}" = 1; then printf '{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate","sourceInfo":{"source":"npm:ytdb-slate@0.10.1"}}]}}\\n'; else printf '{"type":"response","command":"get_commands","data":{"commands":[]}}\\n'; fi;; esac\nexit 0\n`);for(const name of["git","gh","npm","pi"])chmodSync(join(bin,name),0o755);const env={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,PI_BIN:join(bin,"pi"),HOME:root,TMPDIR:temp,RUNNER_TEMP:join(root,"runner"),REGISTRY:"https://registry.invalid/",GH_RUN:join(root,"run.json"),GH_JOBS:join(root,"jobs.json"),GH_PRS:join(root,"prs.jsonl"),NPM_DOC:join(root,"package.json"),GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",EFFECT_LOG:effectLog,NPM_LATEST_FILE:join(root,"latest"),NPM_READ_COUNT:join(root,"read-count"),GITHUB_RUN_ID:"900",GITHUB_RUN_ATTEMPT:"2",GITHUB_REPOSITORY:"JetBrains/ytdb-slate",GITHUB_OUTPUT:join(root,"output")};return{root,effectLog,env};}
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

const workflowValues=(state:any)=>({"needs.identify.outputs.identity":state.identity,"needs.identify.outputs.version":state.version,"needs.identify.outputs.release_sha":state.releaseSha,"needs.identify.outputs.parent_sha":state.releaseParent});
function outputValues(path:string){return Object.fromEntries(readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(line=>{const at=line.indexOf("=");return[line.slice(0,at),line.slice(at+1)];}));}
function identifyCheckout(){const lines=workflowJobBlock("identify"),checkout=lines.findIndex(x=>x.includes("with: { ref: release-state, path: durable }")),releaseCode=lines.findIndex(x=>x.includes("with: { ref: '${{ steps.candidate.outputs.release_sha }}', path: release-code }"));assert.notEqual(checkout,-1);assert.ok(releaseCode>checkout,"identify must check out the selected release commit after durable state");const condition=lines.slice(0,checkout).reverse().find(x=>x.trim().startsWith("- if:"))?.trim().slice(5).trim();assert.ok(condition);assert.equal(lines.slice(checkout+1,releaseCode).reverse().find(x=>x.trim().startsWith("- if:"))?.trim().slice(5).trim(),condition);return{condition,ref:"release-state",index:checkout,releaseCode};}
function candidateCondition(condition:string,releaseSha:string){if(condition==="steps.candidate.outputs.release_sha != ''")return releaseSha!=="";if(condition==="always()")return true;throw new Error(`unsupported candidate condition: ${condition}`);}
function registryCondition(){const line=workflowJobBlock("record-registry").find(x=>x.trim().startsWith("if:"));assert.ok(line);return line.trim().slice(3).trim();}
function registryEligible(condition:string,releaseSha:string,result:string){assert.equal(condition,"always() && needs.identify.outputs.release_sha != '' && (needs.registry-proof.result == 'success' || needs.registry-proof.result == 'failure')");return releaseSha!==""&&(result==="success"||result==="failure");}
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
  assert.deepEqual(packs,[`npm\tpack ytdb-slate@${state.version} --ignore-scripts --pack-destination registry --registry https://registry.invalid/`]);
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

test("real seal-upload workflow block runs and requires identity at begin-upload",t=>{const state=claimed(),values=workflowValues(state),source=workflowRunBlock("seal-upload"),f=workflowFixture(t,state),result=runWorkflowBlock(f,renderWorkflowBlock(source,values));assert.equal(result.status,0,result.stderr);const sealed=JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8"));assert.equal(sealed.status,"upload-unknown");assert.equal(sealed.uploadExecution,"900:2");assert.match(readFileSync(f.effectLog,"utf8"),/push origin HEAD:release-state --force-with-lease=/);
const mutant=source.split("\n").map(line=>line.includes(" begin-upload ")?line.replace(" --identity '${{ needs.identify.outputs.identity }}'",""):line).join("\n");assert.notEqual(mutant,source);const mf=workflowFixture(t,state),failed=runWorkflowBlock(mf,renderWorkflowBlock(mutant,values));assert.notEqual(failed.status,0);assert.equal(JSON.parse(readFileSync(join(mf.root,"state/state.json"),"utf8")).status,"claimed");assert.doesNotMatch(readFileSync(mf.effectLog,"utf8"),/push origin/);});

test("real operator workflow blocks bind targets and permit intended progress",t=>{for(const [name,state,expectedStatus] of [["retire",claimed(),"retired"],["close",proved(),"closed-unpromoted"],["close",failedPublished(),"closed-unpromoted"]] as const){const script=workflowRunBlock(name);for(const [label,version,identity] of [["correct",state.version,state.identity],["wrong-version","0.10.2",state.identity],["wrong-identity",state.version,"f".repeat(64)]] as const){const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8"),result=runWorkflowBlock(f,script,{VERSION:version,IDENTITY:identity}),effects=readFileSync(f.effectLog,"utf8");if(label==="correct"){assert.equal(result.status,0,`${name}: ${result.stderr}`);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,expectedStatus);assert.match(effects,/push origin HEAD:release-state/);if(name==="retire")assert.match(effects,/commit -m Retire merged no-upload authorization/);}else{assert.notEqual(result.status,0,`${name} accepted ${label}`);assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)|gh\t|npm\t/);}}}
const state=published(),script=workflowRunBlock("recover");for(const [label,version,identity] of [["correct",state.version,state.identity],["wrong-version","0.10.2",state.identity],["wrong-identity",state.version,"f".repeat(64)]] as const){const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state.json"),"utf8"),result=runWorkflowBlock(f,script,{VERSION:version,IDENTITY:identity}),effects=readFileSync(f.effectLog,"utf8");if(label==="correct"){assert.equal(result.status,0,result.stderr);assert.match(effects,/gh\trun rerun 17 --repo JetBrains\/ytdb-slate --failed/);assert.match(result.stdout,/failed jobs and their dependents/);assert.match(result.stdout,/Promotion and final records can run only after/);assert.doesNotMatch(result.stdout,/read-only installation proof|promotion remain disabled/i);}else{assert.notEqual(result.status,0);assert.doesNotMatch(effects,/gh\t|npm\t|git\t.*(?:add|commit|push)/);}assert.equal(readFileSync(join(f.root,"state.json"),"utf8"),before);}const unknown=uploaded(),uf=workflowFixture(t,unknown),before=readFileSync(join(uf.root,"state.json"),"utf8"),retried=runWorkflowBlock(uf,script,{VERSION:unknown.version,IDENTITY:unknown.identity});assert.equal(retried.status,0,retried.stderr);assert.match(readFileSync(uf.effectLog,"utf8"),/gh\trun rerun 17 --repo JetBrains\/ytdb-slate --failed/);assert.match(retried.stdout,/failed jobs and their dependents/);assert.match(retried.stdout,/sealed upload authority rejects every upload rerun/);assert.match(retried.stdout,/Promotion and final records can run only after registry and installation proofs succeed/);assert.equal(readFileSync(join(uf.root,"state.json"),"utf8"),before);});

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
  for(const [label,state,ok] of [["claim first",prepared,true],["repeat claim",merged,true],["retire first",retiredPrepared,false],["new preparation",newOwner,false]] as const){const f=workflowFixture(t,state),before=readFileSync(join(f.root,"state/state.json"),"utf8");writeFileSync(join(f.root,"state/request.json"),JSON.stringify(state.identity===request.identity?request:later));const r=runWorkflowBlock(f,renderWorkflowBlock(script,values),{LAUNCH_IDENTITY:request.identity}),effects=readFileSync(f.effectLog,"utf8");assert.equal(r.status===0,ok,`${label}: ${r.stderr}`);if(label==="claim first")assert.equal(JSON.parse(readFileSync(join(f.root,"state/state.json"),"utf8")).status,"claimed");if(!ok){assert.equal(readFileSync(join(f.root,"state/state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*(?:add|commit|push)/);}}
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
  assert.match(script,/assertNoEndedIdentity/);
  assert.deepEqual(Object.keys(states).sort(),[...STATUSES].sort());
  for(const status of STATUSES){
    const old=validateState(states[status]),f=workflowFixture(t,old);
    assert.equal(old.status,status);
    writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"0.11.0",versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}}));
    writeFileSync(join(f.root,"package-lock.json"),JSON.stringify({version:"0.11.0",packages:{"":{version:"0.11.0"}}}));
    writeFileSync(join(f.root,"bin/git"),`#!/bin/sh\nprintf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"\ncase "$*" in\n  "ls-remote --exit-code --heads origin release-state") exit 0;;\n  "ls-remote --exit-code --heads origin "*) exit 2;;\n  "rev-parse HEAD") printf '${C}\\n'; exit 0;;\n  "rev-parse origin/release-state") printf '${A}\\n'; exit 0;;\n  "rev-list ${A}") printf '${A}\\n'; exit 0;;
  "show ${A}:state.json") cat "$HOME/state.json"; exit 0;;\n  "commit-tree "*) cat >/dev/null; printf '${B}\\n'; exit 0;;\nesac\nexit 0\n`);
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
  for(const [sha,state] of [["a",retiredA],["b",preparedB],["c",endedB],["d",preparedA]] as const)writeFileSync(join(f.root,`${sha}.json`),JSON.stringify(state));
  writeFileSync(join(f.root,"bin/git"),`#!/bin/sh
printf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"
case "$*" in
  "rev-parse HEAD") printf '${C}\\n';;
  "ls-remote --exit-code --heads origin release-state") exit 0;;
  "ls-remote --exit-code --heads origin "*) exit 2;;
  "rev-parse origin/release-state") printf '%s\\n' "$HISTORY_HEAD";;
  "rev-list "*) test "${'${HISTORY_FAIL:-0}'}" = 0 || exit 1; case "$HISTORY_HEAD" in a) printf 'a\\nd\\n';; b) printf 'b\\na\\nd\\n';; c) printf 'c\\nb\\na\\nd\\n';; esac;;
  "show "*) sha="${'${2%%:*}'}"; cat "$HOME/$sha.json";;
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
    const f=workflowFixture(t,state);writeFileSync(join(f.root,"package.json"),JSON.stringify({version:"0.11.0",versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}}));
    writeFileSync(join(f.root,"bin/git"),`#!/bin/sh
printf 'git\\t%s\\n' "$*" >>"$EFFECT_LOG"
case "$*" in
  "rev-parse HEAD") printf '${C}\\n';;
  "ls-remote --exit-code --heads origin release-state") if test "$PROBE" = release-state; then exit 128; else exit 0; fi;;
  "ls-remote --exit-code --heads origin "*) exit 128;;
  "rev-parse origin/release-state") printf '${A}\\n';;
  "rev-list ${A}") printf '${A}\\n';;
  "show ${A}:state.json") cat "$HOME/state.json";;
esac
exit 0
`);
    const before=readFileSync(join(f.root,"state/state.json"),"utf8"),result=runWorkflowBlock(f,workflowRunBlock("prepare"),{VERSION:request.version,NOTES:"Release notes",STATE_BRANCH:"release-state",PROBE:probe}),effects=readFileSync(f.effectLog,"utf8");
    assert.equal(result.status,2,`${probe}: ${result.stderr} ${result.stdout}`);assert.match(result.stderr,probe==="release-state"?/release-state branch could not be read/:/prepared branch could not be read/);assert.equal(readFileSync(join(f.root,"state/state.json"),"utf8"),before);assert.doesNotMatch(effects,/git\t.*push origin/);
    if(probe==="prepared")assert.match(result.stdout,/Continuing idempotently/);
  }
});

test("real prepare workflow refuses a version listed only in npm time or a failed package read",t=>{const script=workflowRunBlock("prepare");assert.match(script,/npm view ytdb-slate versions time --json --cache/);for(const failed of [false,true]){const f=workflowFixture(t,claimed()),doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW,"0.10.1":NOW}};writeFileSync(join(f.root,"package.json"),JSON.stringify(doc));const result=runWorkflowBlock(f,script,{VERSION:"0.10.1",NOTES:"Release notes",NPM_FAIL:failed?"1":"0"});assert.notEqual(result.status,0);assert.match(result.stderr,failed?/Cannot read the full npm package document/:/already used by npm/);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\t.*(?:add|commit|push)/);}});

test("preparation refuses a successful-looking npm body with a nonzero read status",t=>{
  const f=workflowFixture(t,claimed()),doc={versions:["0.10.0"],time:{created:NOW,modified:NOW,"0.10.0":NOW}};
  writeFileSync(join(f.root,"package.json"),JSON.stringify(doc));
  const result=runWorkflowBlock(f,workflowRunBlock("prepare"),{VERSION:"0.10.1",NOTES:"Release notes",NPM_FAIL:"4",STATE_BRANCH:"release-state"});
  assert.notEqual(result.status,0);
  assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\t(?:config|add|commit|push)/);
  assert.match(result.stderr,/Cannot read the full npm package document/);
});

test("real install failure workflow records the producing attempt and closes without success effects",t=>{const pub=published(),values=workflowValues(pub),install=renderWorkflowBlock(workflowRunBlock("install-proof"),values),f=workflowFixture(t,pub),failed=runWorkflowBlock(f,install);assert.notEqual(failed.status,0);const failurePath=join(f.root,"runner/install/failure.json"),failure=JSON.parse(readFileSync(failurePath,"utf8"));assert.equal(failure.execution,"900:2");assert.equal(failure.result,"failed");mkdirSync(join(f.root,"failure"));cpSync(failurePath,join(f.root,"failure/failure.json"));const recorded=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("record-install-failure"),values));assert.equal(recorded.status,0,recorded.stderr);const state=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(state.status,"published");assert.equal(state.installFailures[0].execution,"900:2");assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag|git\ttag|gh\trelease create/);const closed=runWorkflowBlock(f,workflowRunBlock("close"),{VERSION:state.version,IDENTITY:state.identity});assert.equal(closed.status,0,closed.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"closed-unpromoted");});

test("real promotion steps and recorders retry only with a new intent",{timeout:30000},t=>{
  const values=(job:string,s:any)=>Object.fromEntries(Object.entries(workflowValues(s)).map(([k,v])=>[job.startsWith("recover")?k.replace("needs.identify.","needs.recover."):k,v]));
  const promote=(job:string,s:any)=>{const line=workflowJobBlock(job).join("\n").match(/^\s*run: (node verification\/release-job\.mjs promote[^\n]*)$/m)?.[1];assert.ok(line);return renderWorkflowBlock(line,values(job,s));};
  const recorder=(job:string,s:any)=>renderWorkflowBlock(workflowRunBlock(job),values(job,s));
  for(const job of ["promote","recover-promote"]){
    const steps=workflowJobBlock(job).join("\n").split(/^      - /m);
    const step=steps.filter(x=>/^\s*run: node verification\/release-job\.mjs promote\b/m.test(x));
    assert.equal(step.length,1,`${job} must have one promotion step`);
    assert.match(step[0]!,/^\s*(?:env: \{ )?NODE_AUTH_TOKEN: (?:\$\{\{ secrets\.NPM_STAGE_ONLY_TOKEN \}\}|'\$\{\{ secrets\.NPM_STAGE_ONLY_TOKEN \}\}')(?: \})?$/m,`${job} must bind the stage-only secret on its promotion step`);
  }
  for(const scenario of ["missing-token","read-failed","refused"]){
    const proof=proved(),intent=beginPromotion(proof,"0.10.0",owner(proof),"900","2",NOW),f=workflowFixture(t,intent);
    const first=runWorkflowBlock(f,promote("promote",intent),{NODE_AUTH_TOKEN:scenario==="missing-token"?"":"fixture-stage-token",NPM_READ_FAIL_FIRST:scenario==="read-failed"?"1":"0",NPM_WRITE_FAIL:scenario==="refused"?"1":"0"}),result=JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8"));
    assert.equal(first.status,0,first.stderr);assert.equal(result.result,scenario==="refused"?"refused":"not-attempted",`${scenario}: ${readFileSync(f.effectLog,"utf8")} read-count=${scenario==="missing-token"?"none":readFileSync(join(f.root,"read-count"),"utf8")}`);if(scenario!=="refused")assert.equal(result.cause,scenario==="missing-token"?"missing-token":"latest-read-failed");assert.deepEqual(first.stdout.split("\n").filter(line=>line.startsWith("::error::")),scenario==="refused"?[]:[`::error::Promotion not-attempted (${result.cause}): no npm write happened`]);assert.doesNotMatch(JSON.stringify(result)+first.stdout,/PRIVATE REGISTRY RESPONSE/);
    assert.equal((readFileSync(f.effectLog,"utf8").match(/npm\tdist-tag add/g)??[]).length,scenario==="refused"?1:0);assert.equal(readFileSync(join(f.root,"latest"),"utf8"),"0.10.0\n");
    const absent=runWorkflowBlock(f,recorder("record-promotion",intent),{GITHUB_RUN_ATTEMPT:"3"});assert.notEqual(absent.status,0);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"promotion-unknown");
    assert.notEqual(runWorkflowBlock(f,promote("promote",intent),{GITHUB_RUN_ATTEMPT:"3",NODE_AUTH_TOKEN:"fixture-stage-token"}).status,0);
    mkdirSync(join(f.root,"promotion"));cpSync(join(f.root,"runner/promotion.json"),join(f.root,"promotion/promotion.json"));const saved=runWorkflowBlock(f,recorder("record-promotion",intent),{GITHUB_RUN_ATTEMPT:"3"});assert.equal(saved.status,0,saved.stderr);const resolved=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(resolved.status,"proved");assert.equal(resolved.promotion,result.result);assert.equal(resolved.promotionEvidence.expectedLatest,"0.10.0");
    const finalize=runWorkflowBlock(f,renderWorkflowBlock(workflowRunBlock("finalize"),workflowValues(intent)));assert.notEqual(finalize.status,0);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/git\ttag|gh\trelease create/);
    const retry=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:resolved.version,IDENTITY:resolved.identity,GITHUB_RUN_ATTEMPT:"3"});assert.equal(retry.status,0,retry.stderr);assert.match(readFileSync(join(f.root,"output"),"utf8"),/retry_promotion=true/);const newIntent=JSON.parse(readFileSync(join(f.root,"state.json"),"utf8"));assert.equal(newIntent.promoterExecution,"900:3");assert.equal(newIntent.promotionEvidence.expectedLatest,"0.10.0");
    const again=runWorkflowBlock(f,promote("recover-promote",newIntent),{GITHUB_RUN_ATTEMPT:"3",NODE_AUTH_TOKEN:""});assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8")).cause,"missing-token");assert.deepEqual(again.stdout.split("\n").filter(line=>line.startsWith("::error::")),["::error::Promotion not-attempted (missing-token): no npm write happened"]);assert.equal(readFileSync(join(f.root,"latest"),"utf8"),"0.10.0\n");
    const second=runWorkflowBlock(f,promote("recover-promote",newIntent),{GITHUB_RUN_ATTEMPT:"3",NODE_AUTH_TOKEN:"fixture-stage-token"});assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"runner/promotion.json"),"utf8")).result,"verified");assert.equal(readFileSync(join(f.root,"latest"),"utf8"),`${newIntent.version}\n`);
    cpSync(join(f.root,"runner/promotion.json"),join(f.root,"promotion/promotion.json"));const recorded=runWorkflowBlock(f,recorder("recover-promotion-record",newIntent),{GITHUB_RUN_ATTEMPT:"4"});assert.equal(recorded.status,0,recorded.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"complete");assert.equal((readFileSync(f.effectLog,"utf8").match(/npm\tdist-tag add/g)??[]).length,scenario==="refused"?2:1);
  }
});

test("recover refuses changed latest and preserves unknown promotion recovery",{timeout:10000},t=>{const proof=proved(),intent=beginPromotion(proof,"0.10.0",owner(proof),"900","2",NOW),base={identity:intent.identity,releaseSha:intent.releaseSha,execution:"900:2"};for(const result of [{...base,result:"not-attempted",cause:"missing-token"},{...base,result:"refused",before:"0.10.0",after:"0.10.0"}]){const s=recordPromotion(intent,result,owner(intent),NOW),f=workflowFixture(t,s);writeFileSync(join(f.root,"latest"),"0.9.0\n");const r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:s.version,IDENTITY:s.identity});assert.notEqual(r.status,0);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).promotion,result.result);assert.doesNotMatch(readFileSync(f.effectLog,"utf8"),/npm\tdist-tag add|git\t.*push origin/);}const f=workflowFixture(t,intent),r=runWorkflowBlock(f,workflowRunBlock("recover"),{VERSION:intent.version,IDENTITY:intent.identity});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).promotion,"superseded");assert.doesNotMatch(readFileSync(join(f.root,"output"),"utf8"),/retry_promotion=true/);});

test("real promoter leaves an unknown outcome after a write failure or second read failure",{timeout:10000},t=>{const s=proved(),intent=beginPromotion(s,"0.10.0",owner(s),"900","2",NOW),line=workflowJobBlock("promote").join("\n").match(/^\s*run: (node verification\/release-job\.mjs promote[^\n]*)$/m)?.[1];assert.ok(line);const script=renderWorkflowBlock(line,workflowValues(intent));for(const [name,flags] of [["write",{NPM_WRITE_FAIL:"2"}],["second read",{NPM_READ_FAIL_SECOND:"1"}]] as const){const f=workflowFixture(t,intent),r=runWorkflowBlock(f,script,{NODE_AUTH_TOKEN:"fixture-stage-token",...flags});assert.notEqual(r.status,0,name);assert.match(r.stderr,name==="write"?/UNKNOWN npm failure/:/PRIVATE REGISTRY RESPONSE/);assert.equal((readFileSync(f.effectLog,"utf8").match(/npm\tdist-tag add/g)??[]).length,1);assert.equal(JSON.parse(readFileSync(join(f.root,"state.json"),"utf8")).status,"promotion-unknown");assert.throws(()=>readFileSync(join(f.root,"runner/promotion.json"),"utf8"),/ENOENT/);}});

test("production install effect writes durable failure evidence and permits a later success",t=>{const pub=published(),root=mkdtempSync(join(tmpdir(),"slate-install-failure-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const failureOut=join(root,"failure.json");assert.throws(()=>executeInstall({state:pub,expected:owner(pub),runId:"17",runAttempt:"2",workspace:root,out:join(root,"proof.json"),failureOut,exec:()=>{throw new Error("offline install failed");}}));const failure=JSON.parse(readFileSync(failureOut,"utf8"));assert.deepEqual({execution:failure.execution,result:failure.result,failure:failure.failure},{execution:"17:2",result:"failed",failure:"install-command"});const recorded=recordInstallFailure(pub,failure,owner(pub),NOW);let n=0;const proof=executeInstall({state:recorded,expected:owner(recorded),runId:"17",runAttempt:"3",workspace:root,out:join(root,"proof.json"),failureOut:join(root,"later-failure.json"),exec:()=>++n===2?{stdout:'{"type":"response","command":"get_commands","data":{"commands":[{"name":"slate","sourceInfo":{"source":"npm:ytdb-slate@0.10.1"}}]}}\n'}:{stdout:""}});const success=recordInstallProof(recorded,proof,owner(recorded),NOW);assert.equal(success.status,"proved");assert.equal(success.installFailures.length,1);assert.equal(success.installProof.execution,"17:3");});

test("production workflow carries immutable identity through every stage and confines the secret",()=>{const job=(name:string)=>workflow.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z-]*:\\n|$)`))?.[0]??"";for(const name of["seal-upload","upload","record-registry","install-proof","record-install-failure","record-proof","promote","record-promotion","finalize"])assert.match(job(name),/--identity/);assert.match(job("registry-proof"),/expected=\{identity:/);for(const name of["recover","recover-promote","recover-promotion-record","abandon","retire","close"])assert.match(job(name),/IDENTITY|--identity/);assert.match(job("prepare"),/--authorization "\$GITHUB_RUN_ID"/);assert.match(job("prepare"),/old_identity.*identity.*status.*!= prepared/);assert.match(job("record-install-failure"),/if: always\(\) && needs\.install-proof\.result == 'failure'/);assert.equal(workflow.split("\n").filter(x=>x.includes("NPM_STAGE_ONLY_TOKEN")).length,2);assert.match(job("upload"),/environment: npm-release[\s\S]*id-token: write/);assert.doesNotMatch(job("promote"),/npm (ci|install|test|pack)/);for(const text of[releasing,agents,mechanism]){assert.match(text,/install-failure-<attempt>/);assert.match(text,/install-failures\//);assert.match(text,/record-install-failure/);}for(const text of [releasing,agents,mechanism]){assert.match(text,/started before pull request #439 merged/);assert.doesNotMatch(text,/started before this fix/);}assert.match(releasing,/Do not rerun only `record-install-failure`/);assert.match(releasing,/If installation fails again, the failure recorder uses the same new run attempt\./);assert.match(releasing,/If installation succeeds, the failure recorder is skipped\./);assert.match(releasing,/The release can continue only after the required proofs succeed\./);assert.match(releasing,/dependent jobs can promote `latest` and create final records/);});

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
